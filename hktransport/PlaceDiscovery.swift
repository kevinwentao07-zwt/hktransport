import CoreLocation
import Foundation
import MapKit

/// "I want 螺螄粉": something to find rather than a place to go to.
struct DiscoveryRequest: Equatable, Sendable {
    var want: String
    /// Apple Maps search terms, most specific first.
    var searchTerms: [String]
    /// Nil until the rider has said where to look.
    var area: String?
    var areaOptions: [String] = []

    static let nearby = "附近"
    private static let defaultAreas = ["旺角", "銅鑼灣", "尖沙咀", "中環"]

    /// What the area buttons show: nearby first, then the suggested districts.
    var areaChoices: [String] {
        var seen: Set<String> = [Self.nearby]
        let areas = (areaOptions.isEmpty ? Self.defaultAreas : areaOptions).filter { seen.insert($0).inserted }
        return [Self.nearby] + areas.prefix(4)
    }
}

/// A real place from Apple Maps. Only these can ever be recommended.
struct PlaceCandidate: Identifiable, Equatable, Sendable {
    let name: String
    let address: String
    let category: String
    let location: StopLocation
    /// From the centre of the search area.
    var meters: Double = 0
    /// One of Hong Kong's 18 districts, in the system language.
    var district = ""

    var id: String { "\(name)|\(location.lat)|\(location.lng)" }
}

struct PlaceSuggestion: Identifiable, Equatable, Sendable {
    let place: PlaceCandidate
    /// Nil without the AI.
    var reason: String?
    /// True when the AI named this shop itself, rather than choosing from a keyword search.
    var isNamedByAI = false
    var id: String { place.id }
}

/// A shop the AI knows of. Nothing is shown until Apple Maps confirms it.
struct AIPlace: Equatable, Sendable {
    let name: String
    var nameEn: String?
    var reason: String?
}

/// Where to look. "Nearby" means the rider's whole district.
struct SearchArea: Equatable, Sendable {
    let name: String
    let center: StopLocation
    var radius = PlaceDiscovery.areaRadius
    /// Results must be in this district, when it is known.
    var district: String?
}

enum DiscoveryStage: Equatable, Sendable {
    case asking(DiscoveryRequest)
    case choosing(DiscoveryRequest, areaName: String, suggestions: [PlaceSuggestion])
}

enum PlaceDiscovery {
    /// Around a named district or landmark.
    static let areaRadius = 2_500.0
    /// Hong Kong's districts are large, so this only rules out other sides of the city.
    static let districtRadius = 8_000.0
    static let maxCandidates = 12
    static let maxSuggestions = 5

    typealias Searcher = @Sendable (_ term: String, _ center: StopLocation, _ radius: Double) async -> [PlaceCandidate]
    typealias DistrictLookup = @Sendable (_ center: StopLocation, _ language: Lang) async -> (name: String, match: String)?

    private static let nearbyWords = ["附近", "呢度", "呢頭", "這裡", "這裏", "这里", "我身邊", "就近", "nearby", "near me", "around here"]
    private static let areaSuffixes = ["附近", "一帶", "一带", "周邊", "周边", "周圍", "周围", "嗰邊", "那邊", "area"]

