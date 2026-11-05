import Foundation

// MARK: - Tuning

/// All planner constants in one place, so the group can tune and justify them.
struct PlannerSettings: Sendable {
    var walkMetersPerMinute = 75.0
    /// Straight-line distance understates real streets, footbridges and crossings.
    var walkDetour = 1.3
    /// Interchange walks between ordinary stops.
    var footpathRadius = 250.0
    /// MTR coordinates are station centres; exits can be a few hundred metres away.
    var stationFootpathRadius = 450.0
    /// Walking to the first stop / from the last stop.
    var accessRadius = 700.0
    var fallbackAccessRadius = 1_500.0
    /// Offer a walk-only option below this distance.
    var walkOnlyRadius = 1_500.0
    /// Time added to every interchange (finding the stop, buffer).
    var transferMinutes = 2.0
    /// Changing MTR lines inside one station.
    var mtrInterchangeMinutes = 3.0
    var maxTransitLegs = 3
    /// Departures further away than this count as "not running now".
    var maxWaitMinutes = 90.0

    func walkMinutes(_ meters: Double) -> Double {
        meters * walkDetour / walkMetersPerMinute
    }
}

extension Operator {
    /// Average speed including stops, used only when `jt` is missing.
    var plannerSpeedKmh: Double {
        switch self {
        case .kmb, .ctb: return 17
        case .nlb, .gmb: return 20
        case .lightRail: return 18
        case .mtr: return 38
        }
    }

    var plannerDwellMinutes: Double {
        self == .mtr ? 0.5 : 0.4
    }

    /// Typical headway when a route has no timetable data.
    var defaultHeadwayMinutes: Double {
        switch self {
        case .kmb, .ctb: return 15
        case .nlb: return 20
        case .gmb: return 10
        case .lightRail: return 6
        case .mtr: return 4
        }
    }
}

enum Geo {
    /// Equirectangular distance in metres; accurate to well under 1% at Hong Kong scale.
    static func meters(_ a: StopLocation, _ b: StopLocation) -> Double {
        let lat1 = a.lat * .pi / 180, lat2 = b.lat * .pi / 180
        let x = (b.lng - a.lng) * .pi / 180 * cos((lat1 + lat2) / 2)
        let y = lat2 - lat1
        return 6_371_000 * (x * x + y * y).squareRoot()
    }
}

// MARK: - Network

/// One direction / service type of one route, as an ordered list of stops.
struct TransitPattern: Sendable {
    let routeKey: String
    let route: String
    let op: Operator
    let dest: Name
    /// Indices into `TransitNetwork.stopIDs`. Position `i` is also the stop
    /// sequence used by the operator's ETA API.
    let stops: [Int]
    /// Minutes from the first stop to each stop.
    let offsets: [Double]
    let frequency: RouteFrequency?

    /// Routes are banned by number, not by direction, when looking for alternatives.
    var routeID: String { "\(op.rawValue)|\(route)" }
}

struct PatternVisit: Sendable {
    let pattern: Int
    let position: Int
}

struct Footpath: Sendable {
    let to: Int
    let meters: Double
}

struct TransitNetwork: Sendable {
    /// Identifies the database the network was built from.
    let sourceID: UUID
    let stopIDs: [String]
    let stopIndex: [String: Int]
    let locations: [StopLocation]
    let isStation: [Bool]
    let patterns: [TransitPattern]
    let patternsAtStop: [[PatternVisit]]
    let footpaths: [[Footpath]]
    let serviceDayMap: [String: [String]]
    let holidays: Set<String>
    private let grid: SpatialGrid

