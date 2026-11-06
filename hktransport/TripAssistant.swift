import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What the rider asked for, before any place has been located.
struct TripIntent: Equatable, Sendable {
    /// nil means "from my current location".
    var origin: String?
    var destination: String
    var preference: TripPreference = .fastest
}

/// What the AI needs to tell a follow-up from a new subject.
struct ChatContext: Equatable, Sendable {
    struct Search: Equatable, Sendable {
        var want: String
        var query: String
        var area: String?
        var extra: String?
        var shops: [String] = []
    }

    var talk: [String] = []
    var search: Search?
    /// What the AI just asked the rider.
    var question: String?
    var mayAsk = true

    func message(_ text: String, current: TripIntent?) -> String {
        var lines: [String] = []
        if !talk.isEmpty { lines += ["Conversation so far"] + talk + [""] }
        if let current {
            lines += ["Current trip", "Start: \(current.origin ?? "current location")", "Destination: \(current.destination)",
                      "Preference: \(current.preference.rawValue)", ""]
        }
        if let search {
            lines += ["Current search", "Looking for: \(search.want)", "Query: \(search.query)"]
            if let area = search.area { lines.append("Area: \(area)") }
            if let extra = search.extra { lines.append("Also wants: \(extra)") }
            if !search.shops.isEmpty {
                lines += ["Shops on screen:"] + search.shops.enumerated().map { "\($0.offset + 1). \($0.element)" }
            }
            lines.append("")
        }
        if let question { lines.append("You just asked: \(question)") }
        if !mayAsk { lines.append("You may not ask anything more, so question must be null.") }
        return lines.isEmpty ? text : (lines + ["Rider says: \(text)"]).joined(separator: "\n")
    }
}

/// One thing the rider asked for, from either the search bar or the AI box.
enum TripRequest: Equatable, Sendable {
    /// Top search bar. A nil origin means the current location.
    case search(origin: String?, destination: String, preference: TripPreference)
    /// AI box. `current` is the trip on screen, so "less walking" can refine it.
    case chat(String, current: TripIntent?, context: ChatContext = ChatContext())
    /// A place picked from the recommendations; its position is already known.
    case place(ResolvedPlace, origin: String?, preference: TripPreference)

    /// Only typed text and place names; never coordinates.
    var aiMessage: String {
        switch self {
        case .search(let origin, let destination, let preference):
            return """
            Search form
            Start: \(origin ?? "current location")
            Destination: \(destination)
            Preference: \(preference.rawValue)
            """
        case .chat(let text, let current, let context):
            return context.message(text, current: current)
        case .place(let place, _, _):
            return place.name
        }
    }

    /// Used without an API key, or when the AI call fails.
    var offlineIntent: TripIntent? {
        switch self {
        case .search(let origin, let destination, let preference):
            let destination = destination.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !destination.isEmpty else { return nil }
            return TripIntent(origin: TripIntentParser.normalizedOrigin(origin), destination: destination,
                              preference: preference)
        case .chat(let text, let current, _):
            return TripIntentParser.parse(text, current: current)
        case .place(let place, let origin, let preference):
            return TripIntent(origin: TripIntentParser.normalizedOrigin(origin), destination: place.name,
                              preference: preference)
        }
    }
}

// MARK: - Offline parser

/// Rule-based fallback used without an API key, or when the AI call fails.
/// Understands "由A去B", "A到B", "去B", "from A to B" and a few preferences.
enum TripIntentParser {
    private static let fewerTransfersWords = ["唔想轉車", "不想轉車", "唔轉車", "不轉車", "少轉車", "少啲轉車", "直達",
                                              "fewer transfers", "no transfers", "no transfer", "direct"]
    private static let lessWalkingWords = ["唔想行", "少行路", "少啲行", "少行", "不想走路", "少走路",
                                           "less walking", "walk less"]
    private static let fillerWords = ["點樣去", "點去", "怎麼去", "怎樣去", "如何去", "嘅路線", "的路線", "搭咩車", "坐咩車",
                                      "坐什麼車", "坐甚麼車", "最快", "快啲", "請問", "我想", "我要", "fastest", "quickest",
                                      "how do i get there", "how to get there", "please"]
    private static let hereWords: Set<String> = ["呢度", "這裡", "這裏", "这里", "我的位置", "目前位置", "現在位置", "而家位置",
                                                "here", "my location", "current location"]

