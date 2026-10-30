import SwiftUI

/// Expanded panel: saved stops with live ETAs, or route search -> stop picker.
struct TransportPanel: View {
    @ObservedObject var model: AppModel
    @State private var query = ""
    @State private var pickedRouteKey: String?
    @State private var category: TransportCategory = .saved
    @State private var selectedStation: String?
    @State private var selectedLightRailStation: String?
    @FocusState private var searchFocused: Bool

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider().padding(.vertical, 16)
            VStack(alignment: .leading, spacing: 12) {
                if model.isShowingSettings {
                    SettingsPanel(model: model)
                } else {
                    HStack {
                        Text(category.name.text(model.language))
                            .font(.system(size: 20, weight: .semibold))
                        if category == .mtr || category == .lightRail {
                            Text(model.t("點選車站查看到站時間", "Click a station for live arrivals"))
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        PanelCloseButton(model: model)
                    }
                    searchField
                    if category == .mtr {
                        MTRPanel(model: model, query: $query, selectedStation: $selectedStation)
                    } else if category == .lightRail {
                        LightRailPanel(model: model, query: $query, selectedStation: $selectedLightRailStation)
                    } else if category == .ferry {
                        FerryPanel(model: model, query: query)
                    } else if category == .notice {
                        NoticePanel(model: model, query: query)
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 6) { content }
                        }
                        .scrollIndicators(.never)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .task(id: "\(model.isShowingSettings)-\(category.rawValue)") {
            searchFocused = false
            guard !model.isShowingSettings else { return }
            // The panel becomes key on the expanding click; focus once it is mounted.
            try? await Task.sleep(for: .milliseconds(60))
            guard !Task.isCancelled else { return }
            searchFocused = true
        }
        .onChange(of: category) { _, _ in
            query = ""
            pickedRouteKey = nil
        }
        .onExitCommand {
            if model.isShowingSettings {
                model.hideSettings()
            } else if pickedRouteKey != nil {
                pickedRouteKey = nil
            } else if !query.isEmpty {
                query = ""
            } else {
                model.collapseExpanded()
            }
        }
    }

    private var sidebar: some View {
        VStack(spacing: 6) {
            Text("hktransport")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 16)
            ForEach(TransportCategory.allCases) { item in
                Button {
                    model.hideSettings()
                    category = item
                } label: {
                    Label(item.name.text(model.language), systemImage: item.icon)
                        .font(.system(size: 13, weight: .medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .frame(height: 40)
                        .background(category == item && !model.isShowingSettings ? Color.yellow : .clear,
                                    in: RoundedRectangle(cornerRadius: 10))
                        .foregroundStyle(category == item && !model.isShowingSettings ? .black : .white.opacity(0.75))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(category == item && !model.isShowingSettings ? .isSelected : [])
            }
            Spacer()
            Button {
                model.showSettings()
            } label: {
                Label(model.t("設定", "Settings"), systemImage: "gearshape")
                    .font(.system(size: 13, weight: .medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(model.isShowingSettings ? .white.opacity(0.12) : .clear,
                                in: RoundedRectangle(cornerRadius: 10))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .frame(width: 120)
        .padding(.horizontal, 10)
        .padding(.vertical, 20)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField(searchPrompt, text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 15, weight: .medium))
                .focused($searchFocused)
                .onSubmit {
                    if category == .mtr, let first = MTRNetwork.search(query).first {
                        selectedStation = first.code
                        query = ""
                    } else if category == .lightRail, let first = LightRailNetwork.search(query).first {
                        selectedLightRailStation = first.code
                        query = ""
                    } else if let first = model.searchRoutes(query, category: category).first {
                        pickedRouteKey = first
                    }
                }
                .onChange(of: query) { _, _ in
                    pickedRouteKey = nil
                }
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.t("清除", "Clear"))
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: NotchDesign.Radius.row, style: .continuous))
    }

    private var searchPrompt: String {
        switch category {
        case .mtr:
            return model.t("搜尋車站、車站代碼或路綫，例如 金鐘、ADM、TML", "Search station, code or line, e.g. Admiralty, ADM, TML")
        case .lightRail:
            return model.t("搜尋輕鐵車站或路綫，例如 兆康、LR100、505", "Search Light Rail stop or route, e.g. Siu Hong, LR100, 505")
        case .ferry:
            return model.t("搜尋航線、碼頭或營辦商，例如 長洲、CECC、新渡輪", "Search route, pier or operator, e.g. Cheung Chau, CECC, Sun Ferry")
        case .notice:
            return model.t("搜尋交通通告，例如 輕鐵、渡輪、大埔", "Search traffic notices, e.g. Light Rail, ferry, Tai Po")
        default:
            return model.t("搜尋路線，例如 1A、960、505", "Search route, e.g. 1A, 960, 505")
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.db == nil {
            dbStatus
        } else if let key = pickedRouteKey, let route = model.db?.routeList[key] {
            stopPicker(routeKey: key, route: route)
        } else if !query.isEmpty {
            searchResults
        } else if filteredSavedStops.isEmpty {
            hint(model.t(
                "輸入路線號碼，選擇車站加入。這裏會顯示即時到站時間。",
                "Type a route number and pick a stop to save it. Live arrivals show up here."
            ))
        } else {
            ForEach(filteredSavedStops) { stop in
                SavedStopRow(model: model, stop: stop)
            }
        }
    }

    private var filteredSavedStops: [SavedStop] {
        model.savedStops.filter { stop in
            guard let route = model.route(for: stop) else { return category == .saved }
            return category.includes(route)
        }
    }

    @ViewBuilder
    private var dbStatus: some View {
        if let error = model.dbError {
            VStack(spacing: 8) {
                hint(model.t("無法下載路線資料：", "Couldn't download route data: ") + error)
                Button(model.t("重試", "Retry")) {
                    Task { await model.loadDB() }
                }
            }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                hint(model.t("正在載入路線資料…", "Loading route data…"))
            }
        }
    }

    private var searchResults: some View {
        let keys = model.searchRoutes(query, category: category)
        return Group {
            if keys.isEmpty {
                hint(model.t("找不到路線", "No matching route"))
            } else {
                ForEach(keys, id: \.self) { key in
                    if let route = model.db?.routeList[key] {
                        Button {
                            pickedRouteKey = key
                        } label: {
                            RouteRow(model: model, route: route)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func stopPicker(routeKey: String, route: Route) -> some View {
        Button {
            pickedRouteKey = nil
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.left")
                RouteRow(model: model, route: route)
            }
        }
        .buttonStyle(.plain)

        ForEach(Array(route.stopIDs.indices), id: \.self) { seq in
            let stop = SavedStop(routeKey: routeKey, seq: seq)
            let saved = model.isSaved(stop)
            Button {
                model.toggleSaved(stop)
            } label: {
                HStack(spacing: 10) {
                    Text("\(seq + 1)")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .frame(width: 22, alignment: .trailing)
                    Text(model.stopName(route, seq: seq))
                        .font(.system(size: 13))
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: saved ? "star.fill" : "star")
                        .foregroundStyle(saved ? Color.yellow : Color.secondary)
                }
                .padding(.horizontal, 10)
                .frame(height: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.stopName(route, seq: seq))
            .accessibilityValue(saved ? model.t("已儲存", "Saved") : "")
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
    }
}

struct PanelCloseButton: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Button {
            model.collapseExpanded()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(model.t("關閉面板（⌘W）", "Close panel (⌘W)"))
        .accessibilityLabel(model.t("關閉面板", "Close panel"))
    }
}

private struct RouteRow: View {
    @ObservedObject var model: AppModel
    let route: Route

    var body: some View {
        HStack(spacing: 10) {
            RouteBadge(route: route)
            VStack(alignment: .leading, spacing: 1) {
                Text("→ \(route.dest.text(model.language))")
                    .font(.system(size: 13, weight: .semibold))
                Text(model.t("由 ", "from ") + route.orig.text(model.language))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 1) {
                Text(route.operators.map(\.label).joined(separator: "+"))
                if route.serviceType != "1" {
                    Text(model.t("特別班", "Special"))
                }
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.secondary)
        }
        .padding(8)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: NotchDesign.Radius.row, style: .continuous))
        .contentShape(Rectangle())
    }
}

private struct SavedStopRow: View {
    @ObservedObject var model: AppModel
    let stop: SavedStop

    var body: some View {
        HStack(spacing: 10) {
            if let route = model.route(for: stop) {
                RouteBadge(route: route)
                VStack(alignment: .leading, spacing: 1) {
                    Text("→ \(route.dest.text(model.language))")
                        .font(.system(size: 13, weight: .semibold))
                    Text(model.stopName(route, seq: stop.seq))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                Spacer(minLength: 4)
                ETASummary(model: model, etas: model.etas[stop], large: true)
            } else {
                // Route keys can disappear when the operator data is republished.
                Text(model.t("此路線已不再提供", "This route is no longer listed"))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Spacer()
            }
        }
        .padding(8)
        .frame(minHeight: 52)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: NotchDesign.Radius.row, style: .continuous))
        .contentShape(Rectangle())
        .contextMenu {
            Button(model.t("移到最頂（顯示於瀏海）", "Move to top (shown on notch)")) {
                model.moveToTop(stop)
            }
            Button(model.t("移除", "Remove"), role: .destructive) {
                model.toggleSaved(stop)
            }
        }
    }
}

struct RouteBadge: View {
    let route: Route
    var compact = false

    var body: some View {
        let op = route.operators.first
        Text(route.route)
            .font(.system(size: compact ? 12 : 15, weight: .bold, design: .rounded))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .frame(width: compact ? 40 : 52, height: compact ? 22 : 30)
            .foregroundStyle(op == .ctb ? Color.black : Color.white)
            .background(
                (op?.color ?? .gray).opacity(0.9),
                in: RoundedRectangle(cornerRadius: compact ? 6 : 8, style: .continuous)
            )
    }
}

/// Next arrival in minutes, the following two, and the operator remark.
struct ETASummary: View {
    @ObservedObject var model: AppModel
    let etas: [ETA]?
    let large: Bool

    var body: some View {
        if let etas {
            let upcoming = model.upcoming(etas)
            if let first = upcoming.first, let minutes = model.minutes(until: first) {
                VStack(alignment: .trailing, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        if minutes == 0 {
                            Text(model.t("即到", "Now"))
                                .font(.system(size: large ? 18 : 13, weight: .bold, design: .rounded))
                        } else {
                            Text("\(minutes)")
                                .font(.system(size: large ? 22 : 15, weight: .bold, design: .rounded))
                            Text(model.t("分", "min"))
                                .font(.system(size: 10))
                        }
                        let later = upcoming.dropFirst().prefix(2).compactMap { model.minutes(until: $0) }
                        if !later.isEmpty {
                            Text("· " + later.map(String.init).joined(separator: " · "))
                                .font(.system(size: large ? 12 : 10))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .monospacedDigit()
                    let remark = first.remark.text(model.language)
                    if large, !remark.isEmpty {
                        Text(remark)
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            } else {
                let notice = upcoming.first?.remark.text(model.language) ?? ""
                Text(notice.isEmpty ? model.t("暫無班次", "No departures") : notice)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.trailing)
            }
        } else {
            ProgressView().controlSize(.small)
        }
    }
}
