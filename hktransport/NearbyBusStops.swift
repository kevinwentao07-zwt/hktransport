import CoreLocation
import Foundation

struct BusStopVisit: Identifiable, Sendable {
    let routeKey: String
    let seq: Int
    let co: Operator
    var id: String { "\(routeKey)/\(co.rawValue)/\(seq)" }

    /// Joint routes may use different stop sequences for each operator.
    /// Fetch the operator that actually serves this physical stop.
    func route(in db: TransportDB) -> Route? {
        guard let route = db.routeList[routeKey], let ids = route.stops[co.rawValue],
              ids.indices.contains(seq) else { return nil }
        return Route(route: route.route, co: [co.rawValue], orig: route.orig, dest: route.dest,
                     serviceType: route.serviceType, stops: [co.rawValue: ids],
                     bound: [co.rawValue: route.bound[co.rawValue] ?? ""],
                     gtfsId: route.gtfsId, nlbId: route.nlbId)
    }
}

struct BusStopSite: Identifiable, Sendable {
    let id: String
    let name: Name
    let location: StopLocation
    let visits: [BusStopVisit]
    let routeNumbers: [String]
    let platformIDs: [String]
    let platformLocations: [StopLocation]
}

struct NearbyBusStop: Identifiable, Sendable {
    let site: BusStopSite
    let distance: Double
    var id: String { site.id }
}

struct BusStopIndex: Sendable {
    let id = UUID()
    var sites: [BusStopSite] = []

    static func build(routes: [String: Route], stops: [String: Stop]) -> BusStopIndex {
        var visits: [String: [BusStopVisit]] = [:]
        for (key, route) in routes {
            for co in route.operators where [.kmb, .ctb, .nlb].contains(co) {
                guard let ids = route.stops[co.rawValue] else { continue }
                // The final stop has no onward arrival to board. A circular
                // route's first visit to the same stop is retained separately.
                for seq in ids.indices where seq < ids.count - 1 {
                    guard let location = stops[ids[seq]]?.location, location.isValid else { continue }
                    visits[ids[seq], default: []].append(BusStopVisit(routeKey: key, seq: seq, co: co))
                }
            }
        }
        let sites = visits.compactMap { id, visits -> BusStopSite? in
            guard let stop = stops[id], let location = stop.location else { return nil }
            let ordered = visits.sorted {
                let a = routes[$0.routeKey]!, b = routes[$1.routeKey]!
                let order = a.route.localizedStandardCompare(b.route)
                if order != .orderedSame { return order == .orderedAscending }
                if a.serviceType != b.serviceType { return a.serviceType == "1" || (b.serviceType != "1" && a.serviceType < b.serviceType) }
                return $0.id < $1.id
            }
            let numbers = Set(ordered.compactMap { routes[$0.routeKey]?.route })
                .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            return BusStopSite(id: id, name: normalizedName(stop.name), location: location,
                               visits: ordered, routeNumbers: numbers,
                               platformIDs: [id], platformLocations: [location])
        }
        return BusStopIndex(sites: groupPlatforms(sites, routes: routes))
    }

    private static func normalizedName(_ name: Name) -> Name {
        func clean(_ text: String) -> String {
            text.replacingOccurrences(of: #"\s*[(（][A-Za-z]{1,5}[0-9]{1,6}[A-Za-z0-9-]*[)）]\s*$"#,
                                      with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return Name(en: clean(name.en), zh: clean(name.zh))
    }

    /// Operator stop codes often represent adjacent platforms of one station.
    /// Group equal names only when every platform is within 100 m, so a chain
    /// of similarly named stops cannot merge stations across a long street.
    private static func groupPlatforms(_ platforms: [BusStopSite], routes: [String: Route]) -> [BusStopSite] {
        var groups: [String: [[BusStopSite]]] = [:]
        for platform in platforms.sorted(by: { $0.id < $1.id }) {
            let key = platform.name.zh.isEmpty ? platform.name.en.lowercased() : platform.name.zh
            var candidates = groups[key, default: []]
            let point = CLLocation(latitude: platform.location.lat, longitude: platform.location.lng)
            if let index = candidates.firstIndex(where: { group in
                group.allSatisfy {
                    point.distance(from: CLLocation(latitude: $0.location.lat, longitude: $0.location.lng)) <= 100
                }
            }) {
                candidates[index].append(platform)
            } else {
                candidates.append([platform])
            }
            groups[key] = candidates
        }
        return groups.values.flatMap { $0 }.map { platforms in
            let first = platforms[0]
            let locations = platforms.map(\.location)
            let center = StopLocation(lat: locations.map(\.lat).reduce(0, +) / Double(locations.count),
                                      lng: locations.map(\.lng).reduce(0, +) / Double(locations.count))
            let visits = platforms.flatMap(\.visits).sorted {
                let a = routes[$0.routeKey]!, b = routes[$1.routeKey]!
                let order = a.route.localizedStandardCompare(b.route)
                if order != .orderedSame { return order == .orderedAscending }
                if a.serviceType != b.serviceType { return a.serviceType == "1" || (b.serviceType != "1" && a.serviceType < b.serviceType) }
                return $0.id < $1.id
            }
            let numbers = Set(platforms.flatMap(\.routeNumbers))
                .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            return BusStopSite(id: first.id, name: first.name, location: center, visits: visits,
                               routeNumbers: numbers, platformIDs: platforms.map(\.id), platformLocations: locations)
        }.sorted { $0.id < $1.id }
    }

    func nearby(to location: StopLocation, radius: Double = 1_000, limit: Int = 30) -> [NearbyBusStop] {
        guard location.isValid, radius > 0, limit > 0 else { return [] }
        let origin = CLLocation(latitude: location.lat, longitude: location.lng)
        return Array(sites.compactMap { site -> NearbyBusStop? in
            // Rank a station by its nearest boarding platform, not its centroid.
            let distance = site.platformLocations.map {
                origin.distance(from: CLLocation(latitude: $0.lat, longitude: $0.lng))
            }.min() ?? .infinity
            guard distance <= radius else { return nil }
            return NearbyBusStop(site: site, distance: distance)
        }.sorted {
            $0.distance == $1.distance ? $0.id < $1.id : $0.distance < $1.distance
        }.prefix(limit))
    }
}