    static func build(from db: TransportDB, settings: PlannerSettings = PlannerSettings()) -> TransitNetwork {
        var stopIDs: [String] = []
        var stopIndex: [String: Int] = [:]
        var locations: [StopLocation] = []
        var patterns: [TransitPattern] = []

        // Sorted keys keep stop and pattern numbering deterministic.
        for key in db.routeList.keys.sorted() {
            guard let route = db.routeList[key], let op = route.operators.first,
                  let ids = route.stops[op.rawValue], ids.count >= 2 else { continue }
            let stopLocations = ids.compactMap { id -> StopLocation? in
                guard let location = db.stopList[id]?.location, location.isValid else { return nil }
                return location
            }
            guard stopLocations.count == ids.count else { continue }

            var cumulative: [Double] = [0]
            for i in 1..<stopLocations.count {
                cumulative.append(cumulative[i - 1] + Geo.meters(stopLocations[i - 1], stopLocations[i]))
            }
            let total = cumulative[cumulative.count - 1]
            let offsets: [Double]
            if let jt = route.journeyMinutes, total > 0 {
                // Spread the published journey time over the route by distance.
                offsets = cumulative.map { jt * $0 / total }
            } else {
                offsets = cumulative.enumerated().map { index, meters in
                    meters / 1000 / op.plannerSpeedKmh * 60 + Double(index) * op.plannerDwellMinutes
                }
            }

            let indices = zip(ids, stopLocations).map { id, location -> Int in
                if let existing = stopIndex[id] { return existing }
                stopIndex[id] = stopIDs.count
                stopIDs.append(id)
                locations.append(location)
                return stopIDs.count - 1
            }
            patterns.append(TransitPattern(routeKey: key, route: route.route, op: op, dest: route.dest,
                                           stops: indices, offsets: offsets, frequency: route.frequency))
        }

        var patternsAtStop = [[PatternVisit]](repeating: [], count: stopIDs.count)
        var isStation = [Bool](repeating: false, count: stopIDs.count)
        for (p, pattern) in patterns.enumerated() {
            for (position, stop) in pattern.stops.enumerated() {
                if pattern.op == .mtr { isStation[stop] = true }
                // Nobody boards at the last stop.
                if position < pattern.stops.count - 1 {
                    patternsAtStop[stop].append(PatternVisit(pattern: p, position: position))
                }
            }
        }

        let grid = SpatialGrid(locations: locations)
        let searchRadius = max(settings.footpathRadius, settings.stationFootpathRadius)
        let footpaths = locations.indices.map { stop -> [Footpath] in
            grid.stops(near: locations[stop], radius: searchRadius, in: locations).compactMap { other, meters -> Footpath? in
                guard other != stop else { return nil }
                let limit = isStation[stop] || isStation[other] ? settings.stationFootpathRadius : settings.footpathRadius
                return meters <= limit ? Footpath(to: other, meters: meters) : nil
            }
        }

        return TransitNetwork(sourceID: db.busStopIndex.id, stopIDs: stopIDs, stopIndex: stopIndex,
                              locations: locations, isStation: isStation, patterns: patterns,
                              patternsAtStop: patternsAtStop, footpaths: footpaths,
                              serviceDayMap: db.serviceDayMap ?? [:], holidays: Set(db.holidays ?? []),
                              grid: grid)
    }

    func stops(near location: StopLocation, radius: Double) -> [(stop: Int, meters: Double)] {
        grid.stops(near: location, radius: radius, in: locations)
    }
}

/// Buckets stops into ~0.005° cells (about 550 m) for radius queries.
struct SpatialGrid: Sendable {
    private struct Cell: Hashable, Sendable {
        let x: Int
        let y: Int
    }

    private static let size = 0.005
    private var cells: [Cell: [Int]] = [:]

    init(locations: [StopLocation]) {
        for (index, location) in locations.enumerated() {
            cells[Self.cell(location), default: []].append(index)
        }
    }

    private static func cell(_ location: StopLocation) -> Cell {
        Cell(x: Int((location.lat / size).rounded(.down)), y: Int((location.lng / size).rounded(.down)))
    }

