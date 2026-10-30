import Foundation

struct ETA: Hashable, Sendable {
    /// nil when the operator only returned a notice (service ended, suspended, ...).
    let date: Date?
    let remark: Name
    let dest: Name
    let co: Operator
}

/// Swift port of the `hk-bus-eta` fetchers used by hkbus.app, limited to
/// KMB/LWB, CTB, NLB, GMB, Light Rail and MTR.
enum ETAService {
    static func fetch(
        route: Route,
        seq: Int,
        stopList: [String: Stop],
        language: Lang
    ) async throws -> [ETA] {
        let results = await withTaskGroup(of: Result<[ETA], Error>.self) { group in
            for op in route.operators {
                group.addTask {
                    do {
                        return .success(
                            try await ETAService.fetch(op, route: route, seq: seq, stopList: stopList, language: language)
                        )
                    } catch {
                        return .failure(error)
                    }
                }
            }
            var results: [Result<[ETA], Error>] = []
            for await result in group {
                results.append(result)
            }
            return results
        }
        let lists = results.compactMap { try? $0.get() }
        if lists.isEmpty, case .failure(let error)? = results.first {
            throw error
        }
        return merge(lists)
    }

    /// Joint routes return one list per operator. Notices are kept only when
    /// no operator has a real arrival time.
    static func merge(_ lists: [[ETA]]) -> [ETA] {
        let all = lists.flatMap { $0 }
        let timed = all.filter { $0.date != nil }
        guard !timed.isEmpty else { return all }
        return timed.sorted { ($0.date ?? .distantFuture) < ($1.date ?? .distantFuture) }
    }

    private static func fetch(
        _ op: Operator,
        route: Route,
        seq: Int,
        stopList: [String: Stop],
        language: Lang
    ) async throws -> [ETA] {
        guard let stops = route.stops[op.rawValue], stops.indices.contains(seq) else { return [] }
        let stopId = stops[seq]
        let bound = route.bound[op.rawValue] ?? ""
        let routeNo = path(route.route)

        switch op {
        case .kmb:
            let data = try await get("https://data.etabus.gov.hk/v1/transport/kmb/eta/\(path(stopId))/\(routeNo)/\(path(route.serviceType))")
            return try parseKMB(data, bound: bound, seq: seq, stopId: stopId, stops: stops)
        case .ctb:
            let data = try await get("https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/\(path(stopId))/\(routeNo)")
            return try parseCTB(data, bound: bound, seq: seq)
        case .nlb:
            guard let nlbId = route.nlbId else { return [] }
            let data = try await get("https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=estimatedArrivals&routeId=\(query(nlbId))&stopId=\(query(stopId))&language=\(language.rawValue)")
            return try parseNLB(data)
        case .gmb:
            guard let gtfsId = route.gtfsId else { return [] }
            let data = try await get("https://data.etagmb.gov.hk/eta/route-stop/\(path(gtfsId))/\(path(stopId))")
            return try parseGMB(data, bound: bound, seq: seq)
        case .lightRail:
            let data = try await get("https://rt.data.gov.hk/v1/transport/mtr/lrt/getSchedule?station_id=\(query(String(stopId.dropFirst(2))))&with_special=1")
            return try parseLightRail(data, route: route.route, dest: route.dest, now: Date())
        case .mtr:
            let data = try await get("https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=\(query(route.route))&sta=\(query(stopId))")
            return try parseMTR(data, line: route.route, stopId: stopId, bound: bound, stopList: stopList)
        }
    }

    // MARK: - Parsers (pure, covered by ETAServiceTests)

    static func fetchLightRailStation(_ station: String) async throws -> LightRailBoard {
        guard let code = LightRailNetwork.normalizedCode(station) else { throw URLError(.badURL) }
        let data = try await get("https://rt.data.gov.hk/v1/transport/mtr/lrt/getSchedule?station_id=\(code)&with_special=1")
        return try parseLightRailBoard(data, now: Date())
    }

    static func parseLightRailBoard(_ data: Data, now: Date) throws -> LightRailBoard {
        let object = try json(data)
        guard let platforms = object["platform_list"] as? [[String: Any]] else {
            throw URLError(.cannotParseResponse)
        }
        return LightRailBoard(platforms: platforms.map { platform in
            let platformID = string(platform["platform_id"])
            let trains = rows(platform["route_list"]).filter { int($0["stop"]) == 0 }
            return LightRailPlatform(
                id: platformID,
                serviceEnded: (int(platform["end_service_status"]) ?? 0) != 0,
                arrivals: trains.enumerated().map { index, train in
                    let timeEn = string(train["time_en"])
                    let minutes = Int(String(timeEn.prefix(while: { $0.isASCII && $0.isNumber })))
                    let immediate = ["arriving", "departing"].contains(timeEn.lowercased())
                    return LightRailArrival(
                        id: "\(platformID)-\(index)", route: string(train["route_no"]),
                        destination: Name(en: string(train["dest_en"]), zh: string(train["dest_ch"])),
                        time: Name(en: timeEn, zh: string(train["time_ch"])),
                        date: minutes.map { now.addingTimeInterval(Double($0) * 60) } ?? (immediate ? now : nil),
                        cars: max(0, int(train["train_length"]) ?? 0),
                        remark: Name(en: string(train["routeRemarkEng2"]), zh: string(train["routeRemarkChi2"]))
                    )
                }
            )
        }, updatedAt: parseDate(string(object["system_time"])))
    }

