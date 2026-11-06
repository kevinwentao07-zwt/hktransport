import Foundation

/// A route's real road line with every stop placed along it, in order. A route can use a road
/// twice, as circular and out-and-back routes do, so places are found by progress along the
/// line, never by what is nearest.
struct RouteTrack: Sendable {
    struct Pass: Equatable, Sendable {
        let location: StopLocation
        let at: Double
    }

    let line: [StopLocation]
    let along: [Double]
    /// One per stop of the route; nil when a stop sits too far from the line.
    let passes: [Pass?]

    private static let mostMetersOffLine = 300.0
    private static let evenProgressMeters = 60.0

    init?(line: [StopLocation], stops: [StopLocation?]) {
        guard line.count >= 2 else { return nil }
        var along = [0.0]
        for index in 1..<line.count { along.append(along[index - 1] + Geo.meters(line[index - 1], line[index])) }
        let known = stops.enumerated().compactMap { index, location -> (location: StopLocation, index: Int, share: Double)? in
            guard let location, location.isValid else { return nil }
            return (location, index, Double(index) / Double(max(1, stops.count - 1)))
        }
        guard known.count >= 2 else { return nil }
        var passes = [Pass?](repeating: nil, count: stops.count)
        var reached = 0.0
        for (order, stretch) in Self.align(line, along, known.map { ($0.location, $0.share) }).enumerated() {
            let stop = known[order], point = Self.point(on: line, stretch, nearest: stop.location)
            guard Geo.meters(point, stop.location) <= Self.mostMetersOffLine else { continue }
            // Two stops can share a stretch, and a bus still only goes forward.
            reached = max(reached, along[stretch] + Geo.meters(line[stretch], point))
            passes[stop.index] = Pass(location: point, at: reached)
        }
        guard passes.compactMap({ $0 }).count >= 2 else { return nil }
        self.line = line
        self.along = along
        self.passes = passes
    }

    private static func point(on line: [StopLocation], _ index: Int, nearest location: StopLocation) -> StopLocation {
        let scale = cos(location.lat * .pi / 180), a = line[index], b = line[index + 1]
        let east = (b.lng - a.lng) * scale, north = b.lat - a.lat, length = east * east + north * north
        let part = length > 0 ? max(0, min(1, ((location.lng - a.lng) * scale * east + (location.lat - a.lat) * north) / length)) : 0
        return StopLocation(lat: a.lat + (b.lat - a.lat) * part, lng: a.lng + (b.lng - a.lng) * part)
    }

    /// Finds the best place on the line for every stop at once, always moving forward. Stops are
    /// only metres from the opposite carriageway, so taking each one's nearest match would put
    /// return stops on the way out. Near-ties lean toward even progress.
    private static func align(_ line: [StopLocation], _ along: [Double], _ stops: [(location: StopLocation, share: Double)]) -> [Int] {
        let count = line.count - 1, total = along.last.flatMap { $0 > 0 ? $0 : nil } ?? 1
        var previous = [Double](repeating: 0, count: count)
        var cameFrom: [[Int32]] = []
        for stop in stops {
            var costs = [Double](repeating: 0, count: count), from = [Int32](repeating: 0, count: count)
            var cheapest = Double.infinity, cheapestAt = 0
            for index in 0..<count {
                if previous[index] < cheapest {
                    cheapest = previous[index]
                    cheapestAt = index
                }
                let away = min(Geo.meters(point(on: line, index, nearest: stop.location), stop.location), mostMetersOffLine)
                costs[index] = cheapest + away + evenProgressMeters * abs(along[index] / total - stop.share)
                from[index] = Int32(cheapestAt)
            }
            previous = costs
            cameFrom.append(from)
        }
        var index = previous.indices.min { previous[$0] < previous[$1] } ?? 0
        var placed = [Int](repeating: 0, count: stops.count)
        for stop in stops.indices.reversed() {
            placed[stop] = index
            index = Int(cameFrom[stop][index])
        }
        return placed
    }