    static func parse(_ text: String) -> TripIntent? {
        var working = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !working.isEmpty else { return nil }

        var preference = TripPreference.fastest
        if contains(working, any: fewerTransfersWords) {
            preference = .fewerTransfers
        } else if contains(working, any: lessWalkingWords) {
            preference = .lessWalking
        }
        for word in fewerTransfersWords + lessWalkingWords + fillerWords {
            working = working.replacingOccurrences(of: word, with: " ", options: .caseInsensitive)
        }
        working = working.trimmingCharacters(in: CharacterSet(charactersIn: " ，,。.？?！!～~、"))

        let separator = #"(?:去|到|往|至|→|->|\s+to\s+)"#
        if let groups = match(#"^(?:由|從|从|from\s+)\s*(.+?)\s*"# + separator + #"\s*(.+)$"#, working) {
            return intent(origin: groups[0], destination: groups[1], preference: preference)
        }
        if let groups = match(#"^(?:去|到|往|to\s+)\s*(.+)$"#, working) {
            return intent(origin: nil, destination: groups[0], preference: preference)
        }
        if let groups = match(#"^(.+?)\s*"# + separator + #"\s*(.+)$"#, working) {
            return intent(origin: groups[0], destination: groups[1], preference: preference)
        }
        return intent(origin: nil, destination: working, preference: preference)
    }

    private static let discoveryPrefixes = ["我想吃", "我想食", "我要吃", "我要食", "想吃", "想食", "想喝", "想飲",
                                            "我想買", "想買", "我想搵", "想搵", "附近有冇", "附近有什麼", "附近有甚麼", "附近有咩",
                                            "i want to eat", "i want", "looking for", "find me", "craving"]

    /// "我想吃螺螄粉" without the AI: the words after the wish are the search.
    static func discovery(_ text: String) -> DiscoveryRequest? {
        let working = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let prefix = discoveryPrefixes.first(where: { working.lowercased().hasPrefix($0) }) else { return nil }
        let want = String(working.dropFirst(prefix.count))
            .trimmingCharacters(in: CharacterSet(charactersIn: " ，,。.？?！!～~、"))
        guard !want.isEmpty else { return nil }
        // Apple Maps knows shops, not dishes, so food also falls back to restaurants.
        let isFood = ["吃", "食", "eat"].contains { prefix.contains($0) }
        return DiscoveryRequest(want: want, query: want, searchTerms: isFood ? [want, "restaurant"] : [want])
    }

