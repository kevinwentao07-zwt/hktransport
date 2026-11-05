import CoreLocation
import Foundation
import MapKit

struct ResolvedPlace: Equatable, Sendable {
    let name: String
    let location: StopLocation
}

/// Turns a place name into coordinates: MTR station names first (exact and
/// offline), then Apple Maps, then any stop whose name contains the text.
enum PlaceResolver {
    static func isInHongKong(_ location: StopLocation) -> Bool {
        (22.13...22.58).contains(location.lat) && (113.82...114.45).contains(location.lng)
    }

    /// The first Apple Maps result inside Hong Kong.
    static func appleMaps(_ text: String) async -> ResolvedPlace? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = text
        request.resultTypes = [.pointOfInterest, .address]
        request.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 22.35, longitude: 114.13),
            span: MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 0.6)
        )
        guard let response = try? await MKLocalSearch(request: request).start() else { return nil }
        for item in response.mapItems {
            let coordinate = item.placemark.coordinate
            let location = StopLocation(lat: coordinate.latitude, lng: coordinate.longitude)
            if isInHongKong(location) {
                return ResolvedPlace(name: item.name ?? text, location: location)
            }
        }
        return nil
    }

    @MainActor
    static func resolve(_ query: String, db: TransportDB, network: TransitNetwork,
                        language: Lang) async -> ResolvedPlace? {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }

        if let station = station(named: text, db: db, network: network, language: language) {
            return station
        }

        if let place = await appleMaps(text) {
            // Apple Maps answers in the system language, not the app's.
            return language == .zh ? ResolvedPlace(name: text, location: place.location) : place
        }

        return stop(containing: text, db: db, network: network, language: language)
    }

    /// "旺角", "旺角站", "Mong Kok", "Mong Kok Station" -> MOK.
    static func station(named text: String, db: TransportDB, network: TransitNetwork,
                        language: Lang) -> ResolvedPlace? {
        let wanted = normalize(text)
        for (index, id) in network.stopIDs.enumerated() where network.isStation[index] {
            guard let name = db.stopList[id]?.name else { continue }
            if normalize(name.zh) == wanted || normalize(name.en) == wanted {
                return ResolvedPlace(name: name.text(language), location: network.locations[index])
            }
        }
        return nil
    }

    static func stop(containing text: String, db: TransportDB, network: TransitNetwork,
                     language: Lang) -> ResolvedPlace? {
        let wanted = text.lowercased()
        guard wanted.count >= 2 else { return nil }
        for (index, id) in network.stopIDs.enumerated() {
            guard let name = db.stopList[id]?.name,
                  name.zh.contains(text) || name.en.lowercased().contains(wanted) else { continue }
            return ResolvedPlace(name: RoutePlannerModel.cleanStopName(name.text(language)),
                                 location: network.locations[index])
        }
        return nil
    }

    static func normalize(_ text: String) -> String {
        var value = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        for suffix in ["港鐵站", "站", " station", " mtr"] where value.hasSuffix(suffix) && value.count > suffix.count {
            value.removeLast(suffix.count)
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Live ETA lookups shared by all candidate journeys of one plan, so a stop
/// that appears in several options is only requested once.
actor LiveArrivalCache {
    private var tasks: [String: Task<[LiveDeparture]?, Never>] = [:]
    private let db: TransportDB
    private let language: Lang

    init(db: TransportDB, language: Lang) {
        self.db = db
        self.language = language
    }

    func arrivals(for ride: PlannedRide) async -> [LiveDeparture]? {
        let key = "\(ride.routeKey)|\(ride.op.rawValue)|\(ride.boardPosition)|\(ride.alightPosition)"
        if let task = tasks[key] { return await task.value }
        let db = self.db, language = self.language
        let task = Task<[LiveDeparture]?, Never> { await Self.fetch(ride, db: db, language: language) }
        tasks[key] = task
        return await task.value
    }

    /// False for a train that ends before the rider's stop or takes the other
    /// branch, e.g. a Tai Po Market short working for someone going to Sheung Shui.
    static func train(to terminus: Name, serves ride: PlannedRide, db: TransportDB) -> Bool {
        guard ride.op == .mtr else { return true }
        var isKnown = false
        for route in db.routeList.values where route.route == ride.route {
            guard let ids = route.stops[ride.op.rawValue],
                  let end = ids.firstIndex(where: { db.stopList[$0]?.name == terminus }) else { continue }
            isKnown = true
            if let board = ids.firstIndex(of: ride.boardStopID), let alight = ids.firstIndex(of: ride.alightStopID),
               board < alight, alight <= end {
                return true
            }
        }
        // A terminus the database has never heard of is no reason to drop a train.
        return !isKnown
    }

    private static func fetch(_ ride: PlannedRide, db: TransportDB, language: Lang) async -> [LiveDeparture]? {
        // Joint routes number stops per operator, so ask the operator we planned with.
        guard let full = db.routeList[ride.routeKey], let ids = full.stops[ride.op.rawValue] else { return nil }
        let route = Route(route: full.route, co: [ride.op.rawValue], orig: full.orig, dest: full.dest,
                          serviceType: full.serviceType, stops: [ride.op.rawValue: ids],
                          bound: [ride.op.rawValue: full.bound[ride.op.rawValue] ?? ""],
                          gtfsId: full.gtfsId, nlbId: full.nlbId)
        guard let etas = try? await ETAService.fetch(route: route, seq: ride.boardPosition,
                                                     stopList: db.stopList, language: language) else { return nil }
        let departures = etas.compactMap { eta -> LiveDeparture? in
            guard let date = eta.date, train(to: eta.dest, serves: ride, db: db) else { return nil }
            return LiveDeparture(date: date, platform: ride.op == .mtr ? eta.remark : nil)
        }
        return departures.isEmpty ? nil : departures
    }
}

@MainActor
final class RoutePlannerModel: ObservableObject {
    /// Shared because the panel is rebuilt every time the notch opens.
    static let shared = RoutePlannerModel()

    /// Asked only when a trip actually starts or ends at the current location.
    typealias LocationSource = @MainActor () async -> CLLocation?

    enum Phase: Equatable {
        case idle, understanding, findingPlaces, locating, planning, checkingLive, done
        case failed(String)
    }

    /// Empty means "start from my current location".
    @Published var originText = ""
    @Published var destinationText = ""
    @Published var chatText = ""
    /// The rider's last message in the AI box.
    @Published private(set) var lastChat: String?
    /// Set while the AI box is helping to find somewhere to go.
    @Published private(set) var discovery: DiscoveryStage?
    /// Replaced in tests; real searches go to Apple Maps.
    var placeSearch: PlaceDiscovery.Searcher = { await PlaceDiscovery.appleMaps(term: $0, center: $1, radius: $2) }
    var districtLookup: PlaceDiscovery.DistrictLookup = { await PlaceDiscovery.district(of: $0, language: $1) }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var origin: ResolvedPlace?
    @Published private(set) var destination: ResolvedPlace?
    @Published private(set) var preference: TripPreference = .fastest
    @Published private(set) var journeys: [Journey] = []
    @Published private(set) var explanation: String?
    @Published private(set) var isExplaining = false
    /// Set when the AI was configured but could not be used for this plan.
    @Published private(set) var aiNotice: String?
    @Published private(set) var usedAI = false

    private var network: TransitNetwork?
    private var buildingNetwork: (id: UUID, task: Task<TransitNetwork, Never>)?
    private var planTask: Task<Void, Never>?

    var hasInput: Bool {
        !originText.isEmpty || !destinationText.isEmpty || !chatText.isEmpty || !journeys.isEmpty
    }

    var isBusy: Bool {
        switch phase {
        case .understanding, .findingPlaces, .locating, .planning, .checkingLive: return true
        default: return false
        }
    }

    /// Builds the routing network in the background before the first search.
    func prepare(db: TransportDB) {
        Task { _ = await routingNetwork(for: db) }
    }

    func reset() {
        planTask?.cancel()
        originText = ""
        destinationText = ""
        chatText = ""
        lastChat = nil
        discovery = nil
        phase = .idle
        origin = nil
        destination = nil
        journeys = []
        explanation = nil
        aiNotice = nil
    }

    /// Re-sorts the current options without searching again.
    func setPreference(_ preference: TripPreference) {
        self.preference = preference
        journeys.sort { preference.score($0) < preference.score($1) }
    }

    /// Swaps the ends like a navigation app; an empty start is the current location.
    func swapEnds(language: Lang) {
        let start = originText.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = destinationText.trimmingCharacters(in: .whitespacesAndNewlines)
        originText = TripIntentParser.isCurrentLocation(end) ? "" : end
        destinationText = start.isEmpty ? (language == .zh ? "我的位置" : "My location") : start
    }

    /// Plans what the top search bar says.
    func search(db: TransportDB, language: Lang, currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        let start = originText.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = destinationText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !end.isEmpty else { return }
        let origin = TripIntentParser.normalizedOrigin(start)
        discovery = nil
        begin(.search(origin: origin, destination: end, preference: preference),
              db: db, language: language, currentLocation: currentLocation, ai: ai)
    }

    /// Sends the AI box. The answer also fills in the search bar.
    func sendChat(db: TransportDB, language: Lang, currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        let text = chatText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if case .asking(let request) = discovery {
            // Typed or spoken, this is the answer to "where should I look?".
            chatText = ""
            lastChat = text
            findPlaces(request, area: text, isTyped: true, db: db, language: language,
                       currentLocation: currentLocation, ai: ai)
            return
        }
        discovery = nil
        let end = destinationText.trimmingCharacters(in: .whitespacesAndNewlines)
        let current = end.isEmpty ? nil : TripIntent(origin: TripIntentParser.normalizedOrigin(originText),
                                                     destination: end, preference: preference)
        chatText = ""
        lastChat = text
        begin(.chat(text, current: current), db: db, language: language, currentLocation: currentLocation, ai: ai)
    }

    /// The rider pressed one of the area buttons.
    func chooseArea(_ area: String, db: TransportDB, language: Lang, currentLocation: @escaping LocationSource,
                    ai: DeepSeekClient?) {
        guard case .asking(let request) = discovery else { return }
        findPlaces(request, area: area, isTyped: false, db: db, language: language,
                   currentLocation: currentLocation, ai: ai)
    }

    /// Plans a route to a recommended place, keeping the list to come back to.
    func choosePlace(_ suggestion: PlaceSuggestion, db: TransportDB, language: Lang,
                     currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        destinationText = suggestion.place.name
        let place = ResolvedPlace(name: suggestion.place.name, location: suggestion.place.location)
        begin(.place(place, origin: TripIntentParser.normalizedOrigin(originText), preference: preference),
              db: db, language: language, currentLocation: currentLocation, ai: ai)
    }

    /// Plans a route to a known place, such as a stop from the stop search.
    func route(to place: ResolvedPlace, db: TransportDB, language: Lang,
               currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        discovery = nil
        originText = ""
        destinationText = place.name
        begin(.place(place, origin: nil, preference: preference),
              db: db, language: language, currentLocation: currentLocation, ai: ai)
    }

    /// The recommendations to show, once no route is on screen.
    var visibleSuggestions: [PlaceSuggestion]? {
        guard case .choosing(_, _, let suggestions) = discovery, journeys.isEmpty, !isRouting else { return nil }
        return suggestions
    }

    private var isRouting: Bool {
        switch phase {
        case .locating, .planning, .checkingLive: return true
        default: return false
        }
    }

    func backToSuggestions() {
        planTask?.cancel()
        journeys = []
        origin = nil
        destination = nil
        explanation = nil
        destinationText = ""
        phase = .idle
    }

    func askAreaAgain() {
        guard case .choosing(var request, _, _) = discovery else { return }
        request.area = nil
        discovery = .asking(request)
    }

    func cancelDiscovery() {
        planTask?.cancel()
        discovery = nil
        phase = .idle
    }

    private func findPlaces(_ request: DiscoveryRequest, area: String, isTyped: Bool, db: TransportDB, language: Lang,
                            currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        planTask?.cancel()
        explanation = nil
        journeys = []
        origin = nil
        destination = nil
        phase = .findingPlaces
        planTask = Task { [weak self] in
            await self?.discover(request, area: area, isTyped: isTyped, db: db, language: language,
                                 currentLocation: currentLocation, ai: ai)
        }
    }

    private func discover(_ request: DiscoveryRequest, area: String, isTyped: Bool, db: TransportDB, language: Lang,
                          currentLocation: @escaping LocationSource, ai: DeepSeekClient?) async {
        func t(_ zh: String, _ en: String) -> String { language == .zh ? zh : en }
        func giveUp(_ message: String) {
            discovery = .asking(request)
            phase = .failed(message)
        }
        phase = .findingPlaces

        // 1. Where to look.
        var place = PlaceDiscovery.cleanArea(area)
        var extra: String?
        if isTyped, let ai, let parsed = try? await ai.parseArea(area, want: request.want) {
            place = parsed.area
            extra = parsed.extra
        }
        guard !Task.isCancelled else { return }
        let searchArea: SearchArea
        if PlaceDiscovery.isNearby(place) {
            guard let fix = await currentLocation() else {
                giveUp(t("未能取得你的位置，請選擇一個地區或輸入範圍。", "Couldn't get your location. Pick a district or type an area."))
                return
            }
            // "Nearby" means the rider's own district, not a circle around them.
            let center = StopLocation(lat: fix.coordinate.latitude, lng: fix.coordinate.longitude)
            if let district = await districtLookup(center, language) {
                searchArea = SearchArea(name: district.name, center: center, radius: PlaceDiscovery.districtRadius,
                                        district: district.match)
            } else {
                searchArea = SearchArea(name: t("附近", "Nearby"), center: center)
            }
        } else {
            let network = await routingNetwork(for: db)
            guard let resolved = await PlaceResolver.resolve(place, db: db, network: network, language: language) else {
                giveUp(t("找不到「\(place)」，請換一個範圍。", "Couldn't find \"\(place)\". Try another area."))
                return
            }
            searchArea = SearchArea(name: resolved.name, center: resolved.location)
        }
        guard !Task.isCancelled else { return }

        // 2. The AI names shops, and Apple Maps confirms each one is really there.
        var suggestions: [PlaceSuggestion] = []
        if let ai {
            do {
                let named = try await ai.suggestPlaces(want: request.want, area: searchArea.name, extra: extra, language: language)
                guard !Task.isCancelled else { return }
                suggestions = await PlaceDiscovery.verify(named, in: searchArea, search: placeSearch)
            } catch {
                aiNotice = t("AI 暫時未能使用，已改用地圖搜尋：", "AI unavailable, searched the map instead: ") + error.localizedDescription
            }
        }
        guard !Task.isCancelled else { return }

        // 3. Otherwise fall back to searching the map by shop type.
        if suggestions.isEmpty {
            var results: [[PlaceCandidate]] = []
            for term in request.searchTerms {
                results.append(await placeSearch(term, searchArea.center, searchArea.radius))
            }
            guard !Task.isCancelled else { return }
            let places = PlaceDiscovery.merge(results, in: searchArea)
            guard !places.isEmpty else {
                giveUp(t("\(searchArea.name)找不到\(request.want)，請換一個範圍。",
                         "Couldn't find \(request.want) around \(searchArea.name). Try another area."))
                return
            }
            if let ai, aiNotice == nil {
                suggestions = (try? await ai.recommend(places, want: request.want, extra: extra, language: language)) ?? []
            }
            guard !Task.isCancelled else { return }
            if suggestions.isEmpty { suggestions = PlaceDiscovery.nearest(places) }
        }
        discovery = .choosing(request, areaName: searchArea.name, suggestions: suggestions)
        phase = .idle
    }

    /// Asks where to look, unless the rider already said.
    private func startDiscovery(_ request: DiscoveryRequest, db: TransportDB, language: Lang,
                                currentLocation: @escaping LocationSource, ai: DeepSeekClient?) async {
        if let area = request.area {
            await discover(request, area: area, isTyped: false, db: db, language: language,
                           currentLocation: currentLocation, ai: ai)
        } else {
            discovery = .asking(request)
            phase = .idle
        }
    }

    private func begin(_ request: TripRequest, db: TransportDB, language: Lang,
                       currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        planTask?.cancel()
        journeys = []
        explanation = nil
        aiNotice = nil
        origin = nil
        destination = nil
        usedAI = false
        phase = .understanding
        planTask = Task { [weak self] in
            await self?.run(request, db: db, language: language, currentLocation: currentLocation, ai: ai)
        }
    }

    private func run(_ request: TripRequest, db: TransportDB, language: Lang,
                     currentLocation: @escaping LocationSource, ai: DeepSeekClient?) async {
        func t(_ zh: String, _ en: String) -> String { language == .zh ? zh : en }

        // 1. Understand the request.
        phase = .understanding
        var intent: TripIntent?
        var isPicked = false
        if case .place = request { isPicked = true }
        if let ai, !isPicked {
            do {
                if case .chat = request {
                    switch try await ai.parseChat(request) {
                    case .trip(let trip):
                        intent = trip
                    case .discover(let wish):
                        guard !Task.isCancelled else { return }
                        await startDiscovery(wish, db: db, language: language, currentLocation: currentLocation, ai: ai)
                        return
                    }
                } else {
                    intent = try await ai.parseIntent(request)
                }
                usedAI = true
            } catch {
                aiNotice = t("AI 暫時未能使用，已改用基本解析：", "AI unavailable, used basic parsing: ")
                    + error.localizedDescription
            }
        }
        guard !Task.isCancelled else { return }
        if intent == nil, case .chat(let text, _) = request, let wish = TripIntentParser.discovery(text) {
            await startDiscovery(wish, db: db, language: language, currentLocation: currentLocation, ai: ai)
            return
        }
        if intent == nil { intent = request.offlineIntent }
        guard var intent else {
            phase = .failed(t("請輸入目的地，例如「由旺角去理大」。", "Enter a destination, e.g. \"Mong Kok to PolyU\"."))
            return
        }
        if case .search(let origin, _, _) = request, origin == nil {
            // An empty start box always means here, whatever the AI inferred.
            intent.origin = nil
        }
        if case .chat = request {
            originText = intent.origin ?? ""
            destinationText = intent.destination
        }
        preference = intent.preference

        // 2. Locate both ends.
        phase = .locating
        let network = await routingNetwork(for: db)
        guard !Task.isCancelled else { return }
        func here() async -> ResolvedPlace? {
            guard let fix = await currentLocation() else { return nil }
            return ResolvedPlace(name: t("我的位置", "My location"),
                                 location: StopLocation(lat: fix.coordinate.latitude, lng: fix.coordinate.longitude))
        }
        let noLocation = t("未能取得你的位置：請允許定位，或在上方輸入起點。",
                           "Couldn't get your location: allow Location access, or type a start above.")
        let start: ResolvedPlace
        if let name = intent.origin {
            guard let place = await PlaceResolver.resolve(name, db: db, network: network, language: language) else {
                phase = .failed(t("找不到起點「\(name)」。", "Couldn't find the start \"\(name)\"."))
                return
            }
            start = place
        } else if let place = await here() {
            start = place
        } else {
            phase = .failed(noLocation)
            return
        }
        guard !Task.isCancelled else { return }
        let end: ResolvedPlace
        if case .place(let picked, _, _) = request {
            end = picked
        } else if TripIntentParser.isCurrentLocation(intent.destination) {
            guard let place = await here() else {
                phase = .failed(noLocation)
                return
            }
            end = place
        } else if let place = await PlaceResolver.resolve(intent.destination, db: db, network: network, language: language) {
            end = place
        } else {
            phase = .failed(t("找不到目的地「\(intent.destination)」。", "Couldn't find \"\(intent.destination)\"."))
            return
        }
        guard !Task.isCancelled else { return }
        origin = start
        destination = end
        guard PlaceResolver.isInHongKong(start.location) else {
            phase = .failed(t("起點不在香港範圍內。", "The start is outside Hong Kong."))
            return
        }

        // 3. Search the network (off the main thread).
        phase = .planning
        let departure = Date()
        let preference = intent.preference
        let found = await Task.detached(priority: .userInitiated) {
            RoutePlanner(network: network).plan(from: start.location, to: end.location,
                                                departure: departure, preference: preference)
        }.value
        guard !Task.isCancelled else { return }
        guard !found.isEmpty else {
            phase = .failed(t("找不到公共交通路線，可能已經收車，或距離太近／太遠。",
                              "No public transport route found. Services may have ended, or the trip is too short or too far."))
            return
        }
        journeys = found

        // 4. Replace timetable waits with live ETAs where available.
        phase = .checkingLive
        let cache = LiveArrivalCache(db: db, language: language)
        let retimed = await withTaskGroup(of: (Int, Journey).self, returning: [Journey].self) { group in
            for (index, journey) in found.enumerated() {
                group.addTask {
                    let live = await LiveRetimer.retime(journey) { ride in await cache.arrivals(for: ride) }
                    return (index, live)
                }
            }
            var results = found
            for await (index, journey) in group { results[index] = journey }
            return results
        }
        guard !Task.isCancelled else { return }
        journeys = retimed.sorted { self.preference.score($0) < self.preference.score($1) }
        phase = .done

        // 5. Optional one-line recommendation.
        guard let ai, aiNotice == nil else { return }
        isExplaining = true
        defer { isExplaining = false }
        let summary = DeepSeekClient.summary(of: Array(journeys.prefix(3)), preference: self.preference, now: Date(),
                                             language: language) {
            Self.stopName($0, db: db, language: language)
        }
        let reply = try? await ai.explain(summary, language: language)
        guard !Task.isCancelled else { return }
        explanation = reply
    }

    private func routingNetwork(for db: TransportDB) async -> TransitNetwork {
        let id = db.busStopIndex.id
        if let network, network.sourceID == id { return network }
        if let building = buildingNetwork, building.id == id { return await building.task.value }
        let task = Task.detached(priority: .userInitiated) { TransitNetwork.build(from: db) }
        buildingNetwork = (id, task)
        let built = await task.value
        network = built
        buildingNetwork = nil
        return built
    }

    // MARK: - Text

    static func stopName(_ id: String, db: TransportDB?, language: Lang) -> String {
        guard let name = db?.stopList[id]?.name.text(language), !name.isEmpty else { return id }
        return cleanStopName(name)
    }

    /// Drops operator stop codes such as "(YT611)".
    nonisolated static func cleanStopName(_ name: String) -> String {
        name.replacingOccurrences(of: #"\s*[(（][A-Za-z]{1,5}[0-9]{1,6}[A-Za-z0-9-]*[)）]\s*$"#,
                                  with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