    /// How far along the line a fractional stop number is, between the stops that were placed.
    private func distance(at position: Double) -> Double {
        var before = min(Int(position.rounded(.down)), passes.count - 1), after = before + 1
        while before >= 0, passes[before] == nil { before -= 1 }
        while after < passes.count, passes[after] == nil { after += 1 }
        if before < 0 { return passes[after]?.at ?? 0 }
        guard after < passes.count, let first = passes[before], let second = passes[after] else { return passes[before]?.at ?? 0 }
        return first.at + (second.at - first.at) * (position - Double(before)) / Double(after - before)
    }

    private func stretch(at distance: Double) -> Int {
        var low = 0, high = line.count - 2
        while low < high {
            let middle = (low + high + 1) / 2
            if along[middle] <= distance { low = middle } else { high = middle - 1 }
        }
        return low
    }

    /// Where a fractional stop number is on the road, and which way the road runs there.
    func place(at position: Double) -> (location: StopLocation, heading: Double) {
        let distance = distance(at: position), index = stretch(at: distance)
        let a = line[index], b = line[index + 1], length = along[index + 1] - along[index]
        let part = length > 0 ? max(0, min(1, (distance - along[index]) / length)) : 0
        return (StopLocation(lat: a.lat + (b.lat - a.lat) * part, lng: a.lng + (b.lng - a.lng) * part), Self.heading(a, b))
    }

    /// The road between two fractional stop numbers.
    func road(from: Double, to: Double) -> [StopLocation] {
        let start = stretch(at: distance(at: from)), end = stretch(at: distance(at: to))
        let middle = start < end ? Array(line[(start + 1)...end]) : []
        return [place(at: from).location] + middle + [place(at: to).location]
    }

    static func heading(_ a: StopLocation, _ b: StopLocation) -> Double {
        atan2((b.lng - a.lng) * cos(a.lat * .pi / 180), b.lat - a.lat) * 180 / .pi
    }
}

/// What a route's arrivals say at one stop.
struct RouteArrival: Sendable {
    let position: Int
    let times: [Date]
    /// Times only on the timetable, for a bus the operator is not following.
    var planned: [Date] = []
}

/// A bus worked out from arrival times. There is no public bus tracking.
struct RouteVehicle: Identifiable, Equatable, Sendable {
    var id = 0
    var position: Double
    var location: StopLocation
    var heading: Double
    /// Nil once it has passed the rider's stop, or with no stop chosen.
    var minutes: Int?
    var arrival: Date?
    var isNext: Bool
    var isLive = false
}

enum RouteVehicles {
    static let sameBusStops = 1.5
    private static let secondsPerStopByDefault = 90.0

    static func secondsPerStop(_ route: Route, stopCount: Int) -> Double {
        route.journeyMinutes.map { $0 * 60 / Double(max(1, stopCount - 1)) } ?? secondsPerStopByDefault
    }

    /// A fractional stop number as a place on the map, used until the road line arrives.
    static func place(_ stops: [String], _ position: Double, stopList: [String: Stop]) -> (location: StopLocation, heading: Double)? {
        let index = min(Int(position.rounded(.down)), stops.count - 2), part = position - Double(index)
        guard index >= 0, let from = stopList[stops[index]]?.location, let to = stopList[stops[index + 1]]?.location,
              from.isValid, to.isValid else { return nil }
        return (StopLocation(lat: from.lat + (to.lat - from.lat) * part, lng: from.lng + (to.lng - from.lng) * part),
                RouteTrack.heading(from, to))
    }

    private struct StopTime {
        let position: Int
        let time: Double
        let isPlanned: Bool
    }

    private final class Timetable {
        var stops: [StopTime] = []
        var expected = 0.0
        var missed = 0
        var link: StopTime?
    }

    private static let sameGap = 20.0, longestGap = 20 * 60.0, mostStopsMissed = 2

