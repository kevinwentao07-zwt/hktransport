import CoreLocation
import Foundation
import MapKit

/// "I want 螺螄粉": something to find rather than a place to go to.
struct DiscoveryRequest: Equatable, Sendable {
    var want: String
    /// The useful words of the whole conversation, without the area.
    var query = ""
    var queryEn: String?
    /// Apple Maps search terms, most specific first.
    var searchTerms: [String]
    /// Nil means around the rider.
    var area: String?
    var extra: String?
    /// Whatever the AI chose to ask first, with answers to tap. Most requests have none.
    var question: String?
    var options: [String] = []

    /// Everything worth looking up, each once.
    var allTerms: [String] {
        var seen = Set<String>()
        return (searchTerms + [query, queryEn ?? ""]).filter { !$0.isEmpty && seen.insert($0).inserted }
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

    var id: String { "\(name)|\(location.lat)|\(location.lng)" }
}

struct PlaceSuggestion: Identifiable, Equatable, Sendable {
    let place: PlaceCandidate
    /// The AI's reason, for the top few.
    var reason: String?
    var id: String { place.id }
}

/// Where to look.
struct SearchArea: Equatable, Sendable {
    let name: String
    var radius = PlaceDiscovery.areaRadius
    let center: StopLocation
}

enum DiscoveryStage: Equatable, Sendable {
    case asking(DiscoveryRequest)
    case choosing(DiscoveryRequest, areaName: String, suggestions: [PlaceSuggestion])
}

enum PlaceDiscovery {
    /// Around a named district or landmark.
    static let areaRadius = 2_500.0
    /// "Nearby", or no area at all.
    static let nearbyRadius = 5_000.0
    static let maxCandidates = 30

    typealias Searcher = @Sendable (_ term: String, _ center: StopLocation, _ radius: Double) async -> [PlaceCandidate]

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
        }.filter { $0.meters <= area.radius }.sorted { $0.meters < $1.meters }
    }

    /// Used without the AI, or when it picks nothing usable.
    static func nearest(_ places: [PlaceCandidate]) -> [PlaceSuggestion] {
        places.map { PlaceSuggestion(place: $0, reason: nil) }
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
                                  location: StopLocation(lat: coordinate.latitude, lng: coordinate.longitude))
        }
    }
}