    /// Without the AI, whatever isn't plainly a trip is searched for as typed.
    static func search(_ text: String) -> DiscoveryRequest? {
        let want = text.trimmingCharacters(in: CharacterSet(charactersIn: " ，,。.？?！!～~、"))
        guard !want.isEmpty, !contains(want, any: fewerTransfersWords + lessWalkingWords),
              want.range(of: #"[去到往至由從从→]|->|\b(to|from)\b"#, options: [.regularExpression, .caseInsensitive]) == nil
        else { return nil }
        return DiscoveryRequest(want: want, query: want, searchTerms: [want])
    }

    /// Applies a follow-up to the trip on screen: anything not mentioned stays.
    static func parse(_ text: String, current: TripIntent?) -> TripIntent? {
        guard let current else { return parse(text) }
        let preference = contains(text, any: fewerTransfersWords) ? TripPreference.fewerTransfers
            : contains(text, any: lessWalkingWords) ? .lessWalking : current.preference
        guard var intent = parse(text) else {
            // Only a preference was left, e.g. "少行路".
            return contains(text, any: fewerTransfersWords + lessWalkingWords)
                ? TripIntent(origin: current.origin, destination: current.destination, preference: preference)
                : nil
        }
        intent.preference = preference
        if intent.origin == nil, !contains(text, any: Array(hereWords)) {
            intent.origin = current.origin
        }
        return intent
    }

    static func isCurrentLocation(_ text: String) -> Bool {
        hereWords.contains(text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    /// Treats "here", "我的位置" and similar as the current location.
    static func normalizedOrigin(_ origin: String?) -> String? {
        guard let origin = origin?.trimmingCharacters(in: .whitespacesAndNewlines), !origin.isEmpty,
              !hereWords.contains(origin.lowercased()) else { return nil }
        return origin
    }

    private static func intent(origin: String?, destination: String, preference: TripPreference) -> TripIntent? {
        let destination = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !destination.isEmpty else { return nil }
        return TripIntent(origin: normalizedOrigin(origin), destination: destination, preference: preference)
    }

    private static func contains(_ text: String, any words: [String]) -> Bool {
        words.contains { text.range(of: $0, options: .caseInsensitive) != nil }
    }

    private static func match(_ pattern: String, _ text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let result = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        let groups = (1..<result.numberOfRanges).compactMap { index -> String? in
            Range(result.range(at: index), in: text).map { String(text[$0]) }
        }
        return groups.count == result.numberOfRanges - 1 ? groups : nil
    }
}

// MARK: - DeepSeek

/// What a message in the AI box turned out to be.
enum ChatReply: Equatable, Sendable {
    case trip(TripIntent)
    case discover(DiscoveryRequest)
}

/// The AI, reached through the hktransport server. The prompts and the key stay there, and
/// the server holds every rider to the daily spending limits.
struct DeepSeekClient: Sendable {
    static let site = "https://hk.52-220-124-215.sslip.io"
    private static let longestMessage = 3_900

    struct APIError: LocalizedError, Equatable {
        let message: String
        var errorDescription: String? { message }
    }

    /// `task` names one of the server's prompts; a prompt is never sent from here.
    func complete(task: String, message: String) async throws -> String {
        var request = URLRequest(url: URL(string: "\(Self.site)/api/ai")!, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue(Self.site, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["task": task, "message": String(message.prefix(Self.longestMessage))])
        let (data, response) = try await URLSession.shared.data(for: request)
        return try Self.parseReply(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    static func parseReply(_ data: Data, status: Int) throws -> String {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard status == 200 else { throw APIError(message: (object?["error"] as? String)?.forScript ?? "HTTP \(status)") }
        guard let reply = (object?["reply"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !reply.isEmpty else {
            throw APIError(message: "AI returned an empty answer")
        }
        return reply
    }

    // MARK: Request interpretation

    func parseIntent(_ request: TripRequest) async throws -> TripIntent {
        guard let intent = Self.decodeIntent(try await complete(task: "intent", message: request.aiMessage)) else {
            throw APIError(message: "AI reply was not valid trip JSON")
        }
        return intent
    }

    func parseChat(_ request: TripRequest) async throws -> ChatReply {
        guard let decoded = Self.decodeChat(try await complete(task: "chat", message: request.aiMessage)) else {
            throw APIError(message: "AI reply was not valid trip JSON")
        }
        return decoded
    }

    /// A trip request, or a request to find somewhere.
    static func decodeChat(_ reply: String) -> ChatReply? {
        guard let object = jsonObject(in: reply), object["kind"] as? String == "discover" else {
            return decodeIntent(reply).map(ChatReply.trip)
        }
        func text(_ key: String) -> String? {
            let value = (object[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return value?.isEmpty == false ? value : nil
        }
        guard let want = text("want") else { return nil }
        let terms = strings(object["searchTerms"]), question = text("question")
        return .discover(DiscoveryRequest(want: want, query: text("query") ?? want, queryEn: text("queryEn"),
                                          searchTerms: terms.isEmpty ? [want] : Array(terms.prefix(4)),
                                          area: text("area"), extra: text("extra"), question: question,
                                          options: question == nil ? [] : Array(strings(object["options"]).prefix(4))))
    }

    private static func strings(_ value: Any?) -> [String] {
        ((value as? [Any]) ?? []).compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func jsonObject(in reply: String) -> [String: Any]? {
        guard let start = reply.firstIndex(of: "{"), let end = reply.lastIndex(of: "}"), start < end else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(reply[start...end].utf8))) as? [String: Any]
    }

    // MARK: Finding places

    /// Puts every place found in order, best first, with reasons for the top few.
    func rank(_ places: [PlaceCandidate], for request: DiscoveryRequest, language: Lang) async throws -> [PlaceSuggestion] {
        let reply = try await complete(task: language == .zh ? "rank_zh" : "rank_en", message: Self.rankMessage(places, for: request))
        return Self.applyRanking(reply, to: places)
    }

    /// Names, kinds and distances only: no coordinates.
    static func rankMessage(_ places: [PlaceCandidate], for request: DiscoveryRequest) -> String {
        var lines = ["Rider wants: \(request.want)"]
        if let extra = request.extra { lines.append("Also wants: \(extra)") }
        lines.append("Shops:")
        for (index, place) in places.enumerated() {
            lines.append("\(index + 1). \(place.name): \(place.category); \(Int(place.meters)) m away")
        }
        return lines.joined(separator: "\n")
    }

    /// The AI's order. A number it skips or repeats can't lose or double a shop.
    static func applyRanking(_ reply: String, to places: [PlaceCandidate]) -> [PlaceSuggestion] {
        var used = Set<Int>(), ranked: [PlaceSuggestion] = []
        for item in (jsonObject(in: reply)?["ranking"] as? [[String: Any]]) ?? [] {
            guard let number = (item["number"] as? NSNumber)?.intValue, places.indices.contains(number - 1),
                  used.insert(number - 1).inserted else { continue }
            let reason = (item["reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ranked.append(PlaceSuggestion(place: places[number - 1], reason: reason?.isEmpty == false ? reason?.forScript : nil))
        }
        return ranked + places.indices.filter { !used.contains($0) }.map { PlaceSuggestion(place: places[$0], reason: nil) }
    }

    /// Accepts bare JSON or JSON inside a Markdown code fence.
    static func decodeIntent(_ reply: String) -> TripIntent? {
        guard let start = reply.firstIndex(of: "{"), let end = reply.lastIndex(of: "}"), start < end,
              let object = try? JSONSerialization.jsonObject(with: Data(reply[start...end].utf8)) as? [String: Any],
              let destination = (object["destination"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !destination.isEmpty else { return nil }
        let preference = (object["preference"] as? String).flatMap(TripPreference.init(rawValue:)) ?? .fastest
        return TripIntent(origin: TripIntentParser.normalizedOrigin(object["origin"] as? String),
                          destination: destination, preference: preference)
    }
}

extension Journey {
    private static let sameWalkMeters = 100

    /// Why the first option is on top, from its own numbers. Only a real-time departure is mentioned as one.
    static func advice(_ journeys: [Journey], language: Lang, now: Date) -> String? {
        guard let best = journeys.first else { return nil }
        func t(_ zh: String, _ en: String) -> String { language.pick(zh, en) }
        let minutes = Int(best.totalMinutes.rounded()), changes = best.transfers, walk = Int(best.walkingMeters.rounded())
        var lines = [t("建議第一個方案：全程 \(minutes) 分鐘，\(changes > 0 ? "轉 \(changes) 次車" : "直達")，步行 \(walk) 米。",
                       "Best option: \(minutes) min, \(changes > 0 ? "\(changes) change\(changes > 1 ? "s" : "")" : "direct"), \(walk) m on foot.")]
        if let first = best.rides.first, let live = first.liveDeparture, !first.isProjected {
            let wait = max(0, Int(live.timeIntervalSince(now) / 60)), line = first.op.lineName(first.route).text(language)
            lines.append(wait > 0 ? t("\(line) \(wait) 分鐘後開出。", "\(line) leaves in \(wait) min.") : t("\(line) 即將開出。", "\(line) is leaving now."))
        }
        if journeys.count > 1 {
            let next = journeys[1]
            let faster = Int(next.totalMinutes.rounded()) - minutes, fewer = next.transfers - changes
            let less = Int(next.walkingMeters.rounded()) - walk
            var differences: [String] = []
            if faster > 0 { differences.append(t("快 \(faster) 分鐘", "\(faster) min faster")) }
            if faster < 0 { differences.append(t("慢 \(-faster) 分鐘", "\(-faster) min slower")) }
            if fewer > 0 { differences.append(t("少轉 \(fewer) 次車", "\(fewer) fewer change\(fewer > 1 ? "s" : "")")) }
            if fewer < 0 { differences.append(t("多轉 \(-fewer) 次車", "\(-fewer) more change\(fewer < -1 ? "s" : "")")) }
            if less >= sameWalkMeters { differences.append(t("少行 \(less) 米", "\(less) m less walking")) }
            if less <= -sameWalkMeters { differences.append(t("多行 \(-less) 米", "\(-less) m more walking")) }
            if !differences.isEmpty {
                lines.append(t("比第二個方案\(differences.joined(separator: "、"))。", "Against the next option: \(differences.joined(separator: ", "))."))
            }
        }
        return lines.joined(separator: t("", " ")).forScript
    }
}