    /// How long each stop to the next takes. The operator's times for different buses agree on it
    /// to the second, so the gap most pairs of times share is the true one.
    private static func stopGaps(_ byStop: [[StopTime]], fallback: Double) -> [Double] {
        (0..<max(0, byStop.count - 1)).map { position in
            let gaps = byStop[position].flatMap { here in byStop[position + 1].map { $0.time - here.time } }
                .filter { $0 > 0 && $0 < longestGap }
            let sharing = gaps.map { gap in gaps.filter { abs($0 - gap) <= sameGap } }
            let most = sharing.map(\.count).max() ?? 0
            let best = sharing.filter { $0.count == most }.min { abs($0[0] - fallback) < abs($1[0] - fallback) }
            return best.map { $0.reduce(0, +) / Double($0.count) } ?? fallback
        }
    }

    /// Links the times at every stop into one timetable per bus: each continues as the next stop's
    /// time it predicts. A time too far off to be a bus that has just passed the stop before is a bus
    /// still behind it, so one the operator has timed unevenly: it joins the nearest bus not yet linked.
    private static func timetables(_ byStop: [[StopTime]], gaps: [Double], now: Double) -> [Timetable] {
        var buses: [Timetable] = [], open: [Timetable] = []
        for (position, entries) in byStop.enumerated() {
            let tolerance = max(45, (position > 0 ? gaps[position - 1] : 0) * 0.3)
            var used = Set<Int>()
            let fits = open.flatMap { bus in entries.indices.map { (bus: bus, entry: $0, miss: abs(entries[$0].time - bus.expected)) } }
                .filter { $0.miss <= tolerance }.sorted { $0.miss < $1.miss }
            for fit in fits where fit.bus.link == nil && !used.contains(fit.entry) {
                fit.bus.link = entries[fit.entry]
                used.insert(fit.entry)
            }
            for index in entries.indices where !used.contains(index) && position > 0 && entries[index].time - now > gaps[position - 1] {
                let time = entries[index].time
                guard let bus = open.filter({ $0.link == nil }).min(by: { abs(time - $0.expected) < abs(time - $1.expected) }) else { continue }
                bus.link = entries[index]
                used.insert(index)
            }
            for index in entries.indices where !used.contains(index) {
                let bus = Timetable()
                bus.link = entries[index]
                buses.append(bus)
                open.append(bus)
            }
            let gap = position < gaps.count ? gaps[position] : 0
            open = open.filter { bus in
                defer { bus.link = nil }
                if let link = bus.link {
                    bus.stops.append(link)
                    bus.expected = link.time + gap
                    bus.missed = 0
                    return true
                }
                bus.expected += gap
                bus.missed += 1
                return bus.missed <= mostStopsMissed
            }
        }
        return buses
    }

    /// Where a bus is at `now`: between the stops its times fall between. Nil when off the route.
    private static func position(of stops: [StopTime], gaps: [Double], now: Double) -> Double? {
        guard let next = stops.firstIndex(where: { $0.time > now }) else { return nil }
        let after = stops[next]
        if next > 0 {
            let before = stops[next - 1]
            return Double(before.position) + Double(after.position - before.position) * (now - before.time) / (after.time - before.time)
        }
        // No stop before this one lists it, so go back along the route by the time it still needs.
        var position = after.position, left = after.time - now
        while position > 0, left >= gaps[position - 1] {
            position -= 1
            left -= gaps[position]
        }
        return position == 0 ? nil : Double(position) - left / gaps[position - 1] // At 0 it has not set off.
    }

    /// When a bus reaches a stop: its own time there, or else counted on from its nearest stop.
    private static func arrival(of stops: [StopTime], at position: Int, gaps: [Double]) -> (time: Double, isLive: Bool) {
        let anchor = stops.last { $0.position <= position } ?? stops[0]
        let between = gaps[min(anchor.position, position)..<max(anchor.position, position)].reduce(0, +)
        return (anchor.time + (anchor.position <= position ? between : -between), anchor.position == position)
    }

