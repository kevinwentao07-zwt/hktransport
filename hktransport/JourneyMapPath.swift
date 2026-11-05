import MapKit

/// The shape of one journey on the map: every leg as a line through the stops
/// it passes. The data has stops but no road geometry, so lines join stops.
struct JourneyMapPath: Equatable, Sendable {
    enum Mode: Equatable, Sendable {
        case walk
        case ride(route: String, op: Operator)
    }

    struct Segment: Identifiable, Equatable, Sendable {
        let id: Int
        let mode: Mode
        let points: [StopLocation]
        /// Matches `points` one to one on rides; empty on walks.
        var stopIDs: [String] = []
    }

    let origin: StopLocation
    let destination: StopLocation
    let segments: [Segment]

    init(journey: Journey, origin: StopLocation, destination: StopLocation, db: TransportDB) {
        var cursor = origin
        var segments: [Segment] = []
        for leg in journey.legs {
            let mode: Mode
            let points: [StopLocation]
            var stopIDs: [String] = []
            switch leg {
            case .walk(_, _, let toStopID):
                // Only the final walk has no stop; it ends at the destination.
                let target = toStopID.map { db.stopList[$0]?.location } ?? destination
                guard let target else { continue }
                mode = .walk
                points = [cursor, target]
            case .ride(let ride):
                mode = .ride(route: ride.route, op: ride.op)
                let stops = ride.stopIDs(in: db).compactMap { id -> (id: String, location: StopLocation)? in
                    guard let location = db.stopList[id]?.location, location.isValid else { return nil }
                    return (id, location)
                }
                points = stops.map(\.location)
                stopIDs = stops.map(\.id)
            }
            guard let last = points.last else { continue }
            segments.append(Segment(id: segments.count, mode: mode, points: points, stopIDs: stopIDs))
            cursor = last
        }
        self.origin = origin
        self.destination = destination
        self.segments = segments
    }

    var allPoints: [StopLocation] {
        [origin] + segments.flatMap(\.points) + [destination]
    }
}

extension PlannedRide {
    /// Every stop the rider passes, from boarding to alighting.
    func stopIDs(in db: TransportDB) -> [String] {
        guard let all = db.routeList[routeKey]?.stops[op.rawValue], boardPosition <= alightPosition,
              all.indices.contains(alightPosition) else { return [boardStopID, alightStopID] }
        return Array(all[boardPosition...alightPosition])
    }
}

extension MKCoordinateRegion {
    /// Smallest comfortable view of `points`, with room for markers at the edges.
    /// Nil when there is nothing valid to show.
    init?(fitting points: [StopLocation]) {
        let valid = points.filter(\.isValid)
        guard let minLat = valid.map(\.lat).min(), let maxLat = valid.map(\.lat).max(),
              let minLng = valid.map(\.lng).min(), let maxLng = valid.map(\.lng).max() else { return nil }
        let padding = 1.4
        let minimumSpan = 0.006
        self.init(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2),
            span: MKCoordinateSpan(latitudeDelta: max((maxLat - minLat) * padding, minimumSpan),
                                   longitudeDelta: max((maxLng - minLng) * padding, minimumSpan))
        )
    }
}
