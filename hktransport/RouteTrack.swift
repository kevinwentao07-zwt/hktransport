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
}

/// A bus worked out from arrival times. There is no public bus tracking.
struct RouteVehicle: Identifiable, Equatable, Sendable {
    var id = 0
    var position: Double
    var location: StopLocation
    var heading: Double
    /// Nil once it has passed the rider's stop.
    var minutes: Int?
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

    /// If a stop's next bus comes sooner than the stop before it, a bus is between the two.
    /// Only two matter to the rider: the one coming, and the one that has just gone.
    static func find(_ arrivals: [RouteArrival], route: Route, op: Operator, boardPosition: Int,
                     stopList: [String: Stop], now: Date) -> [RouteVehicle] {
        guard let stops = route.stops[op.rawValue], stops.count >= 2 else { return [] }
        let perStop = secondsPerStop(route, stopCount: stops.count)
        let nexts = arrivals.compactMap { arrival -> (position: Int, next: Date)? in
            arrival.times.filter { $0 > now }.min().map { (arrival.position, $0) }
        }.sorted { $0.position < $1.position }
        var vehicles: [RouteVehicle] = []
        for (index, stop) in nexts.enumerated() where index > 0 && stop.next < nexts[index - 1].next {
            let before = nexts[index - 1]
            let position = max(Double(before.position), Double(stop.position) - stop.next.timeIntervalSince(now) / perStop)
            guard let place = place(stops, position, stopList: stopList) else { continue }
            // Held at the rider's own stop means it has already reached it, so it is not the one to wait for.
            let minutes = position < Double(boardPosition) ? Int(((Double(boardPosition) - position) * perStop / 60).rounded(.up)) : nil
            vehicles.append(RouteVehicle(position: position, location: place.location, heading: place.heading, minutes: minutes, isNext: false))
        }
        var found: [RouteVehicle] = []
        if var coming = vehicles.filter({ $0.minutes != nil }).max(by: { $0.position < $1.position }) {
            coming.isNext = true
            found.append(coming)
        }
        if let gone = vehicles.filter({ $0.minutes == nil }).min(by: { $0.position < $1.position }) { found.append(gone) }
        return found
    }

    /// Keeps the coming bus true to the time shown for the rider's stop. A bus too far from that
    /// time is a different one, so it moves to where the due bus must be; nil when that is before
    /// the start of the route, as the due bus has not set off yet.
    static func due(_ vehicle: RouteVehicle, in seconds: Double, route: Route, op: Operator, boardPosition: Int,
                    stopList: [String: Stop]) -> RouteVehicle? {
        guard let stops = route.stops[op.rawValue] else { return vehicle }
        let position = Double(boardPosition) - seconds / secondsPerStop(route, stopCount: stops.count)
        if abs(position - vehicle.position) < sameBusStops { return vehicle }
        guard position >= 0, let place = place(stops, position, stopList: stopList) else { return nil }
        var moved = vehicle
        moved.position = position
        moved.location = place.location
        moved.heading = place.heading
        return moved
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
