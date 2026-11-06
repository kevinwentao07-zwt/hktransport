import Combine
import CoreLocation
import Foundation

/// Where the rider is along a journey.
struct JourneyProgress: Equatable, Sendable {
    /// Index into `JourneyMapPath.edges`; progress never moves backwards.
    let edge: Int
    let segment: Int
    /// Position in the segment's `stopIDs` of the next stop, on rides.
    let nextStop: Int?
    let metersFromRoute: Double
    let isOffRoute: Bool
    let hasArrived: Bool
}

extension JourneyMapPath {
    struct Edge: Equatable, Sendable {
        let segment: Int
        /// The edge ends at this position in the segment's `points`.
        let toPoint: Int
        let from: StopLocation
        let to: StopLocation
    }

    /// Being this close to a stop counts as having reached it.
    private static let stopRadius = 40.0
    private static let arrivalRadius = 50.0
    private static let offRouteRadius = 200.0

    var edges: [Edge] {
        segments.enumerated().flatMap { index, segment in
            zip(segment.points, segment.points.dropFirst()).enumerated().map { offset, pair in
                Edge(segment: index, toPoint: offset + 1, from: pair.0, to: pair.1)
            }
        }
    }

    /// `accuracy` widens the tolerances: Mac positions come from Wi-Fi and can be
    /// well over 100 m out. `previous` stops a noisy fix from undoing progress.
    func progress(at here: StopLocation, accuracy: Double = 0, after previous: JourneyProgress? = nil) -> JourneyProgress? {
        let edges = edges
        let first = previous?.edge ?? 0
        guard edges.indices.contains(first) else { return nil }
        var best = first
        var bestMeters = Double.infinity
        for index in first..<edges.count {
            let meters = Self.meters(from: here, toEdge: edges[index])
            if meters < bestMeters {
                best = index
                bestMeters = meters
            }
        }
        let hasArrived = Geo.meters(here, destination) <= max(Self.arrivalRadius, min(accuracy, 100))
        let isOffRoute = !hasArrived && bestMeters > max(Self.offRouteRadius, accuracy)
        // Off the route the nearest edge means nothing, so stay where we were.
        let edge = edges[isOffRoute ? first : best]
        var nextStop: Int?
        if !segments[edge.segment].stopIDs.isEmpty {
            let isAtStop = Geo.meters(here, edge.to) <= Self.stopRadius
            nextStop = min(edge.toPoint + (isAtStop ? 1 : 0), segments[edge.segment].stopIDs.count - 1)
        }
        return JourneyProgress(edge: isOffRoute ? first : best, segment: edge.segment, nextStop: nextStop,
                               metersFromRoute: bestMeters, isOffRoute: isOffRoute, hasArrived: hasArrived)
    }

    private static func meters(from here: StopLocation, toEdge edge: Edge) -> Double {
        let scale = cos(here.lat * .pi / 180)
        let x = (edge.to.lng - edge.from.lng) * scale, y = edge.to.lat - edge.from.lat
        let px = (here.lng - edge.from.lng) * scale, py = here.lat - edge.from.lat
        let length = x * x + y * y
        let t = length > 0 ? min(1, max(0, (px * x + py * y) / length)) : 0
        let nearest = StopLocation(lat: edge.from.lat + t * y, lng: edge.from.lng + t * (edge.to.lng - edge.from.lng))
        return Geo.meters(here, nearest)
    }

    /// One line telling the rider what to do now.
    func instruction(for progress: JourneyProgress, language: Lang, stopName: (String) -> String) -> String {
        func t(_ zh: String, _ en: String) -> String { language.pick(zh, en) }
        if progress.hasArrived { return t("已到達目的地", "You have arrived") }
        if progress.isOffRoute {
            let meters = Int(progress.metersFromRoute.rounded())
            return t("你目前不在路線上（相距約 \(meters) 米）", "You're off the route (about \(meters) m away)")
        }
        let segment = segments[progress.segment]
        guard case .ride(let route, let op) = segment.mode, let next = progress.nextStop else {
            let target = segments.dropFirst(progress.segment + 1).first?.stopIDs.first.map(stopName)
                ?? t("目的地", "your destination")
            return t("步行前往 \(target)", "Walk to \(target)")
        }
        let stop = stopName(segment.stopIDs[next])
        let left = segment.stopIDs.count - next
        guard left > 1, let alight = segment.stopIDs.last.map(stopName) else {
            return t("下一站 \(stop) 下車", "Get off at the next stop, \(stop)")
        }
        let line = op.lineName(route).text(language)
        return t("\(line) · 下一站 \(stop) · 還有 \(left) 站到 \(alight) 下車",
                 "\(line) · Next: \(stop) · \(left) stops to \(alight)")
    }
}

/// The journey being followed. Lives outside the panel so it carries on while
/// the notch is closed, and it only keeps the location on until arrival or stop.
@MainActor
final class NavigationTracker: ObservableObject {
    static let shared = NavigationTracker(location: .shared)

    @Published private(set) var journeyID: String?
    @Published private(set) var path: JourneyMapPath?
    @Published private(set) var progress: JourneyProgress?
    @Published private(set) var fix: CLLocation?

    private let location: BusLocationModel
    private var subscription: AnyCancellable?

    init(location: BusLocationModel) {
        self.location = location
        subscription = location.$trackedLocation.compactMap { $0 }.sink { [weak self] fix in
            MainActor.assumeIsolated { self?.update(fix) }
        }
    }

    func start(journeyID: String, path: JourneyMapPath) {
        self.journeyID = journeyID
        self.path = path
        progress = nil
        fix = nil
        location.startTracking()
    }

    func stop() {
        location.stopTracking()
        journeyID = nil
        path = nil
        progress = nil
        fix = nil
    }

    private func update(_ fix: CLLocation) {
        guard let path, progress?.hasArrived != true else { return }
        self.fix = fix
        let here = StopLocation(lat: fix.coordinate.latitude, lng: fix.coordinate.longitude)
        progress = path.progress(at: here, accuracy: fix.horizontalAccuracy, after: progress)
        if progress?.hasArrived == true { location.stopTracking() }
    }
}
