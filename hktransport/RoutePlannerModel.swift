import CoreLocation
import Foundation
import MapKit

struct ResolvedPlace: Equatable, Sendable {
    let name: String
    let location: StopLocation
}

/// Turns a place name into coordinates: MTR station names first (exact and
/// offline), then Apple Maps, then any stop whose name contains the text.
enum PlaceResolver {
    static func isInHongKong(_ location: StopLocation) -> Bool {
        (22.13...22.58).contains(location.lat) && (113.82...114.45).contains(location.lng)
    }

    /// The first Apple Maps result inside Hong Kong.
    static func appleMaps(_ text: String) async -> ResolvedPlace? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = text
        request.resultTypes = [.pointOfInterest, .address]
        request.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 22.35, longitude: 114.13),
            span: MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 0.6)
        )
        guard let response = try? await MKLocalSearch(request: request).start() else { return nil }
        for item in response.mapItems {
            let coordinate = item.placemark.coordinate
            let location = StopLocation(lat: coordinate.latitude, lng: coordinate.longitude)
            if isInHongKong(location) {
                return ResolvedPlace(name: item.name ?? text, location: location)
            }
        }
        return nil
    }

    @MainActor
    static func resolve(_ query: String, db: TransportDB, network: TransitNetwork,
                        language: Lang) async -> ResolvedPlace? {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }

        if let station = station(named: text, db: db, network: network, language: language) {
            return station
        }

        if let place = await appleMaps(text) {
            // Apple Maps answers in the system language, not the app's.
            return language == .zh ? ResolvedPlace(name: text, location: place.location) : place
        }

        return stop(containing: text, db: db, network: network, language: language)
    }

    /// "旺角", "旺角站", "Mong Kok", "Mong Kok Station" -> MOK.
    static func station(named text: String, db: TransportDB, network: TransitNetwork,
                        language: Lang) -> ResolvedPlace? {
        let wanted = normalize(text)
        for (index, id) in network.stopIDs.enumerated() where network.isStation[index] {
            guard let name = db.stopList[id]?.name else { continue }
            if normalize(name.zh) == wanted || normalize(name.en) == wanted {
                return ResolvedPlace(name: name.text(language), location: network.locations[index])
            }
        }
        return nil
    }

    static func stop(containing text: String, db: TransportDB, network: TransitNetwork,
                     language: Lang) -> ResolvedPlace? {
        let wanted = text.lowercased()
        guard wanted.count >= 2 else { return nil }
        for (index, id) in network.stopIDs.enumerated() {
            guard let name = db.stopList[id]?.name,
                  name.zh.contains(text) || name.en.lowercased().contains(wanted) else { continue }
            return ResolvedPlace(name: RoutePlannerModel.cleanStopName(name.text(language)),
                                 location: network.locations[index])
        }
        return nil
    }

    static func normalize(_ text: String) -> String {
        var value = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        for suffix in ["港鐵站", "站", " station", " mtr"] where value.hasSuffix(suffix) && value.count > suffix.count {
            value.removeLast(suffix.count)
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Live ETA lookups shared by all candidate journeys of one plan, so a stop
/// that appears in several options is only requested once.
actor LiveArrivalCache {
    private var tasks: [String: Task<[LiveDeparture]?, Never>] = [:]
    private let db: TransportDB
    private let language: Lang

    init(db: TransportDB, language: Lang) {
        self.db = db
        self.language = language
    }

    func arrivals(for ride: PlannedRide) async -> [LiveDeparture]? {
        let key = "\(ride.routeKey)|\(ride.op.rawValue)|\(ride.boardPosition)|\(ride.alightPosition)"
        if let task = tasks[key] { return await task.value }
        let db = self.db, language = self.language
        let task = Task<[LiveDeparture]?, Never> { await Self.fetch(ride, db: db, language: language) }
        tasks[key] = task
        return await task.value
    }

    /// False for a train that ends before the rider's stop or takes the other
    /// branch, e.g. a Tai Po Market short working for someone going to Sheung Shui.
    static func train(to terminus: Name, serves ride: PlannedRide, db: TransportDB) -> Bool {
        guard ride.op == .mtr else { return true }
        var isKnown = false
        for route in db.routeList.values where route.route == ride.route {
            guard let ids = route.stops[ride.op.rawValue],
                  let end = ids.firstIndex(where: { db.stopList[$0]?.name == terminus }) else { continue }
            isKnown = true
            if let board = ids.firstIndex(of: ride.boardStopID), let alight = ids.firstIndex(of: ride.alightStopID),
               board < alight, alight <= end {
                return true
            }
        }
        // A terminus the database has never heard of is no reason to drop a train.
        return !isKnown
    }

    private static func fetch(_ ride: PlannedRide, db: TransportDB, language: Lang) async -> [LiveDeparture]? {
        // Joint routes number stops per operator, so ask the operator we planned with.
        guard let full = db.routeList[ride.routeKey], let ids = full.stops[ride.op.rawValue] else { return nil }
        let route = Route(route: full.route, co: [ride.op.rawValue], orig: full.orig, dest: full.dest,
                          serviceType: full.serviceType, stops: [ride.op.rawValue: ids],
                          bound: [ride.op.rawValue: full.bound[ride.op.rawValue] ?? ""],
                          gtfsId: full.gtfsId, nlbId: full.nlbId)
        guard let etas = try? await ETAService.fetch(route: route, seq: ride.boardPosition,
                                                     stopList: db.stopList, language: language) else { return nil }
        let departures = etas.compactMap { eta -> LiveDeparture? in
            guard let date = eta.date, train(to: eta.dest, serves: ride, db: db) else { return nil }
            return LiveDeparture(date: date, platform: ride.op == .mtr ? eta.remark : nil)
        }
        return departures.isEmpty ? nil : departures
    }
}

@MainActor
final class RoutePlannerModel: ObservableObject {
    /// Shared because the panel is rebuilt every time the notch opens.
    static let shared = RoutePlannerModel()

    /// Asked only when a trip actually starts or ends at the current location.
    typealias LocationSource = @MainActor () async -> CLLocation?

    enum Phase: Equatable {
        case idle, understanding, findingPlaces, locating, planning, checkingLive, done
        case failed(String)
    }

    /// Empty means "start from my current location".
    @Published var originText = ""
    @Published var destinationText = ""
    @Published var chatText = ""
    /// The rider's last message in the AI box.
    @Published private(set) var lastChat: String?
    /// Set while the AI box is helping to find somewhere to go.
    @Published private(set) var discovery: DiscoveryStage?
    /// Replaced in tests; real searches go to Apple Maps.
    var placeSearch: PlaceDiscovery.Searcher = { await PlaceDiscovery.appleMaps(term: $0, center: $1, radius: $2) }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var origin: ResolvedPlace?
    @Published private(set) var destination: ResolvedPlace?
    @Published private(set) var preference: TripPreference = .fastest
    @Published private(set) var journeys: [Journey] = []
    @Published private(set) var explanation: String?
    @Published private(set) var isExplaining = false
    /// Set when the AI was configured but could not be used for this plan.
    @Published private(set) var aiNotice: String?
    @Published private(set) var usedAI = false

    private var network: TransitNetwork?
    private var buildingNetwork: (id: UUID, task: Task<TransitNetwork, Never>)?
    private var planTask: Task<Void, Never>?
    /// The last few exchanges, so a short follow-up can be read in context.
    private var talk: [String] = []
    private var questionsAsked = 0
    private static let mostTalk = 8
    private static let mostQuestions = 2

    var hasInput: Bool {
        !originText.isEmpty || !destinationText.isEmpty || !chatText.isEmpty || !journeys.isEmpty
    }

    var isBusy: Bool {
        switch phase {
        case .understanding, .findingPlaces, .locating, .planning, .checkingLive: return true
        default: return false
        }
    }

    /// Builds the routing network in the background before the first search.
    func prepare(db: TransportDB) {
        Task { _ = await routingNetwork(for: db) }
    }

    func reset() {
        planTask?.cancel()
        originText = ""
        destinationText = ""
        chatText = ""
        lastChat = nil
        discovery = nil
        phase = .idle
        origin = nil
        destination = nil
        journeys = []
        explanation = nil
        aiNotice = nil
        talk = []
        questionsAsked = 0
    }

    /// Re-sorts the current options without searching again.
    func setPreference(_ preference: TripPreference) {
        self.preference = preference
        journeys.sort { preference.score($0) < preference.score($1) }
    }

    /// Swaps the ends like a navigation app; an empty start is the current location.
    func swapEnds(language: Lang) {
        let start = originText.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = destinationText.trimmingCharacters(in: .whitespacesAndNewlines)
        originText = TripIntentParser.isCurrentLocation(end) ? "" : end
        destinationText = start.isEmpty ? language.pick("我的位置", "My location") : start
    }

    /// Plans what the top search bar says.
    func search(db: TransportDB, language: Lang, currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        let start = originText.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = destinationText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !end.isEmpty else { return }
        let origin = TripIntentParser.normalizedOrigin(start)
        discovery = nil
        begin(.search(origin: origin, destination: end, preference: preference),
              db: db, language: language, currentLocation: currentLocation, ai: ai)
    }

    /// Sends the AI box. The answer also fills in the search bar.
    func sendChat(db: TransportDB, language: Lang, currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        let text = chatText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let end = destinationText.trimmingCharacters(in: .whitespacesAndNewlines)
        let current = end.isEmpty ? nil : TripIntent(origin: TripIntentParser.normalizedOrigin(originText),
                                                     destination: end, preference: preference)
        let context = chatContext()
        chatText = ""
        lastChat = text
        remember("Rider: \(text)")
        begin(.chat(text, current: current, context: context), db: db, language: language, currentLocation: currentLocation, ai: ai)
    }

    private func remember(_ line: String) {
        talk = Array((talk + [line]).suffix(Self.mostTalk))
    }

    private func chatContext() -> ChatContext {
        var context = ChatContext(talk: talk, mayAsk: questionsAsked < Self.mostQuestions)
        switch discovery {
        case .asking(let request):
            context.question = request.question
            context.search = .init(want: request.want, query: request.query, area: request.area, extra: request.extra)
        case .choosing(let request, _, let suggestions):
            context.search = .init(want: request.want, query: request.query, area: request.area, extra: request.extra,
                                   shops: suggestions.prefix(10).map(\.place.name))
        case nil:
            break
        }
        return context
    }

    /// Plans a route to a recommended place, keeping the list to come back to.
    func choosePlace(_ suggestion: PlaceSuggestion, db: TransportDB, language: Lang,
                     currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        destinationText = suggestion.place.name
        let place = ResolvedPlace(name: suggestion.place.name, location: suggestion.place.location)
        begin(.place(place, origin: TripIntentParser.normalizedOrigin(originText), preference: preference),
              db: db, language: language, currentLocation: currentLocation, ai: ai)
    }

    /// Plans a route to a known place, such as a stop from the stop search.
    func route(to place: ResolvedPlace, db: TransportDB, language: Lang,
               currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        discovery = nil
        originText = ""
        destinationText = place.name
        begin(.place(place, origin: nil, preference: preference),
              db: db, language: language, currentLocation: currentLocation, ai: ai)
    }

    /// The recommendations to show, once no route is on screen.
    var visibleSuggestions: [PlaceSuggestion]? {
        guard case .choosing(_, _, let suggestions) = discovery, journeys.isEmpty, !isRouting else { return nil }
        return suggestions
    }

    private var isRouting: Bool {
        switch phase {
        case .locating, .planning, .checkingLive: return true
        default: return false
        }
    }

    func backToSuggestions() {
        planTask?.cancel()
        journeys = []
        origin = nil
        destination = nil
        explanation = nil
        destinationText = ""
        phase = .idle
    }

    func cancelDiscovery() {
        planTask?.cancel()
        discovery = nil
        phase = .idle
    }

    private func discover(_ request: DiscoveryRequest, db: TransportDB, language: Lang,
                          currentLocation: @escaping LocationSource, ai: DeepSeekClient?) async {
        func t(_ zh: String, _ en: String) -> String { language.pick(zh, en) }
        phase = .findingPlaces

        // 1. Where to look: the place named, or 5 km around the rider.
        let place = request.area.map(PlaceDiscovery.cleanArea) ?? ""
        let searchArea: SearchArea
        if PlaceDiscovery.isNearby(place) {
            guard let fix = await currentLocation() else {
                discovery = nil
                phase = .failed(t("未能取得你的位置，請說明想在哪一區找。", "Couldn't get your location. Say which area to search."))
                return
            }
            searchArea = SearchArea(name: t("5 公里內", "Within 5 km"), radius: PlaceDiscovery.nearbyRadius,
                                    center: StopLocation(lat: fix.coordinate.latitude, lng: fix.coordinate.longitude))
        } else {
            let network = await routingNetwork(for: db)
            guard let resolved = await PlaceResolver.resolve(place, db: db, network: network, language: language) else {
                discovery = nil
                phase = .failed(t("找不到「\(place)」，請換一個範圍。", "Couldn't find \"\(place)\". Try another area."))
                return
            }
            searchArea = SearchArea(name: resolved.name, radius: PlaceDiscovery.areaRadius, center: resolved.location)
        }
        guard !Task.isCancelled else { return }

        // 2. Apple Maps finds the places, so everything shown is really there.
        var results: [[PlaceCandidate]] = []
        for term in request.allTerms {
            results.append(await placeSearch(term, searchArea.center, searchArea.radius))
        }
        guard !Task.isCancelled else { return }
        let places = PlaceDiscovery.merge(results, in: searchArea)
        guard !places.isEmpty else {
            discovery = nil
            phase = .failed(t("\(searchArea.name)找不到\(request.want)，請換一個範圍。",
                              "Couldn't find \(request.want) around \(searchArea.name). Try another area."))
            return
        }

        // 3. The AI puts them in order and says why. Past its limit, nearest first.
        var suggestions = PlaceDiscovery.nearest(places)
        if let ai {
            do {
                suggestions = try await ai.rank(places, for: request, language: language)
            } catch {
                aiNotice = t("AI 暫時未能使用，已按距離排列：", "AI unavailable, sorted by distance: ") + error.localizedDescription
            }
        }
        guard !Task.isCancelled else { return }
        questionsAsked = 0
        remember("You found: " + suggestions.prefix(5).map(\.place.name).joined(separator: ", "))
        discovery = .choosing(request, areaName: searchArea.name, suggestions: suggestions)
        phase = .idle
    }

    /// Searches at once, unless the AI chose to ask something first.
    private func startDiscovery(_ request: DiscoveryRequest, db: TransportDB, language: Lang,
                                currentLocation: @escaping LocationSource, ai: DeepSeekClient?) async {
        journeys = []
        origin = nil
        destination = nil
        if let question = request.question, questionsAsked < Self.mostQuestions {
            questionsAsked += 1
            remember("You asked: \(question)")
            discovery = .asking(request)
            phase = .idle
        } else {
            await discover(request, db: db, language: language, currentLocation: currentLocation, ai: ai)
        }
    }

    private func begin(_ request: TripRequest, db: TransportDB, language: Lang,
                       currentLocation: @escaping LocationSource, ai: DeepSeekClient?) {
        planTask?.cancel()
        journeys = []
        explanation = nil
        aiNotice = nil
        origin = nil
        destination = nil
        usedAI = false
        phase = .understanding
        planTask = Task { [weak self] in
            await self?.run(request, db: db, language: language, currentLocation: currentLocation, ai: ai)
        }
    }

    private func run(_ request: TripRequest, db: TransportDB, language: Lang,
                     currentLocation: @escaping LocationSource, ai: DeepSeekClient?) async {
        func t(_ zh: String, _ en: String) -> String { language.pick(zh, en) }

        // 1. Understand the request.
        phase = .understanding
        var intent: TripIntent?
        var isPicked = false
        if case .place = request { isPicked = true }
        if let ai, !isPicked {
            do {
                if case .chat = request {
                    switch try await ai.parseChat(request) {
                    case .trip(let trip):
                        intent = trip
                    case .discover(let wish):
                        guard !Task.isCancelled else { return }
                        await startDiscovery(wish, db: db, language: language, currentLocation: currentLocation, ai: ai)
                        return
                    }
                } else {
                    intent = try await ai.parseIntent(request)
                }
                usedAI = true
            } catch {
                aiNotice = t("AI 暫時未能使用，已改用基本解析：", "AI unavailable, used basic parsing: ")
                    + error.localizedDescription
            }
        }
        guard !Task.isCancelled else { return }
        if intent == nil, case .chat(let text, _, _) = request,
           let wish = TripIntentParser.discovery(text) ?? TripIntentParser.search(text) {
            await startDiscovery(wish, db: db, language: language, currentLocation: currentLocation, ai: ai)
            return
        }
        if intent == nil { intent = request.offlineIntent }
        guard var intent else {
            phase = .failed(t("請輸入目的地，例如「由旺角去理大」。", "Enter a destination, e.g. \"Mong Kok to PolyU\"."))
            return
        }
        if case .search(let origin, _, _) = request, origin == nil {
            // An empty start box always means here, whatever the AI inferred.
            intent.origin = nil
        }
        if case .chat = request {
            originText = intent.origin ?? ""
            destinationText = intent.destination
        }
        preference = intent.preference

        // 2. Locate both ends.
        phase = .locating
        let network = await routingNetwork(for: db)
        guard !Task.isCancelled else { return }
        func here() async -> ResolvedPlace? {
            guard let fix = await currentLocation() else { return nil }
            return ResolvedPlace(name: t("我的位置", "My location"),
                                 location: StopLocation(lat: fix.coordinate.latitude, lng: fix.coordinate.longitude))
        }
        let noLocation = t("未能取得你的位置：請允許定位，或在上方輸入起點。",
                           "Couldn't get your location: allow Location access, or type a start above.")
        let start: ResolvedPlace
        if let name = intent.origin {
            guard let place = await PlaceResolver.resolve(name, db: db, network: network, language: language) else {
                phase = .failed(t("找不到起點「\(name)」。", "Couldn't find the start \"\(name)\"."))
                return
            }
            start = place
        } else if let place = await here() {
            start = place
        } else {
            phase = .failed(noLocation)
            return
        }
        guard !Task.isCancelled else { return }
        let end: ResolvedPlace
        if case .place(let picked, _, _) = request {
            end = picked
        } else if let shop = shownShop(named: intent.destination) {
            end = shop
        } else if TripIntentParser.isCurrentLocation(intent.destination) {
            guard let place = await here() else {
                phase = .failed(noLocation)
                return
            }
            end = place
        } else if let place = await PlaceResolver.resolve(intent.destination, db: db, network: network, language: language) {
            end = place
        } else {
            phase = .failed(t("找不到目的地「\(intent.destination)」。", "Couldn't find \"\(intent.destination)\"."))
            return
        }
        guard !Task.isCancelled else { return }
        origin = start
        destination = end
        guard PlaceResolver.isInHongKong(start.location) else {
            phase = .failed(t("起點不在香港範圍內。", "The start is outside Hong Kong."))
            return
        }

        // 3. Search the network (off the main thread).
        phase = .planning
        let departure = Date()
        let preference = intent.preference
        let found = await Task.detached(priority: .userInitiated) {
            RoutePlanner(network: network).plan(from: start.location, to: end.location,
                                                departure: departure, preference: preference)
        }.value
        guard !Task.isCancelled else { return }
        guard !found.isEmpty else {
            phase = .failed(t("找不到公共交通路線，可能已經收車，或距離太近／太遠。",
                              "No public transport route found. Services may have ended, or the trip is too short or too far."))
            return
        }
        journeys = found

        // 4. Replace timetable waits with live ETAs where available.
        phase = .checkingLive
        let cache = LiveArrivalCache(db: db, language: language)
        let retimed = await withTaskGroup(of: (Int, Journey).self, returning: [Journey].self) { group in
            for (index, journey) in found.enumerated() {
                group.addTask {
                    let live = await LiveRetimer.retime(journey) { ride in await cache.arrivals(for: ride) }
                    return (index, live)
                }
            }
            var results = found
            for await (index, journey) in group { results[index] = journey }
            return results
        }
        guard !Task.isCancelled else { return }
        journeys = retimed.sorted { self.preference.score($0) < self.preference.score($1) }
        phase = .done

        // 5. Optional one-line recommendation.
        guard let ai, aiNotice == nil else { return }
        isExplaining = true
        defer { isExplaining = false }
        let summary = DeepSeekClient.summary(of: Array(journeys.prefix(3)), preference: self.preference, now: Date(),
                                             language: language) {
            Self.stopName($0, db: db, language: language)
        }
        let reply = try? await ai.explain(summary, language: language)
        guard !Task.isCancelled else { return }
        explanation = reply
    }

    /// "第一間點去": the AI names a shop on screen, which is already located.
    private func shownShop(named name: String) -> ResolvedPlace? {
        guard case .choosing(_, _, let suggestions) = discovery,
              let shop = suggestions.first(where: { $0.place.name == name })?.place else { return nil }
        return ResolvedPlace(name: shop.name, location: shop.location)
    }

    private func routingNetwork(for db: TransportDB) async -> TransitNetwork {
        let id = db.busStopIndex.id
        if let network, network.sourceID == id { return network }
        if let building = buildingNetwork, building.id == id { return await building.task.value }
        let task = Task.detached(priority: .userInitiated) { TransitNetwork.build(from: db) }
        buildingNetwork = (id, task)
        let built = await task.value
        network = built
        buildingNetwork = nil
        return built
    }

    // MARK: - Text

    static func stopName(_ id: String, db: TransportDB?, stopList: [String: Stop], language: Lang) -> String {
        cleanStopName(stopList[id]?.name.text(language) ?? id)
    }

    static func stopName(_ id: String, db: TransportDB?, language: Lang) -> String {
        guard let name = db?.stopList[id]?.name.text(language), !name.isEmpty else { return id }
        return cleanStopName(name)
    }

    /// Drops operator stop codes such as "(YT611)".
    nonisolated static func cleanStopName(_ name: String) -> String {
        name.replacingOccurrences(of: #"\s*[(（][A-Za-z]{1,5}[0-9]{1,6}[A-Za-z0-9-]*[)）]\s*$"#,
                                  with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
