import CoreLocation
import Foundation

enum TransitMode: String, CaseIterable, Identifiable, Sendable {
    case all, bus, minibus, mtr, lightRail

    var id: String { rawValue }

    var name: Name {
        switch self {
        case .all: return Name(en: "All", zh: "全部")
        case .bus: return Name(en: "Bus", zh: "巴士")
        case .minibus: return Name(en: "Minibus", zh: "小巴")
        case .mtr: return Name(en: "MTR", zh: "港鐵")
        case .lightRail: return Name(en: "Light Rail", zh: "輕鐵")
        }
    }

    func includes(_ site: BusStopSite) -> Bool {
        site.visits.contains { visit in
            switch self {
            case .all: return true
            case .bus: return [.kmb, .ctb, .nlb].contains(visit.co)
            case .minibus: return visit.co == .gmb
            case .mtr: return visit.co == .mtr
            case .lightRail: return visit.co == .lightRail
            }
        }
    }

    /// The mode a stop is drawn as: rail first, since a station matters most.
    static func primary(of site: BusStopSite) -> TransitMode {
        [.mtr, .lightRail, .bus, .minibus].first { $0.includes(site) } ?? .bus
    }
}

enum StopSearch {
    /// A stop called exactly what was typed. A station beats a bus stop of the
    /// same name, then the stop with the most routes.
    static func exactSite(_ query: String, in index: BusStopIndex) -> BusStopSite? {
        let wanted = PlaceResolver.normalize(query)
        guard !wanted.isEmpty else { return nil }
        return index.sites.filter {
            PlaceResolver.normalize($0.name.zh) == wanted || PlaceResolver.normalize($0.name.en) == wanted
        }.max { rank($0) < rank($1) }
    }

    /// The busiest stop with the text in its name, e.g. part of a street name.
    static func partialSite(_ query: String, in index: BusStopIndex) -> BusStopSite? {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard wanted.count >= 2 else { return nil }
        return index.sites.filter {
            $0.name.zh.contains(wanted) || $0.name.en.lowercased().contains(wanted)
        }.max { rank($0) < rank($1) }
    }

    private static func rank(_ site: BusStopSite) -> Int {
        (TransitMode.mtr.includes(site) ? 100_000 : TransitMode.lightRail.includes(site) ? 50_000 : 0) + site.visits.count
    }
}

/// Finds a stop or place, then lists every stop around it. Shared because the
/// panel is rebuilt whenever the notch opens.
@MainActor
final class StopSearchModel: ObservableObject {
    static let shared = StopSearchModel()

    typealias PlaceLookup = @Sendable (String) async -> ResolvedPlace?

    static let radii = [300, 500, 1_000]
    /// More pins than this just cover the map; the list still shows every stop.
    static let maxMapStops = 80

    @Published var query = ""
    @Published var mode = TransitMode.all
    @Published private(set) var radius = 500
    @Published private(set) var place: ResolvedPlace?
    @Published private(set) var stops: [NearbyBusStop] = []
    @Published private(set) var isSearching = false
    @Published private(set) var message: String?

    /// Replaced in tests; real lookups go to Apple Maps.
    var placeLookup: PlaceLookup = { await PlaceResolver.appleMaps($0) }

    private var task: Task<Void, Never>?

    var visibleStops: [NearbyBusStop] {
        stops.filter { mode.includes($0.site) }
    }

    /// The nearest stops, with rail last so stations are drawn on top of bus stops.
    var mapStops: [NearbyBusStop] {
        let nearest = visibleStops.prefix(Self.maxMapStops)
        return nearest.filter { !isRail($0) } + nearest.filter(isRail)
    }

    private func isRail(_ stop: NearbyBusStop) -> Bool {
        TransitMode.mtr.includes(stop.site) || TransitMode.lightRail.includes(stop.site)
    }

    func search(db: TransportDB, language: Lang, ai: DeepSeekClient? = nil) {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        run(db: db) { [placeLookup] in
            let index = db.allStopIndex
            if let site = StopSearch.exactSite(text, in: index) {
                return ResolvedPlace(name: site.name.text(language), location: site.location)
            }
            // Apple Maps reads 理大 as any name containing those characters, so
            // nicknames are expanded first: 理大 -> 香港理工大學.
            let request = TripRequest.search(origin: nil, destination: text, preference: .fastest)
            if let full = try? await ai?.parseIntent(request).destination, full != text {
                if let site = StopSearch.exactSite(full, in: index) {
                    return ResolvedPlace(name: site.name.text(language), location: site.location)
                }
                if let place = await placeLookup(full) { return ResolvedPlace(name: full, location: place.location) }
            }
            if let place = await placeLookup(text) { return place }
            return StopSearch.partialSite(text, in: index).map {
                ResolvedPlace(name: $0.name.text(language), location: $0.location)
            }
        } notFound: {
            language == .zh ? "找不到「\(text)」，請換個說法。" : "Couldn't find \"\(text)\". Try another name."
        }
    }

    func searchAround(_ fix: CLLocation, db: TransportDB, language: Lang) {
        query = ""
        let place = ResolvedPlace(name: language == .zh ? "我的位置" : "My location",
                                  location: StopLocation(lat: fix.coordinate.latitude, lng: fix.coordinate.longitude))
        run(db: db) { place } notFound: { "" }
    }

    func setRadius(_ radius: Int, db: TransportDB) {
        self.radius = radius
        guard let place else { return }
        run(db: db) { place } notFound: { "" }
    }

    func clear() {
        task?.cancel()
        query = ""
        place = nil
        stops = []
        message = nil
        isSearching = false
    }

    private func run(db: TransportDB, find: @escaping @Sendable () async -> ResolvedPlace?,
                     notFound: @escaping @Sendable () -> String) {
        task?.cancel()
        isSearching = true
        message = nil
        let radius = Double(radius)
        task = Task { [weak self] in
            let found = await find()
            guard !Task.isCancelled, let self else { return }
            defer { self.isSearching = false }
            guard let found else {
                self.place = nil
                self.stops = []
                self.message = notFound()
                return
            }
            let index = db.allStopIndex
            let stops = await Task.detached(priority: .userInitiated) {
                index.nearby(to: found.location, radius: radius, limit: .max)
            }.value
            guard !Task.isCancelled else { return }
            self.place = found
            self.stops = stops
        }
    }
}