    /// Every bus on a route. There is no public bus tracking, but the arrivals at all the stops
    /// together give each bus's timetable, and that says where it is now. Times for buses that are
    /// only timetabled are not followed. The bus that reaches the rider's stop first is the next one.
    static func find(_ arrivals: [RouteArrival], route: Route, op: Operator, boardPosition: Int?,
                     stopList: [String: Stop], now: Date) -> [RouteVehicle] {
        guard let stops = route.stops[op.rawValue], stops.count >= 2 else { return [] }
        var byStop = [[StopTime]](repeating: [], count: stops.count)
        for arrival in arrivals where byStop.indices.contains(arrival.position) {
            byStop[arrival.position] = (arrival.times.map { StopTime(position: arrival.position, time: $0.timeIntervalSince1970, isPlanned: false) }
                + arrival.planned.map { StopTime(position: arrival.position, time: $0.timeIntervalSince1970, isPlanned: true) })
                .sorted { $0.time < $1.time }
        }
        let gaps = stopGaps(byStop, fallback: secondsPerStop(route, stopCount: stops.count))
        let moment = now.timeIntervalSince1970
        var vehicles: [RouteVehicle] = timetables(byStop, gaps: gaps, now: moment).compactMap { bus in
            guard bus.stops.contains(where: { !$0.isPlanned }), let position = position(of: bus.stops, gaps: gaps, now: moment),
                  let place = place(stops, position, stopList: stopList) else { return nil }
            var vehicle = RouteVehicle(position: position, location: place.location, heading: place.heading, minutes: nil, isNext: false)
            if let boardPosition, position < Double(boardPosition) {
                let due = arrival(of: bus.stops, at: boardPosition, gaps: gaps)
                vehicle.arrival = Date(timeIntervalSince1970: due.time)
                vehicle.minutes = max(0, Int((due.time - moment) / 60))
                vehicle.isLive = due.isLive
            }
            return vehicle
        }
        vehicles.sort { $0.position > $1.position }
        let coming = vehicles.indices.filter { vehicles[$0].arrival != nil }.min { vehicles[$0].arrival! < vehicles[$1].arrival! }
        if let coming { vehicles[coming].isNext = true }
        return vehicles
    }
}

extension Route {
    private static let loopClosesWithin = 300.0

    /// Where a circular route turns for home: the stop it is signed for, or else its farthest stop.
    /// Nil for a route that does not come back to its start.
    func circularTurn(_ op: Operator, stopList: [String: Stop]) -> Int? {
        let ids = stops[op.rawValue] ?? [], places = ids.map { stopList[$0]?.location }
        guard ids.count >= 3, op != .mtr, let first = places.first ?? nil, let last = places.last ?? nil else { return nil }
        let isSigned = dest.zh.contains("循環") || dest.en.lowercased().contains("circular")
        guard isSigned || (ids.count >= 4 && Geo.meters(first, last) <= Self.loopClosesWithin) else { return nil }
        let away = places.map { $0.map { Geo.meters(first, $0) } ?? 0 }
        let farthest = away.indices.max { away[$0] < away[$1] } ?? 0
        let signed = RoutePlannerModel.cleanStopName(dest.zh)
            .replacingOccurrences(of: #"\s*[(（]循環線[)）]\s*"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        // A terminus can share its name with a stop beside the start, which is no turning point.
        let named = signed.isEmpty ? [] : ids.indices.filter { position in
            position > 0 && position < ids.count - 1 && away[position] >= away[farthest] / 2
                && stopList[ids[position]]?.name.zh.contains(signed) == true
        }
        let turn = named.min { abs($0 - farthest) < abs($1 - farthest) } ?? farthest
        return turn > 0 && turn < ids.count - 1 ? turn : nil
    }
}