    func stops(near location: StopLocation, radius: Double, in locations: [StopLocation]) -> [(stop: Int, meters: Double)] {
        guard location.isValid, radius > 0 else { return [] }
        let center = Self.cell(location)
        let reach = Int((radius / 500).rounded(.up))
        var result: [(stop: Int, meters: Double)] = []
        for dx in -reach...reach {
            for dy in -reach...reach {
                for stop in cells[Cell(x: center.x + dx, y: center.y + dy)] ?? [] {
                    let meters = Geo.meters(location, locations[stop])
                    if meters <= radius { result.append((stop, meters)) }
                }
            }
        }
        return result.sorted { $0.meters == $1.meters ? $0.stop < $1.stop : $0.meters < $1.meters }
    }
}

// MARK: - Service times

/// The departure time expressed the way the timetable data is keyed.
struct ServiceClock: Sendable {
    /// 0 = Sunday ... 6 = Saturday; public holidays use 0.
    let weekday: Int
    let minuteOfDay: Double

    static let hongKong: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Hong_Kong") ?? .current
        return calendar
    }()

    init(date: Date, holidays: Set<String> = []) {
        let calendar = Self.hongKong
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second, .weekday], from: date)
        let key = String(format: "%04d%02d%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        weekday = holidays.contains(key) ? 0 : max(0, (parts.weekday ?? 1) - 1)
        minuteOfDay = Double(parts.hour ?? 0) * 60 + Double(parts.minute ?? 0) + Double(parts.second ?? 0) / 60
    }
}

/// Estimates how long a rider waits at a stop, from timetable bands.
/// Results are cached per pattern for the duration of one search.
final class WaitEstimator {
    private let network: TransitNetwork
    private let clock: ServiceClock
    private let settings: PlannerSettings
    private var bandCache: [Int: [RouteFrequency.Band]] = [:]

    init(network: TransitNetwork, clock: ServiceClock, settings: PlannerSettings) {
        self.network = network
        self.clock = clock
        self.settings = settings
    }

    /// Expected wait in minutes for someone reaching `position` at
    /// `minutesAfterDeparture`, or nil when the route is not running then.
    func wait(pattern p: Int, position: Int, at minutesAfterDeparture: Double) -> Double? {
        let pattern = network.patterns[p]
        guard pattern.frequency != nil else { return pattern.op.defaultHeadwayMinutes / 2 }
        let bands = todaysBands(p)
        // Timetables are keyed by departure from the first stop.
        var t = (clock.minuteOfDay + minutesAfterDeparture - pattern.offsets[position])
            .truncatingRemainder(dividingBy: 1440)
        if t < 0 { t += 1440 }
        return Self.wait(bands: bands, at: t, maxWait: settings.maxWaitMinutes)
    }

    static func wait(bands: [RouteFrequency.Band], at t: Double, maxWait: Double) -> Double? {
        var nextStart = Double.infinity
        for band in bands {
            if let headway = band.headwaySeconds, let end = band.end,
               covers(t, start: Double(band.start), end: Double(end)) {
                return Double(headway) / 60 / 2
            }
            var delta = Double(band.start) - t
            if delta < 0 { delta += 1440 }
            nextStart = min(nextStart, delta)
        }
        return nextStart <= maxWait ? nextStart : nil
    }

    static func covers(_ t: Double, start: Double, end: Double) -> Bool {
        let start = start.truncatingRemainder(dividingBy: 1440)
        let end = end.truncatingRemainder(dividingBy: 1440)
        // Bands such as 23:40 -> 01:00 cross midnight.
        return start <= end ? (t >= start && t < end) : (t >= start || t < end)
    }

    private func todaysBands(_ p: Int) -> [RouteFrequency.Band] {
        if let cached = bandCache[p] { return cached }
        let days = network.patterns[p].frequency?.days ?? [:]
        let bands = days.compactMap { day, bands -> [RouteFrequency.Band]? in
            // Unknown service-day ids are assumed to run.
            guard let flags = network.serviceDayMap[day] else { return bands }
            return flags.indices.contains(clock.weekday) && flags[clock.weekday] == "1" ? bands : nil
        }.flatMap { $0 }
        bandCache[p] = bands
        return bands
    }
}

