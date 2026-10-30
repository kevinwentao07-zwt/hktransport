import AppKit
import SwiftUI

@MainActor
final class MTRBoardModel: ObservableObject {
    @Published private(set) var boards: [MTRLineBoard] = []
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var lastUpdated: Date?
    private var stationCode: String?

    func refresh(station: MTRMapStation, stopList: [String: Stop]) async {
        if stationCode != station.code {
            stationCode = station.code
            boards = []
            errors = [:]
            lastUpdated = nil
        }
        isLoading = true
        let results = await withTaskGroup(of: (String, MTRLineBoard?, String?).self) { group in
            for line in station.lines {
                group.addTask {
                    do {
                        return (line, try await ETAService.fetchMTRStation(line: line, station: station.code, stopList: stopList), nil)
                    } catch {
                        return (line, nil, error.localizedDescription)
                    }
                }
            }
            var results: [(String, MTRLineBoard?, String?)] = []
            for await result in group { results.append(result) }
            return results
        }
        guard !Task.isCancelled, stationCode == station.code else { return }
        var latest = Dictionary(uniqueKeysWithValues: boards.map { ($0.line, $0) })
        var failures: [String: String] = [:]
        for (line, board, error) in results {
            if let board { latest[line] = board }
            if let error { failures[line] = error }
        }
        boards = station.lines.compactMap { latest[$0] }
        errors = failures
        if results.contains(where: { $0.1 != nil }) { lastUpdated = Date() }
        isLoading = false
    }
}

struct MTRPanel: View {
    @ObservedObject var model: AppModel
    @Binding var query: String
    @Binding var selectedStation: String?
    @StateObject private var arrivals = MTRBoardModel()
    @State private var retryRevision = 0