    static func isNearby(_ text: String) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return text.isEmpty || nearbyWords.contains(text) || TripIntentParser.isCurrentLocation(text)
    }

    /// "朗豪坊附近" -> "朗豪坊".
    static func cleanArea(_ text: String) -> String {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for suffix in areaSuffixes where value.lowercased().hasSuffix(suffix) && value.count > suffix.count {
            value.removeLast(suffix.count)
            break
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// One result list per search term, most specific first. Specific terms fill the
    /// shortlist before broad ones, so "noodles" can't crowd out a real 米線 shop.
    static func merge(_ results: [[PlaceCandidate]], in area: SearchArea) -> [PlaceCandidate] {
        var seen = Set<String>()
        var places: [PlaceCandidate] = []
        for result in results {
            for place in within(area, result) where places.count < maxCandidates && seen.insert(place.id).inserted {
                places.append(place)
            }
        }
        return places.sorted { $0.meters < $1.meters }
    }

    /// Places inside the area, nearest first.
    static func within(_ area: SearchArea, _ places: [PlaceCandidate]) -> [PlaceCandidate] {
        places.map { place -> PlaceCandidate in
            var place = place
            place.meters = Geo.meters(area.center, place.location)
            return place
        }.filter { place in
            guard place.meters <= area.radius else { return false }
            guard let district = area.district, !place.district.isEmpty else { return true }
            return place.district == district
        }.sorted { $0.meters < $1.meters }
    }

    private static func normalized(_ name: String) -> String {
        String(name.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains).map(Character.init))
    }

    /// Apple Maps returns its closest guess, which can be unrelated, so a result
    /// only counts when its name really is the shop the AI named.
    static func isSamePlace(_ found: String, as place: AIPlace) -> Bool {
        let found = normalized(found)
        guard !found.isEmpty else { return false }
        return [place.name, place.nameEn].compactMap { $0 }.map(normalized).contains { name in
            // A prefix, not any substring: 老友記 (Lo Yau Kee) is not Yau Kee.
            !name.isEmpty && (found.contains(name) || name.hasPrefix(found) || sharesFirstWord(found, name))
        }
    }

    private static func sharesFirstWord(_ a: String, _ b: String) -> Bool {
        // "tsuiwahrestaurant" and "tsuiwahcafe" are the same brand.
        let length = 6
        return a.count >= length && b.count >= length && a.prefix(length) == b.prefix(length)
    }

    /// Looks up each shop the AI named, keeping the nearest branch that is really there.
    static func verify(_ places: [AIPlace], in area: SearchArea, search: Searcher) async -> [PlaceSuggestion] {
        var seen = Set<String>()
        var verified: [PlaceSuggestion] = []
        for place in places where verified.count < maxSuggestions {
            for term in [place.name, place.nameEn].compactMap({ $0 }) {
                let found = within(area, await search(term, area.center, area.radius))
                    .first { isSamePlace($0.name, as: place) }
                if let found {
                    if seen.insert(found.id).inserted {
                        verified.append(PlaceSuggestion(place: found, reason: place.reason, isNamedByAI: true))
                    }
                    break
                }
            }
        }
        return verified
    }

    /// The rider's district, for showing and for comparing with Apple Maps results.
    static func district(of center: StopLocation, language: Lang) async -> (name: String, match: String)? {
        let location = CLLocation(latitude: center.lat, longitude: center.lng)
        guard let match = try? await CLGeocoder().reverseGeocodeLocation(location).first?.subAdministrativeArea else { return nil }
        let locale = Locale(identifier: language == .zh ? "zh_HK" : "en_HK")
        let shown = try? await CLGeocoder().reverseGeocodeLocation(location, preferredLocale: locale).first?.subAdministrativeArea
        return (shown ?? match, match)
    }

    /// Used without the AI, or when it picks nothing usable.
    static func nearest(_ places: [PlaceCandidate]) -> [PlaceSuggestion] {
        places.prefix(maxSuggestions).map { PlaceSuggestion(place: $0, reason: nil) }
    }

    static func appleMaps(term: String, center: StopLocation, radius: Double) async -> [PlaceCandidate] {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = term
        request.resultTypes = .pointOfInterest
        request.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: center.lat, longitude: center.lng),
            latitudinalMeters: radius * 2, longitudinalMeters: radius * 2
        )
        // Apple throttles bursts of searches; treating that as "no results" hid real shops.
        var response: MKLocalSearch.Response?
        for attempt in 0..<3 where response == nil {
            do {
                response = try await MKLocalSearch(request: request).start()
            } catch let error as MKError where error.code == .loadingThrottled && attempt < 2 {
                try? await Task.sleep(for: .seconds(2))
            } catch {
                return []
            }
        }
        return (response?.mapItems ?? []).compactMap { item in
            guard let name = item.name else { return nil }
            let coordinate = item.placemark.coordinate
            let category = item.pointOfInterestCategory?.rawValue.replacingOccurrences(of: "MKPOICategory", with: "") ?? ""
            return PlaceCandidate(name: name, address: item.placemark.title ?? "", category: category,
                                  location: StopLocation(lat: coordinate.latitude, lng: coordinate.longitude),
                                  district: item.placemark.subAdministrativeArea ?? "")
        }
    }
}
