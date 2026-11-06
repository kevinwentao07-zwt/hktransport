import MapKit
import SwiftUI

/// Instant suggestions under a search box: stops nearest first, then places from Apple Maps.
@MainActor
final class PlaceSuggester: NSObject, ObservableObject, MKLocalSearchCompleterDelegate {
    struct Item: Identifiable, Equatable {
        let id: String
        let title: String
        let detail: String
        let meters: Double?
        let isStop: Bool
    }

    private static let mostStops = 5
    private static let mostPlaces = 5

    @Published private(set) var items: [Item] = []
    private let completer = MKLocalSearchCompleter()
    private var stops: [Item] = []
    private var places: [Item] = []
    private var lastQuery = ""

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = [.pointOfInterest, .address]
    }

    func update(_ query: String, index: BusStopIndex?, around fix: CLLocation?, language: Lang) {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text != lastQuery else { return }
        lastQuery = text
        guard !text.isEmpty else { return clear() }
        let here = fix.map { StopLocation(lat: $0.coordinate.latitude, lng: $0.coordinate.longitude) }
        let center = here ?? StopLocation(lat: 22.34, lng: 114.15)
        let lowered = text.lowercased()
        let found = (index?.sites ?? []).filter { site in
            site.name.zh.contains(text) || site.name.en.lowercased().contains(lowered)
                || site.name.text(language).contains(text)
        }
        stops = found.map { (site: $0, meters: Geo.meters(center, $0.location)) }
            .sorted { $0.meters < $1.meters }
            .prefix(Self.mostStops)
            .map { Item(id: "stop-\($0.site.id)", title: $0.site.name.text(language),
                        detail: language.pick("站點", "Stop"), meters: here == nil ? nil : $0.meters, isStop: true) }
        completer.region = MKCoordinateRegion(center: center.coordinate2D, latitudinalMeters: 30_000, longitudinalMeters: 30_000)
        completer.queryFragment = text
        publish()
    }

    func clear() {
        lastQuery = ""
        stops = []
        places = []
        items = []
        completer.cancel()
    }

    private func publish() { items = stops + places }

    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        let found = completer.results.prefix(Self.mostPlaces).map { ($0.title, $0.subtitle) }
        Task { @MainActor in
            places = found.map { Item(id: "place-\($0.0)-\($0.1)", title: $0.0, detail: $0.1, meters: nil, isStop: false) }
            publish()
        }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {}
}

/// The list itself, opening under a search box.
struct SuggestionList: View {
    let items: [PlaceSuggester.Item]
    let pick: (PlaceSuggester.Item) -> Void

    var body: some View {
        if !items.isEmpty {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(items) { item in
                        Button { pick(item) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: item.isStop ? "bus.fill" : "mappin.circle.fill")
                                    .foregroundStyle(item.isStop ? Color.blue : .red)
                                    .frame(width: 18)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                                    if !item.detail.isEmpty {
                                        Text(item.detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                                Spacer()
                                if let meters = item.meters {
                                    Text(meters < 1_000 ? "\(Int(meters)) m" : String(format: "%.1f km", meters / 1_000))
                                        .font(.system(size: 11)).foregroundStyle(.secondary)
                                }
                            }
                            .padding(.horizontal, 12)
                            .frame(height: 42)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollIndicators(.never)
            .frame(maxHeight: 300)
            .fixedSize(horizontal: false, vertical: true)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
        }
    }
}