    private var station: MTRMapStation? {
        MTRNetwork.stations.first { $0.code == selectedStation }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 8) {
                if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    searchResults
                }
                StationMapView(model: model, stations: MTRNetwork.stations, imageName: "MTRSystemMap",
                               imageSize: CGSize(width: 2000, height: 1172), title: model.t("港鐵路綫圖", "MTR system map"),
                               selectedStation: $selectedStation)
            }
            VStack(alignment: .leading, spacing: 10) {
                if let station {
                    stationHeading(station)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            forEachLine(station)
                        }
                    }
                    .scrollIndicators(.never)
                    HStack(spacing: 6) {
                        if arrivals.isLoading { ProgressView().controlSize(.mini) }
                        if let updated = arrivals.lastUpdated {
                            Text(model.t("更新於 ", "Updated ") + updated.formatted(date: .omitted, time: .standard))
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Spacer()
                    Image(systemName: "hand.tap")
                        .font(.system(size: 30))
                        .foregroundStyle(.yellow)
                    Text(model.t("選擇車站", "Choose a station"))
                        .font(.system(size: 18, weight: .semibold))
                    Text(model.t("點選地圖上的車站，或搜尋車站名稱。這裏會顯示各路綫及方向的即時列車到站時間。", "Click a station on the map or search by name. Live trains for each line and direction appear here."))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                }
            }
            .padding(14)
            .frame(width: 260)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
        }
        .task(id: "\(selectedStation ?? "")-\(model.refreshInterval.rawValue)-\(retryRevision)") {
            guard let station else { return }
            var stops = Dictionary(uniqueKeysWithValues: MTRNetwork.stations.map { ($0.code, Stop(name: $0.name)) })
            stops.merge(model.db?.stopList ?? [:]) { _, new in new }
            while !Task.isCancelled {
                let deadline = ContinuousClock.now.advanced(by: .seconds(model.refreshInterval.rawValue))
                await arrivals.refresh(station: station, stopList: stops)
                try? await Task.sleep(until: deadline, clock: .continuous)
            }
        }
    }

    private var searchResults: some View {
        let results = MTRNetwork.search(query)
        return ScrollView {
            LazyVStack(spacing: 4) {
                if results.isEmpty {
                    Text(model.t("找不到車站", "No matching station"))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .padding(12)
                }
                ForEach(results) { station in
                    Button {
                        selectedStation = station.code
                        query = ""
                    } label: {
                        HStack {
                            Text(station.name.text(model.language))
                                .font(.system(size: 13, weight: .medium))
                            Text(station.code).font(.system(size: 10)).foregroundStyle(.secondary)
                            Spacer()
                            ForEach(station.lines, id: \.self) { line in
                                Text(line)
                                    .font(.system(size: 9, weight: .bold))
                                    .padding(4)
                                    .background(MTRNetwork.lineColor(line), in: RoundedRectangle(cornerRadius: 4))
                            }
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

    private func stationHeading(_ station: MTRMapStation) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text(station.name.text(model.language))
                    .font(.system(size: 20, weight: .semibold))
                Text(station.name.text(model.language == .zh ? .en : .zh) + " · " + station.code)
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button { retryRevision += 1 } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .disabled(arrivals.isLoading)
            .help(model.t("重新整理", "Refresh"))
        }
    }

    @ViewBuilder
    private func forEachLine(_ station: MTRMapStation) -> some View {
        ForEach(station.lines, id: \.self) { line in
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Circle().fill(MTRNetwork.lineColor(line)).frame(width: 9, height: 9)
                    Text(MTRNetwork.lineName(line).text(model.language))
                        .font(.system(size: 13, weight: .semibold))
                }
                if let error = arrivals.errors[line] {
                    Text(model.t("更新失敗：", "Refresh failed: ") + error)
                        .font(.system(size: 11)).foregroundStyle(.orange)
                }
                if let board = arrivals.boards.first(where: { $0.line == line }) {
                    if board.isDelayed {
                        Text(model.t("列車服務延誤", "Train service delayed"))
                            .font(.system(size: 11)).foregroundStyle(.orange)
                    }
                    if let message = board.message {
                        Text(message).font(.system(size: 12)).foregroundStyle(.secondary)
                    } else {
                        if !board.up.isEmpty || model.mtrStop(station: station.code, line: line, up: true) != nil {
                            direction(board.up, station: station, line: line, up: true)
                        }
                        if !board.down.isEmpty || model.mtrStop(station: station.code, line: line, up: false) != nil {
                            direction(board.down, station: station, line: line, up: false)
                        }
                        if board.up.isEmpty && board.down.isEmpty,
                           model.mtrStop(station: station.code, line: line, up: true) == nil,
                           model.mtrStop(station: station.code, line: line, up: false) == nil {
                            Text(model.t("暫無班次", "No upcoming trains"))
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                    }
                } else if arrivals.errors[line] == nil {
                    ProgressView().controlSize(.small).padding(6)
                }
            }
            .padding(.bottom, 6)
            Divider()
        }
    }

    private func direction(_ trains: [ETA], station: MTRMapStation, line: String, up: Bool) -> some View {
        let stop = model.mtrStop(station: station.code, line: line, up: up)
        let defaultDest = stop.flatMap { model.route(for: $0)?.dest.text(model.language) }
        let destination = trains.first?.dest.text(model.language) ?? defaultDest ?? model.t(up ? "上行" : "下行", up ? "Upbound" : "Downbound")
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("→ " + destination)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if let stop {
                    Button { model.toggleSaved(stop) } label: {
                        Image(systemName: model.isSaved(stop) ? "star.fill" : "star")
                            .foregroundStyle(model.isSaved(stop) ? .yellow : .secondary)
                    }
                    .buttonStyle(.plain)
                    .help(model.t("儲存此方向至瀏海", "Save this direction to the notch"))
                    .accessibilityLabel(model.t("儲存方向：", "Save direction: ") + destination)
                    .accessibilityValue(model.isSaved(stop) ? model.t("已儲存", "Saved") : model.t("未儲存", "Not saved"))
                }
            }
            let upcoming = model.upcoming(trains)
            if upcoming.isEmpty {
                Text(model.t("暫無班次", "No upcoming trains"))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            ForEach(Array(upcoming.prefix(4).enumerated()), id: \.offset) { _, train in
                HStack(spacing: 6) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(train.dest.text(model.language)).font(.system(size: 12))
                        Text(train.remark.text(model.language))
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    if let minutes = model.minutes(until: train) {
                        Text(minutes == 0 ? model.t("即到", "Now") : "\(minutes) " + model.t("分", "min"))
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                    }
                }
            }
        }
        .padding(10)
        .background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }
}