    /// One station request includes both directions, including branch destinations.
    static func fetchMTRStation(line: String, station: String, stopList: [String: Stop]) async throws -> MTRLineBoard {
        let data = try await get("https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=\(query(line))&sta=\(query(station))")
        return try parseMTRBoard(data, line: line, station: station, stopList: stopList)
    }

    static func parseMTRBoard(_ data: Data, line: String, station: String, stopList: [String: Stop]) throws -> MTRLineBoard {
        let object = try json(data)
        if int(object["status"]) == 0 {
            let message = string(object["message"]).trimmingCharacters(in: .whitespacesAndNewlines)
            return MTRLineBoard(line: line, up: [], down: [], updatedAt: nil,
                                isDelayed: false, message: message.isEmpty ? "Service information unavailable" : message)
        }
        guard let stationData = (object["data"] as? [String: Any])?["\(line)-\(station)"] as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        return MTRLineBoard(
            line: line,
            up: try parseMTR(data, line: line, stopId: station, bound: "UT", stopList: stopList),
            down: try parseMTR(data, line: line, stopId: station, bound: "DT", stopList: stopList),
            updatedAt: parseDate(string(stationData["curr_time"])),
            isDelayed: string(object["isdelay"]) == "Y",
            message: nil
        )
    }

    static func parseKMB(_ data: Data, bound: String, seq: Int, stopId: String, stops: [String]) throws -> [ETA] {
        var matching = nearestSeq(rows(try json(data)["data"]).filter { string($0["dir"]) == bound }, to: seq + 1)
        if stops.first == stops.last, stopId == stops.first {
            // Circular route: the terminus appears twice, keep the requested visit.
            matching = matching.filter { int($0["seq"]) == seq + 1 }
        }
        return matching.map { busETA($0, co: .kmb) }
    }

    static func parseCTB(_ data: Data, bound: String, seq: Int) throws -> [ETA] {
        let matching = rows(try json(data)["data"]).filter { row in
            let dir = string(row["dir"])
            return !dir.isEmpty && bound.contains(dir)
        }
        return nearestSeq(matching, to: seq + 1).map { busETA($0, co: .ctb) }
    }

    static func parseNLB(_ data: Data) throws -> [ETA] {
        let object = try json(data)
        let etas = rows(object["estimatedArrivals"])
            .filter { !string($0["estimatedArrivalTime"]).isEmpty }
            .map { row -> ETA in
                let scheduled = string(row["departed"]) != "1" || string(row["noGPS"]) == "1"
                let variant = string(row["routeVariantName"])
                return ETA(
                    date: parseDate(string(row["estimatedArrivalTime"])),
                    remark: scheduled ? Name(en: "Scheduled", zh: "預定班次") : .empty,
                    dest: Name(en: variant, zh: variant),
                    co: .nlb
                )
            }
        let message = string(object["message"])
        if etas.isEmpty, !message.isEmpty {
            return [notice(message, co: .nlb)]
        }
        return etas
    }

    static func parseGMB(_ data: Data, bound: String, seq: Int) throws -> [ETA] {
        guard let routeSeq = bound == "O" ? 1 : bound == "I" ? 2 : nil else { return [] }
        return rows(try json(data)["data"])
            .filter { int($0["route_seq"]) == routeSeq && int($0["stop_seq"]) == seq + 1 }
            .flatMap { row -> [ETA] in
                guard (row["enabled"] as? Bool) == true else {
                    return [ETA(
                        date: nil,
                        remark: Name(en: string(row["description_en"]), zh: string(row["description_tc"])),
                        dest: .empty,
                        co: .gmb
                    )]
                }
                return rows(row["eta"]).map {
                    ETA(
                        date: parseDate(string($0["timestamp"])),
                        remark: Name(en: string($0["remarks_en"]), zh: string($0["remarks_tc"])),
                        dest: .empty,
                        co: .gmb
                    )
                }
            }
    }

