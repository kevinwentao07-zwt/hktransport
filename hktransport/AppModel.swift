import AppKit
import ServiceManagement
import SwiftUI

enum ArrivalRefreshInterval: Int, CaseIterable {
    case oneSecond = 1
    case fifteenSeconds = 15
    case thirtySeconds = 30
    case sixtySeconds = 60
}

@MainActor
final class AppModel: ObservableObject {
    private enum Key {
        static let savedStops = "hktransport.savedStops"
        static let language = "hktransport.language"
        static let refreshInterval = "hktransport.refreshInterval"
    }

    private let defaults: UserDefaults
    @Published private(set) var panelState = PanelState()
    @Published private(set) var isShowingSettings = false
    @Published private(set) var loginItemStatus = SMAppService.mainApp.status
    @Published private(set) var loginItemError: String?
    @Published var menuBarHeight = NotchLayout.minimumMenuBarHeight
    @Published var notchWidth: CGFloat = 186
    @Published private(set) var db: TransportDB?
    @Published private(set) var dbError: String?
    @Published private(set) var savedStops: [SavedStop]
    @Published private(set) var etas: [SavedStop: [ETA]] = [:]
    @Published private(set) var now = Date()
    @Published var refreshInterval: ArrivalRefreshInterval {
        didSet { defaults.set(refreshInterval.rawValue, forKey: Key.refreshInterval) }
    }
    @Published var language: Lang {
        didSet {
            defaults.set(language.rawValue, forKey: Key.language)
            // NLB returns destination text in the requested language only.
            Task { await fetchETAs() }
        }
    }

