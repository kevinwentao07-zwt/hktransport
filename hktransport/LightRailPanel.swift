import SwiftUI

@MainActor
final class LightRailBoardModel: ObservableObject {
    @Published private(set) var board: LightRailBoard?
    @Published private(set) var error: String?
    @Published private(set) var isLoading = false
    @Published private(set) var updatedAt: Date?
    private var station: String?

    func refresh(station: String) async {
        if self.station != station {
            self.station = station
            board = nil
            error = nil
            updatedAt = nil
        }
        isLoading = true
        do {
            let result = try await ETAService.fetchLightRailStation(station)
            guard !Task.isCancelled, self.station == station else { return }
            board = result
            error = nil
            updatedAt = Date()
        } catch {
            guard !Task.isCancelled, self.station == station else { return }
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

struct LightRailPanel: View {
    @ObservedObject var model: AppModel
    @Binding var query: String
    @Binding var selectedStation: String?
    @StateObject private var feed = LightRailBoardModel()
    @State private var revision = 0

    private var station: MTRMapStation? {
        LightRailNetwork.stations.first { $0.code == selectedStation }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 8) {
                if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    searchResults
                }
                StationMapView(model: model, stations: LightRailNetwork.stations, imageName: "LightRailSystemMap",
                               imageSize: CGSize(width: 1200, height: 561), title: model.t("輕鐵路綫圖", "Light Rail route map"),
                               selectedStation: $selectedStation)
            }
            VStack(alignment: .leading, spacing: 12) {
                if let station {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(station.name.text(model.language))
                                .font(.system(size: 20, weight: .semibold))
                            Text(station.name.text(model.language == .zh ? .en : .zh) + " · " + station.code)
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        Button { revision += 1 } label: { Image(systemName: "arrow.clockwise") }
                            .buttonStyle(.plain).disabled(feed.isLoading)
                            .help(model.t("重新整理", "Refresh"))
                    }
                    if let error = feed.error {
                        Text(model.t("更新失敗：", "Refresh failed: ") + error)
                            .font(.system(size: 11)).foregroundStyle(.orange)
                    }
                    if let board = feed.board {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 12) {
                                if board.platforms.isEmpty {
                                    Text(model.t("暫無月台資訊", "No platform information"))
                                        .font(.system(size: 12)).foregroundStyle(.secondary)
                                }
                                ForEach(board.platforms) { platform in
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text(model.t("\(platform.id) 號月台", "Platform \(platform.id)"))
                                            .font(.system(size: 13, weight: .semibold))
                                        if platform.serviceEnded {
                                            Text(model.t("此月台今日服務已結束", "Service at this platform has ended"))
                                                .font(.system(size: 11)).foregroundStyle(.secondary)
                                        } else if platform.arrivals.isEmpty {
                                            Text(model.t("暫無班次", "No upcoming trains"))
                                                .font(.system(size: 11)).foregroundStyle(.secondary)
                                        } else {
                                            ForEach(platform.arrivals) { train in
                                                arrivalRow(train, station: station)
                                            }
                                        }
                                    }
                                    Divider()
                                }
                            }
                        }
                        .scrollIndicators(.never)
                    } else {
                        Spacer()
                    }
                    HStack(spacing: 6) {
                        if feed.isLoading { ProgressView().controlSize(.mini) }
                        if let updated = feed.updatedAt {
                            Text(model.t("更新於 ", "Updated ") + updated.formatted(date: .omitted, time: .standard))
                                .font(.system(size: 10)).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Spacer()
                    Image(systemName: "hand.tap").font(.system(size: 30)).foregroundStyle(.yellow)
                    Text(model.t("選擇輕鐵車站", "Choose a Light Rail stop"))
                        .font(.system(size: 18, weight: .semibold))
                    Text(model.t("點選地圖上的車站，查看各月台的路綫、方向及到站時間。也可搜尋車站名稱或路綫號碼。", "Click a stop for routes, destinations and arrivals at each platform. You can also search by stop name or route number."))
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                }
            }
            .padding(14)
            .frame(width: 260)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
        }
        .task(id: "\(selectedStation ?? "")-\(model.refreshInterval.rawValue)-\(revision)") {
            guard let station else { return }
            while !Task.isCancelled {
                let deadline = ContinuousClock.now.advanced(by: .seconds(model.refreshInterval.rawValue))
                await feed.refresh(station: station.code)
                try? await Task.sleep(until: deadline, clock: .continuous)
            }
        }
    }

    private var searchResults: some View {
        let results = LightRailNetwork.search(query)
        return ScrollView {
            LazyVStack(spacing: 4) {
                if results.isEmpty {
                    Text(model.t("找不到車站或路綫", "No matching stop or route"))
                        .font(.system(size: 12)).foregroundStyle(.secondary).padding(12)
                }
                ForEach(results) { stop in
                    Button {
                        selectedStation = stop.code
                        query = ""
                    } label: {
                        HStack {
                            Text(stop.name.text(model.language)).font(.system(size: 13, weight: .medium))
                            Spacer()
                            Text(stop.lines.joined(separator: " · "))
                                .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .padding(9)
                        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(height: min(150, CGFloat(max(results.count, 1)) * 38))
    }

    private func arrivalRow(_ train: LightRailArrival, station: MTRMapStation) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(train.route)
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .padding(.horizontal, 7).padding(.vertical, 4)
                    .foregroundStyle(["614", "615", "751"].contains(train.route) ? .black : .white)
                    .background(LightRailNetwork.routeColor(train.route), in: RoundedRectangle(cornerRadius: 6))
                Text(train.destination.text(model.language)).font(.system(size: 12, weight: .medium))
                Spacer(minLength: 0)
                if let stop = model.lightRailStop(station: station.code, routeNumber: train.route, destination: train.destination) {
                    Button { model.toggleSaved(stop) } label: {
                        Image(systemName: model.isSaved(stop) ? "star.fill" : "star")
                            .foregroundStyle(model.isSaved(stop) ? .yellow : .secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(model.t("儲存方向：", "Save direction: ") + train.route + " " + train.destination.text(model.language))
                    .accessibilityValue(model.isSaved(stop) ? model.t("已儲存", "Saved") : model.t("未儲存", "Not saved"))
                }
            }
            HStack {
                if train.cars > 0 {
                    Text(String(repeating: "▭", count: train.cars)).font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer()
                if let date = train.date {
                    let minutes = max(0, Int(date.timeIntervalSince(model.now) / 60))
                    Text(minutes == 0 ? model.t("即到", "Now") : "\(minutes) " + model.t("分", "min"))
                        .font(.system(size: 17, weight: .semibold, design: .rounded)).monospacedDigit()
                } else {
                    Text(train.time.text(model.language)).font(.system(size: 13, weight: .medium))
                }
            }
            if !train.remark.text(model.language).isEmpty {
                Text(train.remark.text(model.language)).font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }
}