    static func parseLightRail(_ data: Data, route: String, dest: Name, now: Date) throws -> [ETA] {
        guard let platforms = try json(data)["platform_list"] as? [[String: Any]] else { return [] }
        if platforms.allSatisfy({ (int($0["end_service_status"]) ?? 0) != 0 }) {
            return [ETA(
                date: nil,
                remark: Name(en: "This stop's service for today has ended", zh: "此站今日服務已經終止"),
                dest: .empty,
                co: .lightRail
            )]
        }
        return platforms.flatMap { platform -> [ETA] in
            let platformID = string(platform["platform_id"])
            return rows(platform["route_list"])
                .filter { train in
                    (route == string(train["route_no"]) || route == string(train["additionalInfo1"]))
                        && (string(train["dest_ch"]) == dest.zh || string(train["dest_en"]).contains("Circular"))
                        && int(train["stop"]) == 0
                }
                .map { train -> ETA in
                    // "3 min" -> 3; "Arriving", "Departing" and "-" -> 0.
                    let minutes = Int(String(string(train["time_en"]).prefix(while: { $0.isASCII && $0.isNumber }))) ?? 0
                    let cars = String(repeating: "▭", count: max(0, int(train["train_length"]) ?? 0))
                    var zh = "\(platformID)號月台 - \(cars)"
                    var en = "Platform \(platformID) - \(cars)"
                    let remarkZh = string(train["routeRemarkChi2"])
                    let remarkEn = string(train["routeRemarkEng2"])
                    if !remarkZh.isEmpty { zh += " - \(remarkZh)" }
                    if !remarkEn.isEmpty { en += " - \(remarkEn)" }
                    return ETA(
                        date: now.addingTimeInterval(Double(minutes) * 60),
                        remark: Name(en: en, zh: zh),
                        dest: .empty,
                        co: .lightRail
                    )
                }
        }
    }

    static func parseMTR(_ data: Data, line: String, stopId: String, bound: String, stopList: [String: Stop]) throws -> [ETA] {
        let object = try json(data)
        if int(object["status"]) == 0 {
            let message = string(object["message"])
                .replacingOccurrences(of: "Please click here for more information.", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return message.isEmpty ? [] : [notice(message, co: .mtr)]
        }
        let station = (object["data"] as? [String: Any])?["\(line)-\(stopId)"] as? [String: Any]
        return rows(station?[bound.hasSuffix("UT") ? "UP" : "DOWN"]).map { train in
            let platform = string(train["plat"])
            return ETA(
                date: parseDate(string(train["time"])),
                remark: Name(en: "Platform \(platform)", zh: "\(platform)號月台"),
                dest: stopList[string(train["dest"])]?.name
                    ?? Name(en: string(train["dest"]), zh: string(train["dest"])),
                co: .mtr
            )
        }
    }

    // MARK: - Helpers

    static func parseDate(_ text: String) -> Date? {
        guard !text.isEmpty else { return nil }
        return isoFractional.date(from: text) ?? iso.date(from: text) ?? hongKongLocal.date(from: text)
    }

    private static let iso = ISO8601DateFormatter()

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// NLB and MTR return "yyyy-MM-dd HH:mm:ss" in Hong Kong time.
    private static let hongKongLocal: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Hong_Kong")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()

    private static func busETA(_ row: [String: Any], co: Operator) -> ETA {
        ETA(
            date: parseDate(string(row["eta"])),
            remark: Name(en: string(row["rmk_en"]), zh: string(row["rmk_tc"])),
            dest: Name(en: string(row["dest_en"]), zh: string(row["dest_tc"])),
            co: co
        )
    }

    private static func notice(_ message: String, co: Operator) -> ETA {
        ETA(date: nil, remark: Name(en: message, zh: message), dest: .empty, co: co)
    }

    /// Route data and the ETA feeds can disagree on sequence numbers, so use
    /// the rows whose sequence is closest to the requested stop.
    private static func nearestSeq(_ rows: [[String: Any]], to target: Int) -> [[String: Any]] {
        guard let best = rows.compactMap({ int($0["seq"]) }).min(by: { abs($0 - target) < abs($1 - target) }) else {
            return rows
        }
        return rows.filter { int($0["seq"]) == best }
    }

    private static func get(_ string: String) async throws -> Data {
        guard let url = URL(string: string) else { throw URLError(.badURL) }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return data
    }

    private static func json(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        return object
    }

    private static func rows(_ value: Any?) -> [[String: Any]] {
        value as? [[String: Any]] ?? []
    }

    private static func string(_ value: Any?) -> String {
        switch value {
        case let string as String: return string
        case let number as NSNumber: return number.stringValue
        default: return ""
        }
    }

    private static func int(_ value: Any?) -> Int? {
        Int(string(value))
    }

    private static func path(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }

    private static func query(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }
}