    private var hoverCollapseTask: Task<Void, Never>?
    private var panelCloseTask: Task<Void, Never>?
    private var tickTask: Task<Void, Never>?
    private var lastETAFetch = Date.distantPast
    private var lastDBCheck = Date.distantPast

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        language = Lang(rawValue: defaults.string(forKey: Key.language) ?? "") ?? .zh
        refreshInterval = ArrivalRefreshInterval(rawValue: defaults.integer(forKey: Key.refreshInterval)) ?? .thirtySeconds
        savedStops = defaults.data(forKey: Key.savedStops)
            .flatMap { try? JSONDecoder().decode([SavedStop].self, from: $0) } ?? []
    }

    // MARK: - Lifecycle

    func start() {
        tickTask?.cancel()
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                let nextTick = ContinuousClock.now.advanced(by: .seconds(1))
                await self?.tick()
                // Count request time toward the interval and keep refreshes sequential.
                try? await Task.sleep(until: nextTick, clock: .continuous)
            }
        }
    }

    func stop() {
        tickTask?.cancel()
        hoverCollapseTask?.cancel()
        panelCloseTask?.cancel()
    }

    private func tick() async {
        now = Date()
        // Retry a missing database every minute; otherwise check daily for a weekly refresh.
        if Date().timeIntervalSince(lastDBCheck) > (db == nil ? 60 : 86_400) {
            await loadDB()
        }
        if Date().timeIntervalSince(lastETAFetch) >= Double(refreshInterval.rawValue) {
            await fetchETAs()
        }
    }

    func loadDB() async {
        lastDBCheck = Date()
        dbError = nil
        if db == nil {
            db = await TransportDBStore.cached()
        }
        guard db == nil || TransportDBStore.isCacheStale else { return }
        do {
            db = try await TransportDBStore.download()
            await fetchETAs()
        } catch {
            if db == nil { dbError = error.localizedDescription }
        }
    }

    func fetchETAs() async {
        guard let db else { return }
        lastETAFetch = Date()
        let lang = self.language
        let stops = savedStops
        let fetched = await withTaskGroup(of: (SavedStop, [ETA]?).self) { group in
            for stop in stops {
                guard let route = db.routeList[stop.routeKey] else { continue }
                group.addTask {
                    let etas = try? await ETAService.fetch(
                        route: route,
                        seq: stop.seq,
                        stopList: db.stopList,
                        language: lang
                    )
                    return (stop, etas)
                }
            }
            var fetched: [SavedStop: [ETA]] = [:]
            for await (stop, etas) in group {
                // A failed request keeps the previous ETAs instead of blanking the row.
                if let etas { fetched[stop] = etas }
            }
            return fetched
        }
        etas.merge(fetched) { $1 }
        now = Date()
    }

    // MARK: - Saved stops

    func isSaved(_ stop: SavedStop) -> Bool {
        savedStops.contains(stop)
    }

    func toggleSaved(_ stop: SavedStop) {
        if let index = savedStops.firstIndex(of: stop) {
            savedStops.remove(at: index)
            etas[stop] = nil
        } else {
            savedStops.append(stop)
            Task { await fetchETAs() }
        }
        persistSavedStops()
    }

    func moveToTop(_ stop: SavedStop) {
        guard let index = savedStops.firstIndex(of: stop) else { return }
        savedStops.insert(savedStops.remove(at: index), at: 0)
        persistSavedStops()
    }

    private func persistSavedStops() {
        defaults.set(try? JSONEncoder().encode(savedStops), forKey: Key.savedStops)
    }

    // MARK: - Settings

    var launchAtLogin: Bool {
        loginItemStatus == .enabled || loginItemStatus == .requiresApproval
    }

    func refreshLoginItemStatus() {
        loginItemStatus = SMAppService.mainApp.status
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        loginItemError = nil
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            loginItemError = error.localizedDescription
        }
        refreshLoginItemStatus()
    }

    func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    func showSettings() {
        refreshLoginItemStatus()
        isShowingSettings = true
        sendPanelEvent(.workspaceOpened)
    }

    func hideSettings() {
        isShowingSettings = false
    }

    // MARK: - Lookups for views

    func t(_ zh: String, _ en: String) -> String {
        language == .zh ? zh : en
    }

    func route(for stop: SavedStop) -> Route? {
        db?.routeList[stop.routeKey]
    }

    func stopName(_ route: Route, seq: Int) -> String {
        let ids = route.stopIDs
        guard ids.indices.contains(seq) else { return "" }
        return db?.stopList[ids[seq]]?.name.text(language) ?? ids[seq]
    }

    func searchRoutes(_ query: String, category: TransportCategory = .saved) -> [String] {
        let prefix = query.trimmingCharacters(in: .whitespaces).uppercased()
        guard let db, !prefix.isEmpty else { return [] }
        return Array(
            db.sortedRouteKeys.lazy
                .filter { key in
                    guard let route = db.routeList[key], category.includes(route) else { return false }
                    return route.route.uppercased().hasPrefix(prefix)
                }
                .prefix(60)
        )
    }

    func mtrStop(station: String, line: String, up: Bool) -> SavedStop? {
        guard let db else { return nil }
        let candidates = db.sortedRouteKeys.compactMap { key -> SavedStop? in
            guard let route = db.routeList[key], route.operators.contains(.mtr), route.route == line,
                  route.bound["mtr"]?.hasSuffix(up ? "UT" : "DT") == true,
                  let seq = route.stopIDs.firstIndex(of: station),
                  seq < route.stopIDs.count - 1 else { return nil }
            return SavedStop(routeKey: key, seq: seq)
        }
        return candidates.first(where: isSaved) ?? candidates.first
    }

    func lightRailStop(station: String, routeNumber: String, destination: Name) -> SavedStop? {
        guard let db, let stationID = LightRailNetwork.normalizedCode(station) else { return nil }
        let candidates = db.sortedRouteKeys.compactMap { key -> SavedStop? in
            guard let route = db.routeList[key], route.operators.contains(.lightRail),
                  route.route == routeNumber,
                  route.dest.zh == destination.zh || route.dest.en == destination.en,
                  let seq = route.stopIDs.firstIndex(where: { LightRailNetwork.normalizedCode($0) == stationID }),
                  seq < route.stopIDs.count - 1 else { return nil }
            return SavedStop(routeKey: key, seq: seq)
        }
        return candidates.first(where: isSaved) ?? candidates.first
    }

    /// Drops arrivals that have already left since the last refresh.
    func upcoming(_ etas: [ETA]) -> [ETA] {
        etas.filter { ($0.date ?? .distantFuture) > now.addingTimeInterval(-30) }
    }

    func minutes(until eta: ETA) -> Int? {
        eta.date.map { max(0, Int($0.timeIntervalSince(now) / 60)) }
    }

    // MARK: - Panel

    var isExpanded: Bool { panelState.isExpanded }
    var isPanelClosing: Bool { panelState.isPanelClosing }
    var isHoveringNotch: Bool { panelState.isHoveringNotch }

    func toggleExpanded() {
        guard !isPanelClosing else { return }
        if isExpanded {
            collapseExpanded()
            return
        }
        isShowingSettings = false
        sendPanelEvent(.workspaceOpened)
        if Date().timeIntervalSince(lastETAFetch) > 10 {
            Task { await fetchETAs() }
        }
    }

    func collapseExpanded() {
        guard isExpanded, !isPanelClosing else { return }
        sendPanelEvent(.workspaceCloseRequested)
    }

    func setNotchHovered(_ hovered: Bool) {
        if hovered {
            withAnimation(motion(NotchDesign.Motion.hover)) {
                sendPanelEvent(.pointerEntered)
            }
        } else {
            sendPanelEvent(.pointerExited)
        }
    }

    func quitApplication() {
        NSApp.terminate(nil)
    }

    func motion(_ animation: Animation) -> Animation {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? .linear(duration: 0.01) : animation
    }

    private func sendPanelEvent(_ event: PanelEvent) {
        var nextState = panelState
        let effects = nextState.reduce(event)
        if nextState != panelState {
            panelState = nextState
        }
        performPanelEffects(effects)
    }

    private func performPanelEffects(_ effects: [PanelEffect]) {
        for effect in effects {
            switch effect {
            case .cancelHoverCollapse:
                hoverCollapseTask?.cancel()
                hoverCollapseTask = nil

            case .scheduleHoverCollapse(let revision, let delayMilliseconds):
                hoverCollapseTask?.cancel()
                hoverCollapseTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(delayMilliseconds))
                    guard !Task.isCancelled, let self else { return }
                    withAnimation(
                        self.motion(NotchDesign.Motion.hover),
                        completionCriteria: .logicallyComplete
                    ) {
                        self.sendPanelEvent(.hoverCollapseDelayElapsed(revision: revision))
                    } completion: { [weak self] in
                        self?.sendPanelEvent(.hoverCollapseAnimationCompleted(revision: revision))
                    }
                }

            case .cancelWorkspaceClose:
                panelCloseTask?.cancel()
                panelCloseTask = nil

            case .scheduleWorkspaceClose(let revision, let surfaceDelayMilliseconds, let canvasDelayMilliseconds):
                panelCloseTask?.cancel()
                panelCloseTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(surfaceDelayMilliseconds))
                    guard !Task.isCancelled, let self else { return }
                    withAnimation(self.motion(NotchDesign.Motion.panelClose)) {
                        self.sendPanelEvent(.workspaceSurfaceCloseDelayElapsed(revision: revision))
                    }
                    try? await Task.sleep(for: .milliseconds(canvasDelayMilliseconds))
                    guard !Task.isCancelled else { return }
                    self.sendPanelEvent(.workspaceCanvasCloseDelayElapsed(revision: revision))
                }
            }
        }
    }
}
