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
        case route, co, orig, dest, serviceType, stops, bound, gtfsId, nlbId
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
}

struct TransportDB: Decodable, Sendable {
    let routeList: [String: Route]
    let stopList: [String: Stop]
    /// Route keys for supported operators, in natural route-number order.
    private(set) var sortedRouteKeys: [String] = []

    private enum CodingKeys: String, CodingKey {
        case routeList, stopList
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