// MARK: - Journeys

struct PlannedRide: Hashable, Sendable {
    let routeKey: String
    let route: String
    let op: Operator
    let dest: Name
    /// Positions in `route.stops[op]`; `boardPosition` is the ETA `seq`.
    let boardPosition: Int
    let alightPosition: Int
    let boardStopID: String
    let alightStopID: String
    /// Interchange time before reaching the platform.
    var transferMinutes: Double
    var waitMinutes: Double
    let rideMinutes: Double
    /// Set when the wait came from live data instead of an estimate.
    var liveDeparture: Date?
    /// The operators only publish the next few trains; true when this departure
    /// lies beyond them and was projected from the live headway.
    var isProjected = false
    var livePlatform: Name?

    var routeID: String { "\(op.rawValue)|\(route)" }
    var stopCount: Int { alightPosition - boardPosition }
}

enum JourneyLeg: Hashable, Sendable {
    /// `toStopID` is nil for the final walk to the destination.
    case walk(meters: Double, minutes: Double, toStopID: String?)
    case ride(PlannedRide)
}

struct Journey: Identifiable, Hashable, Sendable {
    var legs: [JourneyLeg]
    let departure: Date

    var id: String { signature }

    var rides: [PlannedRide] {
        legs.compactMap { leg -> PlannedRide? in
            if case .ride(let ride) = leg { return ride }
            return nil
        }
    }

    var totalMinutes: Double {
        legs.reduce(0) { total, leg in
            switch leg {
            case .walk(_, let minutes, _): return total + minutes
            case .ride(let ride): return total + ride.transferMinutes + ride.waitMinutes + ride.rideMinutes
            }
        }
    }

    var arrival: Date { departure.addingTimeInterval(totalMinutes * 60) }

    var walkingMeters: Double {
        legs.reduce(0) { total, leg in
            if case .walk(let meters, _, _) = leg { return total + meters }
            return total
        }
    }

    var walkingMinutes: Double {
        legs.reduce(0) { total, leg in
            if case .walk(_, let minutes, _) = leg { return total + minutes }
            return total
        }
    }

    var transfers: Int { max(0, rides.count - 1) }
    var liveRideCount: Int { rides.filter { $0.liveDeparture != nil }.count }

    var signature: String {
        let rides = rides.map { "\($0.routeID)@\($0.boardStopID)>\($0.alightStopID)" }
        return rides.isEmpty ? "walk" : rides.joined(separator: ",")
    }
}

enum TripPreference: String, CaseIterable, Sendable {
    case fastest, fewerTransfers, lessWalking

    /// Lower is better. Weights are in "minutes the rider would trade".
    func score(_ journey: Journey) -> Double {
        switch self {
        case .fastest:
            return journey.totalMinutes + Double(journey.transfers) * 2
        case .fewerTransfers:
            return journey.totalMinutes + Double(journey.transfers) * 12
        case .lessWalking:
            return journey.totalMinutes + journey.walkingMinutes * 1.5 + Double(journey.transfers) * 3
        }
    }
}

// MARK: - Search

/// Round-based public transit routing (RAPTOR, Delling et al. 2012) on a
/// frequency-based network: round k finds the fastest way to every stop
/// using exactly k vehicles. Waits are estimated from headways here and
/// replaced by live ETAs later in `LiveRetimer`.
struct RoutePlanner {
    let network: TransitNetwork
    var settings = PlannerSettings()

