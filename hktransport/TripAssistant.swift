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

/// One thing the rider asked for, from either the search bar or the AI box.
enum TripRequest: Equatable, Sendable {
    /// Top search bar. A nil origin means the current location.
    case search(origin: String?, destination: String, preference: TripPreference)
    /// AI box. `current` is the trip on screen, so "less walking" can refine it.
    case chat(String, current: TripIntent?)
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
        case .chat(let text, let current):
            guard let current else { return text }
            return """
            Current trip
            Start: \(current.origin ?? "current location")
            Destination: \(current.destination)
            Preference: \(current.preference.rawValue)
            Rider says: \(text)
            """
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
        case .chat(let text, let current):
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
        return DiscoveryRequest(want: want, searchTerms: isFood ? [want, "restaurant"] : [want])
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

/// Minimal client for DeepSeek's OpenAI-compatible chat completions API.
/// The AI only interprets the request and explains results; routes and
/// times always come from `RoutePlanner` and live ETAs.
struct DeepSeekClient: Sendable {
    static let defaultModel = "deepseek-flash"
    static let endpoint = URL(string: "https://api.deepseek.com/chat/completions")!

    let apiKey: String
    var model: String = DeepSeekClient.defaultModel

    struct APIError: LocalizedError, Equatable {
        let message: String
        var errorDescription: String? { message }
    }

