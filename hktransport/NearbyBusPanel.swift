import MapKit
import SwiftUI

struct NearbyBusPanel: View {
    @ObservedObject var model: AppModel
    @ObservedObject var location: BusLocationModel
    @State private var radius = 1_000
    @State private var nearby: [NearbyBusStop] = []
    @State private var selectedStopID: String?
    @State private var isSearching = false
    @State private var position: MapCameraPosition = .region(MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 22.3193, longitude: 114.1694),
        span: MKCoordinateSpan(latitudeDelta: 0.35, longitudeDelta: 0.45)
    ))

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Label(model.t("附近巴士站", "Nearby bus stops"), systemImage: "location.fill")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Picker(model.t("範圍", "Radius"), selection: $radius) {
                    Text("500 m").tag(500)
                    Text("1 km").tag(1_000)
                    Text("3 km").tag(3_000)
                }
                .frame(width: 150)
                Button {
                    if let fix = location.location { centerMap(on: fix.coordinate) }
                    location.locate()
                } label: {
                    Label(model.t("我的位置", "My location"), systemImage: "location")
                }
                .disabled(location.isLocating)
            }
            if location.location == nil || location.issue != nil {
                locationStatus
            }
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    map
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    Text(model.t("雙指開合縮放 · 雙指滑動平移", "Pinch to zoom · Two-finger scroll to pan"))
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                stopList
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { location.resume() }
        .onDisappear { location.pause() }
        .task(id: searchID) {
            guard let index = model.db?.busStopIndex, let fix = location.location else {
                nearby = []
                selectedStopID = nil
                isSearching = false
                return
            }
            isSearching = true
            let origin = StopLocation(lat: fix.coordinate.latitude, lng: fix.coordinate.longitude)
            let searchRadius = Double(radius)
            let results = await Task.detached(priority: .userInitiated) {
                index.nearby(to: origin, radius: searchRadius)
            }.value
            guard !Task.isCancelled else { return }
            nearby = results
            selectedStopID = results.first?.id
            centerMap(on: fix.coordinate)
            isSearching = false
        }
    }

    private var searchID: String {
        "\(model.db?.busStopIndex.id.uuidString ?? "no-db")-\(location.location?.timestamp.timeIntervalSince1970 ?? 0)-\(radius)"
    }

    private var map: some View {
        Map(position: $position, interactionModes: .all, selection: $selectedStopID) {
            if let fix = location.location {
                MapCircle(center: fix.coordinate, radius: max(20, fix.horizontalAccuracy))
                    .foregroundStyle(.blue.opacity(0.10))
                    .stroke(.blue.opacity(0.25), lineWidth: 1)
                Annotation(model.t("我的位置", "My location"), coordinate: fix.coordinate) {
                    Circle().fill(.blue)
                        .frame(width: 14, height: 14)
                        .overlay(Circle().stroke(.white, lineWidth: 3))
                        .shadow(radius: 2)
                }
            }
            ForEach(nearby) { stop in
                Marker(stop.site.name.text(model.language), systemImage: "bus.fill",
                       coordinate: CLLocationCoordinate2D(latitude: stop.site.location.lat, longitude: stop.site.location.lng))
                    .tint(selectedStopID == stop.id ? Color.yellow : Color.orange)
                    .tag(stop.id)
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .mapControls { MapCompass(); MapScaleView(); MapZoomStepper() }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel(model.t("附近巴士站 Apple 地圖", "Apple Map of nearby bus stops"))
    }

    private var stopList: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.t("由近至遠 · 直線距離", "Nearest first · straight-line distance"))
                        .font(.system(size: 11))
                    if let fix = location.location {
                        HStack(spacing: 4) {
                            Text(model.t("定位精度約 \(Int(fix.horizontalAccuracy.rounded())) m ·", "Accuracy ~\(Int(fix.horizontalAccuracy.rounded())) m ·"))
                            Text(fix.timestamp, style: .time)
                        }
                        .font(.system(size: 10))
                    }
                }
                .foregroundStyle(.secondary)
                Spacer()
                if location.isLocating || isSearching { ProgressView().controlSize(.small) }
            }
            if model.db == nil {
                Text(model.dbError ?? model.t("正在載入站點資料…", "Loading bus stops…"))
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                if model.dbError != nil {
                    Button(model.t("重試", "Retry")) { Task { await model.loadDB() } }
                }
            } else if location.location == nil {
                Text(model.t("取得位置後，最近的巴士站會顯示在最上方。", "Your closest bus stops will appear here after locating you."))
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            } else if nearby.isEmpty && !isSearching {
                Text(model.t("此範圍內找不到巴士站。可擴大範圍；目前提供香港巴士站資料。",
                             "No bus stops within this radius. Try a larger radius; stop data covers Hong Kong."))
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(Array(nearby.enumerated()), id: \.element.id) { index, stop in
                                NearbyBusStopCard(model: model, stop: stop, isNearest: index == 0,
                                                  isSelected: selectedStopID == stop.id) {
                                    selectedStopID = selectedStopID == stop.id ? nil : stop.id
                                }
                                .id(stop.id)
                            }
                        }
                    }
                    .scrollIndicators(.never)
                    .onChange(of: selectedStopID) { _, id in
                        guard let id else { return }
                        withAnimation(model.motion(.easeInOut(duration: 0.2))) {
                            proxy.scrollTo(id, anchor: .top)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var locationStatus: some View {
        HStack(spacing: 10) {
            if location.isLocating {
                ProgressView().controlSize(.small)
                Text(model.t("正在取得你的位置…", "Finding your location…"))
            } else if location.issue == .denied {
                Text(model.t("請在系統定位服務中允許 hktransport 使用你的位置。", "Allow hktransport in System Settings → Location Services."))
                Spacer()
                Button(model.t("定位設定", "Location settings")) { location.openSettings() }
            } else if location.issue == .unavailable {
                Text(location.location == nil
                     ? model.t("暫時無法取得位置，請確認定位服務及 Wi-Fi 已開啟。", "Location unavailable. Check Location Services and Wi-Fi.")
                     : model.t("未能更新位置，目前顯示上次定位。", "Unable to update location; showing the last location fix."))
                Spacer()
                Button(model.t("重試", "Retry")) { location.locate() }
            } else {
                Text(model.t("允許定位，即可在地圖顯示你的位置及最近巴士站。", "Enable location to see yourself and your nearest bus stops on the map."))
                Spacer()
                Button(model.t("使用我的位置", "Use my location")) { location.locate() }
            }
        }
        .font(.system(size: 12))
        .padding(10)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }

    private func centerMap(on coordinate: CLLocationCoordinate2D) {
        position = .region(MKCoordinateRegion(center: coordinate,
                                              latitudinalMeters: Double(radius) * 2.5,
                                              longitudinalMeters: Double(radius) * 2.5))
    }
}

private struct NearbyBusStopCard: View {
    @ObservedObject var model: AppModel
    let stop: NearbyBusStop
    let isNearest: Bool
    let isSelected: Bool
    let toggleSelected: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: toggleSelected) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .top) {
                        Text(stop.site.name.text(model.language))
                            .font(.system(size: 13, weight: .semibold)).lineLimit(2)
                        Spacer(minLength: 6)
                        Text(distanceText)
                            .font(.system(size: 12, weight: .semibold)).monospacedDigit()
                            .foregroundStyle(isNearest ? .yellow : .secondary)
                        Image(systemName: isSelected ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                    HStack(spacing: 5) {
                        if isNearest {
                            Text(model.t("最近", "Closest")).foregroundStyle(.yellow)
                        }
                        Text(stop.site.routeNumbers.prefix(8).joined(separator: " · ")
                             + (stop.site.routeNumbers.count > 8 ? " +\(stop.site.routeNumbers.count - 8)" : ""))
                            .foregroundStyle(.secondary).lineLimit(2)
                    }
                    .font(.system(size: 10))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(stop.site.name.text(model.language) + " · " + distanceText)
            .accessibilityValue(isSelected ? model.t("已展開", "Expanded") : model.t("已收起", "Collapsed"))
            if isSelected {
                Divider()
                Text(model.t("此站路線 · 點選查看最近兩班", "Routes at this stop · select for arrivals"))
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                NearbyBusRoutes(model: model, visits: stop.site.visits)
                    .id(stop.id)
            }
        }
        .padding(12)
        .background(.white.opacity(isSelected ? 0.09 : 0.04), in: RoundedRectangle(cornerRadius: 10))
    }

    private var distanceText: String {
        stop.distance < 1_000 ? "\(Int(stop.distance.rounded())) m" : String(format: "%.1f km", stop.distance / 1_000)
    }
}

private struct NearbyBusRoutes: View {
    @ObservedObject var model: AppModel
    let visits: [BusStopVisit]
    @State private var expandedVisit: String?

    var body: some View {
        ForEach(visits) { visit in
            if let db = model.db, let route = visit.route(in: db) {
                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        expandedVisit = expandedVisit == visit.id ? nil : visit.id
                    } label: {
                        HStack(spacing: 8) {
                            RouteBadge(route: route, compact: true)
                            Text("→ " + route.dest.text(model.language))
                                .font(.system(size: 12)).lineLimit(2)
                            Spacer(minLength: 0)
                            Text(visit.co.label + (route.serviceType == "1" ? "" : model.t(" · 特別班", " · Special")))
                                .font(.system(size: 9)).foregroundStyle(.secondary)
                            Image(systemName: expandedVisit == visit.id ? "chevron.up" : "chevron.down")
                                .font(.system(size: 9)).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if expandedVisit == visit.id {
                        Text(db.stopList[route.stopIDs[visit.seq]]?.name.text(model.language) ?? "")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                        StopArrivalPreview(model: model, route: route,
                                           stop: SavedStop(routeKey: visit.routeKey, seq: visit.seq))
                            .id(visit.id)
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }
}