    /// Several searches, each banning the first route of earlier answers,
    /// so the rider sees genuinely different options (e.g. bus vs MTR).
    func plan(from origin: StopLocation, to destination: StopLocation, departure: Date,
              preference: TripPreference = .fastest, limit: Int = 5) -> [Journey] {
        var found: [Journey] = []
        var banned = Set<String>()
        for _ in 0..<4 {
            let journeys = search(from: origin, to: destination, departure: departure, bannedFirstRoutes: banned)
            guard !journeys.isEmpty else { break }
            found += journeys
            for journey in journeys {
                if let first = journey.rides.first { banned.insert(first.routeID) }
            }
        }
        let direct = Geo.meters(origin, destination)
        if direct <= settings.walkOnlyRadius {
            found.append(Journey(legs: [.walk(meters: direct, minutes: settings.walkMinutes(direct), toStopID: nil)],
                                 departure: departure))
        }
        return Self.rank(found, preference: preference, limit: limit)
    }

    static func rank(_ journeys: [Journey], preference: TripPreference, limit: Int) -> [Journey] {
        // One option per first vehicle: "EAL then walk" and "EAL then ISL" are
        // the same decision at the origin, so only the better one is shown.
        var seen = Set<String>()
        let unique = journeys
            .sorted { preference.score($0) < preference.score($1) }
            .filter { seen.insert($0.rides.first?.routeID ?? "walk").inserted }
        guard let best = unique.first.map(preference.score) else { return [] }
        // Drop options that are far worse than the best one.
        return Array(unique.filter { preference.score($0) <= best + 20 }.prefix(limit))
    }

    private struct RideStep {
        let pattern: Int
        let board: Int
        let alight: Int
        let transfer: Double
        let wait: Double
    }

    private struct WalkStep {
        let from: Int
        let meters: Double
    }

