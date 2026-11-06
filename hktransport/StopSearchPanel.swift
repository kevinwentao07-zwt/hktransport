import MapKit
import SwiftUI

/// Type a stop or place to see every stop around it, of any kind.
struct StopSearchPanel: View {
    @ObservedObject var model: AppModel
    @ObservedObject var search: StopSearchModel
    @ObservedObject var location: BusLocationModel
    let planRoute: (BusStopSite) -> Void
    var openRoute: ((String, Int) -> Void)?
    @FocusState private var focused: Bool
    @StateObject private var suggester = PlaceSuggester()
    @State private var selectedStopID: String?
    @State private var position: MapCameraPosition = .region(MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 22.3400, longitude: 114.1500),
        span: MKCoordinateSpan(latitudeDelta: 0.42, longitudeDelta: 0.52)
    ))

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            searchBar
                .zIndex(2)
                .overlay(alignment: .topLeading) {
                    if focused {
                        SuggestionList(items: suggester.items) { item in
                            search.query = item.title
                            suggester.clear()
                            focused = false
                            runSearch()
                        }
                        .frame(width: 520)
                        .offset(y: 42)
                    }
                }
            if focused || search.place == nil {
                SearchHistoryBar(model: model, box: SearchHistory.Box.stops) { text in
                    search.query = text
                    runSearch()
                }
            }
            filters
            if let message = search.message {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 12))
                    .foregroundStyle(.orange)
            }
            HStack(alignment: .top, spacing: 12) {
                map.frame(maxWidth: .infinity, maxHeight: .infinity)
                stopList.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onChange(of: search.query) {
            suggester.update(focused ? search.query : "", index: model.db?.allStopIndex, around: location.location, language: model.language)
        }
        .onChange(of: search.place) { fit() }
        .onChange(of: search.radius) { fit() }
        .onChange(of: search.stops.map(\.id)) { selectedStopID = nil }
        .onAppear {
            fit()
            location.requestOnce()
        }
        .onChange(of: location.location) { fit() }
        .task {
            try? await Task.sleep(for: .milliseconds(60))
            focused = true
        }
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(model.t("輸入站名或地點，例如：旺角、朗豪坊、理大", "Stop or place, e.g. Mong Kok, Langham Place"),
                          text: $search.query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 15, weight: .medium))
                    .focused($focused)
                    .onSubmit(runSearch)
                if !search.query.isEmpty || search.place != nil {
                    Button(action: search.clear) {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(model.t("清除", "Clear"))
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: NotchDesign.Radius.row, style: .continuous))
            Button(action: searchHere) {
                Image(systemName: "location").frame(width: 24, height: 28)
            }
            .buttonStyle(.plain)
            .help(model.t("查看我附近的站點", "Show stops around me"))
            Button(model.t("搜尋", "Search"), action: runSearch)
                .disabled(search.query.trimmingCharacters(in: .whitespaces).isEmpty || model.db == nil || search.isSearching)
        }
    }

    private var filters: some View {
        HStack(spacing: 10) {
            Picker(model.t("類型", "Type"), selection: $search.mode) {
                ForEach(TransitMode.allCases) { Text($0.name.text(model.language)).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 300)
            Spacer()
            Picker(model.t("範圍", "Radius"), selection: Binding(
                get: { search.radius },
                set: { radius in if let db = model.db { search.setRadius(radius, db: db) } }
            )) {
                ForEach(StopSearchModel.radii, id: \.self) { Text($0 < 1_000 ? "\($0) m" : "1 km").tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 170)
        }
    }

    private var map: some View {
        Map(position: $position, interactionModes: .all, selection: $selectedStopID) {
            if let place = search.place {
                Marker(place.name, systemImage: "mappin", coordinate: place.location.coordinate2D)
                    .tint(.red)
                MapCircle(center: place.location.coordinate2D, radius: Double(search.radius))
                    .foregroundStyle(.blue.opacity(0.08))
                    .stroke(.blue.opacity(0.25), lineWidth: 1)
            }
            ForEach(search.mapStops) { stop in
                let mode = TransitMode.primary(of: stop.site)
                Marker(stop.site.name.text(model.language), systemImage: icon(mode), coordinate: stop.site.location.coordinate2D)
                    .tint(selectedStopID == stop.id ? Color.yellow : color(mode))
                    .tag(stop.id)
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .mapControls { MapCompass(); MapScaleView(); MapZoomStepper() }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel(model.t("站點 Apple 地圖", "Apple Map of stops"))
    }

    @ViewBuilder
    private var stopList: some View {
        let stops = search.visibleStops
        VStack(alignment: .leading, spacing: 8) {
            if search.isSearching {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(model.t("搜尋中…", "Searching…")).font(.system(size: 12)).foregroundStyle(.secondary)
                }
            } else if let place = search.place {
                Text(model.t("\(place.name)附近 \(stops.count) 個站點", "\(stops.count) stops around \(place.name)"))
                    .font(.system(size: 13, weight: .semibold))
            }
            if search.place == nil && !search.isSearching {
                Text(model.t("輸入站名或地點後，附近所有巴士站、小巴站、港鐵及輕鐵站都會顯示在這裡；點開站點可查看路線及到站時間，或直接規劃路線。",
                             "Search a stop or place to see all bus, minibus, MTR and Light Rail stops around it. Open one for routes and arrivals, or to plan a trip there."))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            } else if stops.isEmpty && !search.isSearching {
                Text(model.t("此範圍內沒有這類站點，可擴大範圍或改選「全部」。", "No stops of this kind here. Try a larger radius or All."))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                                NearbyBusStopCard(model: model, stop: stop, isNearest: index == 0,
                                                  isSelected: selectedStopID == stop.id,
                                                  planRoute: { planRoute(stop.site) }, openRoute: openRoute) {
                                    selectedStopID = selectedStopID == stop.id ? nil : stop.id
                                }
                                .id(stop.id)
                            }
                        }
                    }
                    .scrollIndicators(.never)
                    .onChange(of: selectedStopID) { _, id in
                        guard let id else { return }
                        withAnimation(model.motion(.easeInOut(duration: 0.2))) { proxy.scrollTo(id, anchor: .top) }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func icon(_ mode: TransitMode) -> String {
        switch mode {
        case .mtr: return "tram.tunnel.fill"
        case .lightRail: return "tram.fill"
        case .minibus: return "bus"
        default: return "bus.fill"
        }
    }

    private func color(_ mode: TransitMode) -> Color {
        switch mode {
        case .mtr: return Operator.mtr.color
        case .lightRail: return Operator.lightRail.color
        case .minibus: return Operator.gmb.color
        default: return .orange
        }
    }

    private func runSearch() {
        guard let db = model.db else { return }
        SearchHistory.shared.add(search.query, to: SearchHistory.Box.stops)
        search.search(db: db, language: model.language, ai: model.deepSeekClient())
    }

    private func searchHere() {
        guard let db = model.db else { return }
        let search = search, location = location, language = model.language
        Task {
            if let fix = await location.currentFix() { search.searchAround(fix, db: db, language: language) }
        }
    }

    private func fit() {
        guard let place = search.place else {
            // Nothing searched yet: the stops around the rider are the likely ones.
            guard let fix = location.location else { return }
            let here = StopLocation(lat: fix.coordinate.latitude, lng: fix.coordinate.longitude)
            if PlaceResolver.isInHongKong(here) {
                withAnimation(.easeInOut(duration: 0.35)) {
                    position = .region(MKCoordinateRegion(center: here.coordinate2D, latitudinalMeters: 2_000, longitudinalMeters: 2_000))
                }
            }
            return
        }
        let meters = Double(search.radius) * 2.6
        withAnimation(.easeInOut(duration: 0.35)) {
            position = .region(MKCoordinateRegion(center: place.location.coordinate2D,
                                                  latitudinalMeters: meters, longitudinalMeters: meters))
        }
    }
}

extension StopLocation {
    var coordinate2D: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}