    /// Reasoning counts towards `max_tokens`: with too small a limit the model
    /// spends it all thinking and the answer comes back empty.
    func complete(system: String, user: String, maxTokens: Int = 4_000, thinking: Bool = true) async throws -> String {
        var request = URLRequest(url: Self.endpoint, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "model": model,
            "messages": [
                ["role": "system", "content": system],
                ["role": "user", "content": user],
            ],
            "temperature": 0.2,
            "max_tokens": maxTokens,
            "stream": false,
            "thinking": ["type": thinking ? "enabled" : "disabled"],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        return try Self.parseCompletion(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    static func parseCompletion(_ data: Data, status: Int) throws -> String {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard status == 200 else {
            let detail = ((object?["error"] as? [String: Any])?["message"] as? String) ?? "HTTP \(status)"
            switch status {
            case 401: throw APIError(message: "DeepSeek API key is invalid (\(detail))")
            case 402: throw APIError(message: "DeepSeek account has insufficient balance (\(detail))")
            case 429: throw APIError(message: "DeepSeek rate limit reached (\(detail))")
            default: throw APIError(message: "DeepSeek error: \(detail)")
            }
        }
        let choices = object?["choices"] as? [[String: Any]]
        let message = choices?.first?["message"] as? [String: Any]
        if choices?.first?["finish_reason"] as? String == "length", (message?["content"] as? String)?.isEmpty != false {
            throw APIError(message: "DeepSeek ran out of tokens before answering")
        }
        guard let content = (message?["content"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !content.isEmpty else {
            throw APIError(message: "DeepSeek returned an empty answer")
        }
        return content
    }

    // MARK: Request interpretation

    func parseIntent(_ request: TripRequest) async throws -> TripIntent {
        let reply = try await complete(system: Self.intentPrompt, user: request.aiMessage, thinking: false)
        guard let intent = Self.decodeIntent(reply) else {
            throw APIError(message: "DeepSeek reply was not valid trip JSON")
        }
        return intent
    }

    func parseChat(_ request: TripRequest) async throws -> ChatReply {
        let reply = try await complete(system: Self.chatPrompt, user: request.aiMessage, thinking: false)
        guard let decoded = Self.decodeChat(reply) else {
            throw APIError(message: "DeepSeek reply was not valid trip JSON")
        }
        return decoded
    }

    static let chatPrompt = intentPrompt + """

    The rider may instead want to find a kind of place, such as food, a shop or something to do, without
    naming one place to go to. Then reply with this JSON object instead:
    {"kind": "discover", "want": string, "searchTerms": [string], "area": string or null, "areaOptions": [string]}
    - want is a short phrase in Traditional Chinese with typos fixed, e.g. 我想吃螺狮粉 -> 螺螄粉.
    - searchTerms are up to four Apple Maps search terms, most specific first. Apple Maps matches shop names
      and types, not menus, and many Hong Kong shops are listed in English. So start with the item itself,
      then short shop types in Chinese and English that would sell it, e.g. ["螺螄粉", "米線", "mixian", "noodles"]
      or ["拉麵", "ramen"].
    - area is the district or landmark the rider named, "附近" if they said nearby, otherwise null.
    - areaOptions are three or four Hong Kong districts where this kind of place is easy to find.
    - Going to a named place is still a trip, e.g. 去時代廣場 or 去理大.
    """

    /// A trip request, or a request to find somewhere.
    static func decodeChat(_ reply: String) -> ChatReply? {
        guard let object = jsonObject(in: reply), object["kind"] as? String == "discover" else {
            return decodeIntent(reply).map(ChatReply.trip)
        }
        guard let want = (object["want"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !want.isEmpty else { return nil }
        let terms = strings(object["searchTerms"])
        let area = (object["area"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return .discover(DiscoveryRequest(want: want, searchTerms: terms.isEmpty ? [want] : Array(terms.prefix(4)),
                                          area: area?.isEmpty == false ? area : nil,
                                          areaOptions: strings(object["areaOptions"])))
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

    /// Reads what the rider typed as the search area.
    func parseArea(_ text: String, want: String) async throws -> (area: String, extra: String?) {
        let reply = try await complete(system: Self.areaPrompt, user: "Looking for: \(want)\nRider says: \(text)", thinking: false)
        guard let object = Self.jsonObject(in: reply), let area = object["area"] as? String else {
            throw APIError(message: "DeepSeek reply was not valid area JSON")
        }
        let extra = (object["extra"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (area.trimmingCharacters(in: .whitespacesAndNewlines), extra?.isEmpty == false ? extra : nil)
    }

    static let areaPrompt = """
    A rider in Hong Kong is narrowing down where to look for a place. Reply with one JSON object and nothing else:
    {"area": string, "extra": string or null}
    - area is one district or landmark Apple Maps can find, in Traditional Chinese, without words such as 附近,
      e.g. 朗豪坊附近 -> 朗豪坊. Use "附近" when the rider means near them.
    - extra is any other wish in the message, e.g. 要平啲, otherwise null.
    """

    /// The AI's own recommendations. It can't browse, so these come from what it
    /// knows; `PlaceDiscovery.verify` checks each one on Apple Maps before it is shown.
    func suggestPlaces(want: String, area: String, extra: String?, language: Lang) async throws -> [AIPlace] {
        var lines = ["Looking for: \(want)", "Area: \(area)"]
        if let extra { lines.append("Also wants: \(extra)") }
        // Thinking made no difference to the shops named, took ten times as long and could run out of tokens.
        let reply = try await complete(system: Self.suggestPrompt(language), user: lines.joined(separator: "\n"), thinking: false)
        return Self.decodePlaces(reply)
    }

    static func suggestPrompt(_ language: Lang) -> String {
        let output = language == .zh ? "Write reasons in Traditional Chinese as used in Hong Kong." : "Write reasons in English."
        return """
        You recommend real shops in Hong Kong from your own knowledge.
        Reply with one JSON object and nothing else:
        {"places": [{"name": string, "nameEn": string, "reason": string}]}
        - Name 6 to 8 specific shops in or near the given area, best first. Every name is checked on a map
          afterwards and the ones not found are dropped, so give your best candidates rather than holding back.
        - Start with specialists and places people go to for exactly this. Chains are fine.
        - If few shops offer exactly this, fill the list with the closest alternatives, such as a 米線 or
          雲南 restaurant for someone who wants 螺螄粉, and say so in the reason.
        - name is the shop's Chinese name and nameEn its English name, as on its sign, without the branch.
        - Never make a shop up, and never give a generic description in place of a shop's name.
        - Each reason is one short sentence on why it fits. No invented ratings, prices or opening hours.
        \(output)
        """
    }

    static func decodePlaces(_ reply: String) -> [AIPlace] {
        let places = (jsonObject(in: reply)?["places"] as? [[String: Any]]) ?? []
        return places.compactMap { place in
            func text(_ key: String) -> String? {
                let value = (place[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                return value?.isEmpty == false ? value : nil
            }
            guard let name = text("name") ?? text("nameEn") else { return nil }
            return AIPlace(name: name, nameEn: text("nameEn"), reason: text("reason"))
        }
    }

    /// Picks from `places` only; anything else the AI names is dropped.
    func recommend(_ places: [PlaceCandidate], want: String, extra: String?, language: Lang) async throws -> [PlaceSuggestion] {
        let reply = try await complete(system: Self.recommendPrompt(language),
                                       user: Self.placeList(places, want: want, extra: extra), thinking: false)
        return Self.decodePicks(reply, from: places)
    }

    static func recommendPrompt(_ language: Lang) -> String {
        let output = language == .zh ? "Write reasons in Traditional Chinese as used in Hong Kong." : "Write reasons in English."
        return """
        You help a rider in Hong Kong choose from real places found on Apple Maps.
        Reply with one JSON object and nothing else: {"picks": [{"index": number, "reason": string}]}
        - Choose up to \(PlaceDiscovery.maxSuggestions) places that best match what the rider wants, best first.
        - Use only the numbered places given, and leave out any that clearly don't match.
        - Places are listed nearest first.
        - Each reason is one short sentence based only on the listed name, category and position in the list.
          Never invent ratings, prices, opening hours, dishes or reviews.
        - Apple Maps has no menus. Unless a place's name shows it, never say it sells what the rider wants:
          say it is the closest kind of shop, e.g. a 米線 shop for someone who wants 螺螄粉.
        \(output)
        """
    }

    /// Names and categories only: no coordinates and no distances from the rider.
    static func placeList(_ places: [PlaceCandidate], want: String, extra: String?) -> String {
        var lines = ["Looking for: \(want)"]
        if let extra { lines.append("Also wants: \(extra)") }
        for (index, place) in places.enumerated() {
            lines.append("\(index). \(place.name) | \(place.category) | \(place.address)")
        }
        return lines.joined(separator: "\n")
    }

    static func decodePicks(_ reply: String, from places: [PlaceCandidate]) -> [PlaceSuggestion] {
        var seen = Set<Int>()
        let picks = (jsonObject(in: reply)?["picks"] as? [[String: Any]]) ?? []
        let suggestions = picks.compactMap { pick -> PlaceSuggestion? in
            guard let index = (pick["index"] as? NSNumber)?.intValue, places.indices.contains(index),
                  seen.insert(index).inserted else { return nil }
            let reason = (pick["reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return PlaceSuggestion(place: places[index], reason: reason?.isEmpty == false ? reason : nil)
        }
        return Array(suggestions.prefix(PlaceDiscovery.maxSuggestions))
    }

    static let intentPrompt = """
    You turn Hong Kong public transport trip requests into JSON for a route planner.
    Reply with one JSON object and nothing else:
    {"origin": string or null, "destination": string, "preference": "fastest" | "fewerTransfers" | "lessWalking"}
    Rules:
    - origin is null when the rider starts from their current location or does not say where they start.
    - A "Search form" message gives the Start and Destination the rider typed: clean up each one, and keep
      the Preference unless the typed text asks for something else.
    - A "Current trip" message is what is on screen, and "Rider says" is the follow-up: change only what the
      rider mentions and keep everything else, e.g. "少行路" keeps both places, "改去機場" keeps the start.
    - "current location" as a Start means origin is null.
    - Expand nicknames and abbreviations into full place names that Apple Maps can find in Hong Kong,
      in Traditional Chinese. Examples: 理大 -> 香港理工大學, 中大 -> 香港中文大學, 港大 -> 香港大學,
      機場 -> 香港國際機場一號客運大樓, 尖東 -> 尖沙咀東, 銅鑼灣時代廣場 -> 時代廣場.
    - Keep MTR station names as station names, e.g. 旺角, 九龍塘.
    - preference is fewerTransfers when the rider wants no or few changes, lessWalking when they want to
      walk less, otherwise fastest.
    - Never suggest routes, times or fares.
    """

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

    // MARK: Explanation

    func explain(_ summary: String, language: Lang) async throws -> String {
        try await complete(system: Self.explanationPrompt(language), user: summary, thinking: false)
    }

    static func explanationPrompt(_ language: Lang) -> String {
        let output = language == .zh
            ? "Write in Traditional Chinese as used in Hong Kong."
            : "Write in English."
        return """
        You help a rider in Hong Kong choose between public transport options computed by a route planner.
        In one or two short sentences, recommend the best option for the rider's preference and say why.
        Use only the facts given. Do not invent routes, stops, times or fares.
        When an option's first departure is marked live, you may mention that it is based on real-time arrivals.
        \(output) No Markdown, no lists.
        """
    }

    /// A compact, coordinate-free description of the options for the AI.
    /// Only route numbers, stop names and minutes leave the device.
    static func summary(of journeys: [Journey], preference: TripPreference, now: Date, language: Lang = .en,
                        stopName: (String) -> String) -> String {
        var lines = ["Rider preference: \(preference.rawValue)"]
        for (index, journey) in journeys.enumerated() {
            let arrival = Int((journey.arrival.timeIntervalSince(now) / 60).rounded())
            var parts = ["Option \(index + 1): \(Int(journey.totalMinutes.rounded())) min total, arrives in \(arrival) min, " +
                         "\(journey.transfers) transfer(s), \(Int(journey.walkingMeters)) m walking."]
            for leg in journey.legs {
                switch leg {
                case .walk(_, let minutes, let to):
                    parts.append("Walk \(Int(minutes.rounded())) min to \(to.map(stopName) ?? "destination").")
                case .ride(let ride):
                    let wait: String
                    if let live = ride.liveDeparture {
                        let minutes = max(0, Int((live.timeIntervalSince(now) / 60).rounded()))
                        wait = "\(ride.isProjected ? "projected from the live headway" : "live"): departs in \(minutes) min"
                    } else {
                        wait = "estimate, no live data: wait about \(Int(ride.waitMinutes.rounded())) min"
                    }
                    parts.append("\(ride.op.label) \(ride.op.lineName(ride.route).text(language)) from \(stopName(ride.boardStopID)) to " +
                                 "\(stopName(ride.alightStopID)), \(ride.stopCount) stops, " +
                                 "\(Int(ride.rideMinutes.rounded())) min on board (\(wait)).")
                }
            }
            lines.append(parts.joined(separator: " "))
        }
        return lines.joined(separator: "\n")
    }
}
