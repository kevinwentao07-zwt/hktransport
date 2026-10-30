import SwiftUI

struct StopPickerRow: View {
    @ObservedObject var model: AppModel
    let route: Route
    let stop: SavedStop
    let isExpanded: Bool
    let toggleExpanded: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Button(action: toggleExpanded) {
                    HStack(spacing: 10) {
                        Text("\(stop.seq + 1)")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .frame(width: 22, alignment: .trailing)
                        Text(model.stopName(route, seq: stop.seq))
                            .font(.system(size: 13))
                            .lineLimit(1)
                        Spacer()
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .frame(height: 36)
                    .contentShape(Rectangle())
                }
                .accessibilityLabel(model.stopName(route, seq: stop.seq))
                .accessibilityValue(isExpanded ? model.t("已展開", "Expanded") : model.t("已收起", "Collapsed"))
                .help(model.t("點選查看最近兩班到站時間", "Click for the next two arrivals"))

                Button { model.toggleSaved(stop) } label: {
                    Image(systemName: model.isSaved(stop) ? "star.fill" : "star")
                        .foregroundStyle(model.isSaved(stop) ? Color.yellow : Color.secondary)
                        .frame(width: 32, height: 36)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel((model.isSaved(stop) ? model.t("取消收藏 ", "Unsave ") : model.t("收藏 ", "Save "))
                                    + model.stopName(route, seq: stop.seq))
                .accessibilityValue(model.isSaved(stop) ? model.t("已儲存", "Saved") : model.t("未儲存", "Not saved"))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10)

            if isExpanded {
                StopArrivalPreview(model: model, route: route, stop: stop)
                    .padding(.leading, 42)
                    .padding(.trailing, 14)
                    .padding(.bottom, 12)
            }
        }
        .background(.white.opacity(isExpanded ? 0.06 : 0), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct StopArrivalPreview: View {
    @ObservedObject var model: AppModel
    let route: Route
    let stop: SavedStop
    @StateObject private var feed = StopArrivalPreviewModel()
    @State private var refreshRevision = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(model.t("最近兩班", "Next two arrivals"))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                if let updated = feed.updatedAt {
                    Text(updated, style: .time)
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                        .accessibilityLabel(model.t("更新時間", "Updated at"))
                }
                Button { refreshRevision += 1 } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .disabled(feed.isLoading)
                .help(model.t("重新查詢到站時間", "Refresh arrivals"))
                .accessibilityLabel(model.t("重新查詢到站時間", "Refresh arrivals"))
            }

            if let error = feed.error {
                HStack(alignment: .top) {
                    Text(model.t("更新失敗：", "Refresh failed: ") + error)
                        .font(.system(size: 11)).foregroundStyle(.orange)
                    Spacer(minLength: 4)
                    Button(model.t("重試", "Retry")) { refreshRevision += 1 }
                        .font(.system(size: 11)).buttonStyle(.plain)
                }
            }

            if feed.etas == nil, feed.isLoading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(model.t("正在查詢到站時間…", "Checking arrivals…"))
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            } else if let etas = feed.etas {
                let arrivals = feed.nextArrivals(at: model.now)
                if arrivals.isEmpty {
                    let notice = etas.map { $0.remark.text(model.language) }.first { !$0.isEmpty }
                    Text(notice ?? model.t("暫無到站預報", "No arrival predictions available"))
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    HStack(spacing: 10) {
                        ForEach(Array(arrivals.enumerated()), id: \.offset) { index, eta in
                            arrivalCard(eta, index: index)
                        }
                    }
                    if arrivals.count == 1 {
                        Text(model.t("暫未提供第二班預報", "A second arrival is not available yet"))
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .task(id: "\(stop.id)-\(model.language.rawValue)-\(model.refreshInterval.rawValue)-\(refreshRevision)") {
            // SwiftUI cancels the request and refresh loop when this row closes.
            while !Task.isCancelled {
                await feed.refresh(route: route, seq: stop.seq, stopList: model.db?.stopList ?? [:], language: model.language)
                do {
                    try await Task.sleep(for: .seconds(model.refreshInterval.rawValue))
                } catch { return }
            }
        }
    }

    private func arrivalCard(_ eta: ETA, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(index == 0 ? model.t("下一班", "Next") : model.t("第二班", "Following"))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Text(eta.co.label)
                    .font(.system(size: 9)).foregroundStyle(.secondary)
            }
            let minutes = model.minutes(until: eta) ?? 0
            Text(minutes == 0 ? model.t("即將到站", "Arriving") : model.t("\(minutes) 分鐘", "\(minutes) min"))
                .font(.system(size: 20, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(index == 0 ? Color.yellow : Color.white)
            let remark = eta.remark.text(model.language)
            if !remark.isEmpty {
                Text(remark)
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }
}
