import Foundation
import SwiftUI

enum Lang: String, Sendable {
    case zh
    case en
}

enum Operator: String, CaseIterable, Sendable {
    // LWB routes are published under "kmb" in the shared route database and ETA API.
    case kmb, ctb, nlb, gmb, lightRail, mtr

    var label: String {
        switch self {
        case .kmb: return "KMB·LWB"
        case .ctb: return "CTB"
        case .nlb: return "NLB"
        case .gmb: return "GMB"
        case .lightRail: return "LRT"
        case .mtr: return "MTR"
        }
    }

    var color: Color {
        switch self {
        case .kmb: return Color(red: 0.89, green: 0.14, blue: 0.17)
        case .ctb: return Color(red: 1.00, green: 0.82, blue: 0.00)
        case .nlb: return Color(red: 0.11, green: 0.64, blue: 0.61)
        case .gmb: return Color(red: 0.24, green: 0.68, blue: 0.29)
        case .lightRail: return Color(red: 0.95, green: 0.60, blue: 0.00)
        case .mtr: return Color(red: 0.43, green: 0.55, blue: 0.84)
        }
    }
}

struct Name: Codable, Hashable, Sendable {
    var en: String
    var zh: String

    static let empty = Name(en: "", zh: "")

    func text(_ lang: Lang) -> String {
        lang == .zh ? zh : en
    }
}

struct Route: Sendable {
    let route: String
    let co: [String]
    let orig: Name
    let dest: Name
    let serviceType: String
    let stops: [String: [String]]
    let bound: [String: String]
    let gtfsId: String?
    let nlbId: String?
    /// Whole-route journey time in minutes (`jt`), when the operator publishes one.
    var journeyMinutes: Double? = nil
    /// Timetabled service bands (`freq`), used by the route planner to estimate waits.
    var frequency: RouteFrequency? = nil

    /// Supported operators that actually list stops for this route.
    var operators: [Operator] {
        co.compactMap(Operator.init(rawValue:)).filter { stops[$0.rawValue] != nil }
    }

    var stopIDs: [String] {
        operators.first.flatMap { stops[$0.rawValue] } ?? []
    }
}

extension Route: Decodable {
    private enum CodingKeys: String, CodingKey {
        case route, co, orig, dest, serviceType, stops, bound, gtfsId, nlbId, jt, freq
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        route = try c.decode(String.self, forKey: .route)
        co = try c.decode([String].self, forKey: .co)
        orig = try c.decode(Name.self, forKey: .orig)
        dest = try c.decode(Name.self, forKey: .dest)
        serviceType = try c.decode(LooseString.self, forKey: .serviceType).value
        stops = try c.decode([String: [String]].self, forKey: .stops)
        bound = try c.decode([String: String].self, forKey: .bound)
        gtfsId = try c.decodeIfPresent(LooseString.self, forKey: .gtfsId)?.value
        nlbId = try c.decodeIfPresent(LooseString.self, forKey: .nlbId)?.value
        // Planner-only fields: a malformed value must never break the whole database.
        journeyMinutes = (try? c.decodeIfPresent(LooseString.self, forKey: .jt))?
            .flatMap { Double($0.value) }
            .flatMap { $0 > 0 ? $0 : nil }
        frequency = (try? c.decodeIfPresent([String: [String: [String?]?]].self, forKey: .freq))?
            .flatMap(RouteFrequency.init(raw:))
    }
}

/// Service bands per service-day id, e.g. `{"287": {"0535": ["0705", "900"]}}`:
/// from 05:35 to 07:05 a bus leaves the first stop every 900 seconds.
/// A band without a headway is a single departure at its start time.
struct RouteFrequency: Sendable, Equatable {
    struct Band: Sendable, Equatable {
        /// Minutes after midnight.
        let start: Int
        let end: Int?
        let headwaySeconds: Int?
    }

    let days: [String: [Band]]

    init(days: [String: [Band]]) {
        self.days = days
    }

    init?(raw: [String: [String: [String?]?]]) {
        var days: [String: [Band]] = [:]
        for (day, bands) in raw {
            days[day] = bands.compactMap { start, value -> Band? in
                guard let startMinute = Self.minuteOfDay(start) else { return nil }
                let endText: String? = value.flatMap { $0.first ?? nil }
                let headwayText: String? = value.flatMap { $0.count > 1 ? $0[1] : nil }
                let headway = headwayText.flatMap { Int($0) }.flatMap { $0 > 0 ? $0 : nil }
                return Band(start: startMinute, end: endText.flatMap(Self.minuteOfDay), headwaySeconds: headway)
            }.sorted { $0.start < $1.start }
        }
        guard !days.isEmpty else { return nil }
        self.days = days
    }