    /// The best journey for each number of vehicles (1...maxTransitLegs),
    /// keeping only those faster than every journey with fewer vehicles.
    func search(from origin: StopLocation, to destination: StopLocation, departure: Date,
                bannedFirstRoutes: Set<String> = []) -> [Journey] {
        var access = network.stops(near: origin, radius: settings.accessRadius)
        if access.isEmpty { access = network.stops(near: origin, radius: settings.fallbackAccessRadius) }
        var egressList = network.stops(near: destination, radius: settings.accessRadius)
        if egressList.isEmpty { egressList = network.stops(near: destination, radius: settings.fallbackAccessRadius) }
        guard !access.isEmpty, !egressList.isEmpty else { return [] }

        let n = network.stopIDs.count
        let rounds = max(1, settings.maxTransitLegs)
        let infinity = Double.infinity
        let estimator = WaitEstimator(network: network,
                                      clock: ServiceClock(date: departure, holidays: network.holidays),
                                      settings: settings)

        var arrival = [[Double]](repeating: [Double](repeating: infinity, count: n), count: rounds + 1)
        var rideArrival = arrival
        var rideParent = [[RideStep?]](repeating: [RideStep?](repeating: nil, count: n), count: rounds + 1)
        var walkParent = [[WalkStep?]](repeating: [WalkStep?](repeating: nil, count: n), count: rounds + 1)
        var best = [Double](repeating: infinity, count: n)
        var accessMeters: [Int: Double] = [:]
        var marked: [Int] = []

        for (stop, meters) in access {
            let minutes = settings.walkMinutes(meters)
            guard minutes < arrival[0][stop] else { continue }
            arrival[0][stop] = minutes
            best[stop] = minutes
            accessMeters[stop] = meters
            marked.append(stop)
        }
        let egress = Dictionary(egressList.map { ($0.stop, $0.meters) }, uniquingKeysWith: min)

        var journeys: [Journey] = []
        for k in 1...rounds {
            guard !marked.isEmpty else { break }

            // Each pattern is scanned once, from its earliest marked stop.
            var queue: [Int: Int] = [:]
            for stop in Set(marked) {
                for visit in network.patternsAtStop[stop] {
                    if k == 1, bannedFirstRoutes.contains(network.patterns[visit.pattern].routeID) { continue }
                    if let existing = queue[visit.pattern], existing <= visit.position { continue }
                    queue[visit.pattern] = visit.position
                }
            }

            var improved: [Int] = []
            for (p, start) in queue.sorted(by: { $0.key < $1.key }) {
                let pattern = network.patterns[p]
                var base = infinity
                var boardPosition = -1
                var boardTransfer = 0.0
                var boardWait = 0.0
                for i in start..<pattern.stops.count {
                    let stop = pattern.stops[i]
                    if boardPosition >= 0 {
                        let time = base + pattern.offsets[i]
                        if time < best[stop] {
                            best[stop] = time
                            arrival[k][stop] = time
                            rideArrival[k][stop] = time
                            rideParent[k][stop] = RideStep(pattern: p, board: boardPosition, alight: i,
                                                           transfer: boardTransfer, wait: boardWait)
                            walkParent[k][stop] = nil
                            improved.append(stop)
                        }
                    }
                    guard i < pattern.stops.count - 1, arrival[k - 1][stop] < infinity else { continue }
                    let previous = arrival[k - 1][stop]
                    let transfer = k == 1 ? 0 : transferMinutes(round: k - 1, stop: stop, next: pattern,
                                                                rideParent: rideParent, walkParent: walkParent)
                    guard let wait = estimator.wait(pattern: p, position: i, at: previous + transfer) else { continue }
                    let candidate = previous + transfer + wait - pattern.offsets[i]
                    if candidate < base {
                        base = candidate
                        boardPosition = i
                        boardTransfer = transfer
                        boardWait = wait
                    }
                }
            }

            // Walking interchanges always start from a vehicle, never chain walks.
            var walked: [Int] = []
            for stop in improved {
                let from = rideArrival[k][stop]
                for path in network.footpaths[stop] {
                    let time = from + settings.walkMinutes(path.meters)
                    if time < best[path.to] {
                        best[path.to] = time
                        arrival[k][path.to] = time
                        walkParent[k][path.to] = WalkStep(from: stop, meters: path.meters)
                        walked.append(path.to)
                    }
                }
            }
            marked = improved + walked

            var bestEnd = infinity
            var endStop = -1
            for (stop, meters) in egress where arrival[k][stop] < infinity {
                let time = arrival[k][stop] + settings.walkMinutes(meters)
                if time < bestEnd || (time == bestEnd && stop < endStop) {
                    bestEnd = time
                    endStop = stop
                }
            }
            let previousBest = journeys.last?.totalMinutes ?? infinity
            guard endStop >= 0, bestEnd < previousBest - 0.5,
                  let journey = reconstruct(round: k, endStop: endStop, egressMeters: egress[endStop] ?? 0,
                                            accessMeters: accessMeters, departure: departure,
                                            rideParent: rideParent, walkParent: walkParent) else { continue }
            journeys.append(journey)
        }
        return journeys
    }

    private func transferMinutes(round: Int, stop: Int, next: TransitPattern,
                                 rideParent: [[RideStep?]], walkParent: [[WalkStep?]]) -> Double {
        if walkParent[round][stop] == nil, let ride = rideParent[round][stop],
           network.patterns[ride.pattern].op == .mtr, next.op == .mtr {
            return settings.mtrInterchangeMinutes
        }
        return settings.transferMinutes
    }