    /// "0535" -> 335
    static func minuteOfDay(_ text: String) -> Int? {
        guard text.count == 4, let value = Int(text) else { return nil }
        let hours = value / 100, minutes = value % 100
        guard (0...47).contains(hours), (0...59).contains(minutes) else { return nil }
        return hours * 60 + minutes
    }
}

/// The route database mixes numbers and strings for the same field.
private struct LooseString: Decodable {
    let value: String

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let string = try? c.decode(String.self) {
            value = string
        } else {
            value = String(try c.decode(Int.self))
        }
    }
}

struct Stop: Decodable, Sendable {
    let name: Name
    let location: StopLocation?

    init(name: Name, location: StopLocation? = nil) {
        self.name = name
        self.location = location
    }
}

struct StopLocation: Decodable, Hashable, Sendable {
    let lat: Double
    let lng: Double

    var isValid: Bool {
        lat.isFinite && lng.isFinite && (-90...90).contains(lat) && (-180...180).contains(lng)
    }
}

struct TransportDB: Decodable, Sendable {
    let routeList: [String: Route]
    let stopList: [String: Stop]
    /// Service-day id -> seven "0"/"1" flags, Sunday first.
    var serviceDayMap: [String: [String]]? = nil
    /// Public holidays as "yyyyMMdd"; they run the Sunday timetable.
    var holidays: [String]? = nil
    /// Route keys for supported operators, in natural route-number order.
    private(set) var sortedRouteKeys: [String] = []
    private(set) var busStopIndex = BusStopIndex()
    /// Every kind of stop, for the stop search page.
    private(set) var allStopIndex = BusStopIndex()

    private enum CodingKeys: String, CodingKey {
        case routeList, stopList, serviceDayMap, holidays
    }

    static func decode(_ data: Data) throws -> TransportDB {
        var db = try JSONDecoder().decode(TransportDB.self, from: data)
        db.sortedRouteKeys = db.routeList
            .filter { !$0.value.operators.isEmpty }
            .sorted { a, b in
                let order = a.value.route.localizedStandardCompare(b.value.route)
                return order == .orderedSame ? a.key < b.key : order == .orderedAscending
            }
            .map(\.key)
        db.busStopIndex = BusStopIndex.build(routes: db.routeList, stops: db.stopList)
        db.allStopIndex = BusStopIndex.build(routes: db.routeList, stops: db.stopList, operators: Set(Operator.allCases))
        return db
    }
}

struct SavedStop: Codable, Hashable, Identifiable, Sendable {
    let routeKey: String
    let seq: Int

    var id: String { "\(routeKey)/\(seq)" }
}

/// Downloads hkbus.app's open route database and keeps the last good copy on disk.
enum TransportDBStore {
    private static let sources = [
        "https://data.hkbus.app/routeFareList.min.json",
        "https://hkbus.github.io/hk-bus-crawling/routeFareList.min.json",
    ].compactMap(URL.init(string:))

    private static var cacheURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("hktransport", isDirectory: true)
            .appendingPathComponent("routeFareList.min.json")
    }

    static var isCacheStale: Bool {
        let modified = (try? cacheURL.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate ?? .distantPast
        return Date().timeIntervalSince(modified) > 7 * 86_400
    }

    static func cached() async -> TransportDB? {
        let url = cacheURL
        return await Task.detached(priority: .utility) {
            try? TransportDB.decode(Data(contentsOf: url))
        }.value
    }

    static func download() async throws -> TransportDB {
        var lastError: Error = URLError(.badServerResponse)
        for source in sources {
            do {
                let (data, response) = try await URLSession.shared.data(from: source)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { continue }
                let db = try await Task.detached(priority: .utility) {
                    try TransportDB.decode(data)
                }.value
                // Only overwrite the cache with data that decoded successfully.
                let url = cacheURL
                try? FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try? data.write(to: url, options: .atomic)
                return db
            } catch {
                lastError = error
            }
        }
        throw lastError
    }
}