    private func reconstruct(round: Int, endStop: Int, egressMeters: Double, accessMeters: [Int: Double],
                             departure: Date, rideParent: [[RideStep?]], walkParent: [[WalkStep?]]) -> Journey? {
        var legs: [JourneyLeg] = [.walk(meters: egressMeters, minutes: settings.walkMinutes(egressMeters), toStopID: nil)]
        var stop = endStop
        var k = round
        while k > 0 {
            if let walk = walkParent[k][stop] {
                legs.append(.walk(meters: walk.meters, minutes: settings.walkMinutes(walk.meters),
                                  toStopID: network.stopIDs[stop]))
                stop = walk.from
            }
            guard let step = rideParent[k][stop] else { return nil }
            let pattern = network.patterns[step.pattern]
            legs.append(.ride(PlannedRide(
                routeKey: pattern.routeKey, route: pattern.route, op: pattern.op, dest: pattern.dest,
                boardPosition: step.board, alightPosition: step.alight,
                boardStopID: network.stopIDs[pattern.stops[step.board]],
                alightStopID: network.stopIDs[pattern.stops[step.alight]],
                transferMinutes: step.transfer, waitMinutes: step.wait,
                rideMinutes: pattern.offsets[step.alight] - pattern.offsets[step.board],
                liveDeparture: nil
            )))
            stop = pattern.stops[step.board]
            k -= 1
        }
        guard let meters = accessMeters[stop] else { return nil }
        legs.append(.walk(meters: meters, minutes: settings.walkMinutes(meters), toStopID: network.stopIDs[stop]))
        // Drop zero-length walks, e.g. when the origin is exactly at a stop.
        let cleaned = legs.reversed().filter { leg -> Bool in
            if case .walk(let meters, _, _) = leg { return meters >= 1 }
            return true
        }
        return Journey(legs: cleaned, departure: departure)
    }
}

// MARK: - Live ETAs

struct LiveDeparture: Equatable, Sendable {
    let date: Date
    var platform: Name?
}

/// Re-times a journey with live arrivals: for each ride, the rider reaches
/// the stop at the time implied by the legs before it and takes the first
/// live departure after that. Rides without usable live data keep their
/// estimate.
enum LiveRetimer {
    /// Furthest ahead a rail departure may be projected from live headways.
    static let maxProjectionMinutes = 60.0

    /// The first departure the rider can catch. Rail feeds stop after about four
    /// trains, so later legs continue the live headway instead of guessing.
    static func next(_ live: [LiveDeparture], reachedAt atStop: Date,
                     projecting: Bool) -> (departure: LiveDeparture, isProjected: Bool)? {
        let sorted = live.sorted { $0.date < $1.date }
        // A bus "due now" is still catchable if we are a few seconds late.
        if let next = sorted.first(where: { $0.date >= atStop.addingTimeInterval(-30) }) {
            return (next, false)
        }
        guard projecting, sorted.count >= 2, let first = sorted.first, let last = sorted.last else { return nil }
        let headway = last.date.timeIntervalSince(first.date) / Double(sorted.count - 1)
        guard headway > 0 else { return nil }
        let trains = (atStop.timeIntervalSince(last.date) / headway).rounded(.up)
        guard trains * headway <= maxProjectionMinutes * 60 else { return nil }
        return (LiveDeparture(date: last.date.addingTimeInterval(trains * headway), platform: last.platform), true)
    }

    static func retime(_ journey: Journey,
                       arrivals: (PlannedRide) async -> [LiveDeparture]?) async -> Journey {
        var clock = journey.departure
        var legs: [JourneyLeg] = []
        for leg in journey.legs {
            switch leg {
            case .walk(_, let minutes, _):
                clock = clock.addingTimeInterval(minutes * 60)
                legs.append(leg)
            case .ride(var ride):
                let atStop = clock.addingTimeInterval(ride.transferMinutes * 60)
                let isRail = ride.op == .mtr || ride.op == .lightRail
                if let live = await arrivals(ride), let next = next(live, reachedAt: atStop, projecting: isRail) {
                    ride.waitMinutes = max(0, next.departure.date.timeIntervalSince(atStop) / 60)
                    ride.liveDeparture = next.departure.date
                    ride.isProjected = next.isProjected
                    ride.livePlatform = next.departure.platform
                } else {
                    ride.liveDeparture = nil
                    ride.isProjected = false
                    ride.livePlatform = nil
                }
                clock = atStop.addingTimeInterval((ride.waitMinutes + ride.rideMinutes) * 60)
                legs.append(.ride(ride))
            }
        }
        return Journey(legs: legs, departure: journey.departure)
    }
}
