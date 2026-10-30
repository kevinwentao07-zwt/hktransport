import SwiftUI

enum FerryOperator: String, CaseIterable, Sendable {
    case sunferry, hkkf, fortuneferry

    var name: Name {
        switch self {
        case .sunferry: return Name(en: "Sun Ferry", zh: "新渡輪")
        case .hkkf: return Name(en: "Hong Kong & Kowloon Ferry", zh: "港九小輪")
        case .fortuneferry: return Name(en: "Fortune Ferry", zh: "富裕小輪")
        }
    }
}

extension Route {
    var ferryOperator: FerryOperator? {
        co.compactMap(FerryOperator.init(rawValue:)).first { stops[$0.rawValue] != nil }
    }
}

extension TransportDB {
    func ferryRoutes(matching query: String) -> [String] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return routeList.filter { _, route in
            guard let op = route.ferryOperator else { return false }
            return text.isEmpty || [route.route, route.orig.en, route.orig.zh, route.dest.en, route.dest.zh,
                                    op.name.en, op.name.zh].contains { $0.localizedCaseInsensitiveContains(text) }
        }.sorted { a, b in
            let comparison = a.value.route.localizedStandardCompare(b.value.route)
            return comparison == .orderedSame ? a.key < b.key : comparison == .orderedAscending
        }.map(\.key)
    }
}

struct FerryPanel: View {
    @ObservedObject var model: AppModel
    let query: String
    @State private var selectedRoute: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let db = model.db {
                let keys = db.ferryRoutes(matching: query)
                HStack {
                    Text(model.t("\(keys.count) 個航線方向", "\(keys.count) route directions"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                    Link(model.t("航班時間及票價", "Timetables & fares"), destination: timetableURL)
                        .font(.system(size: 11))
                }
                ScrollView {
                    LazyVStack(spacing: 8) {
                        if keys.isEmpty {
                            Text(model.t("找不到航線", "No matching ferry route"))
                                .font(.system(size: 13)).foregroundStyle(.secondary).padding(30)
                        }
                        ForEach(keys, id: \.self) { key in
                            if let route = db.routeList[key], let op = route.ferryOperator {
                                routeRow(route, key: key, op: op)
                            }
                        }
                    }
                }
                .scrollIndicators(.never)
            } else if let error = model.dbError {
                Text(error).font(.system(size: 12)).foregroundStyle(.orange)
                Button(model.t("重試", "Retry")) { Task { await model.loadDB() } }
            } else {
                ProgressView(model.t("正在載入航線…", "Loading ferry routes…"))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var timetableURL: URL {
        URL(string: "https://www.td.gov.hk/\(model.language == .zh ? "tc" : "en")/transport_in_hong_kong/public_transport/ferries/service_details/index.html")!
    }

    private func routeRow(_ route: Route, key: String, op: FerryOperator) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                selectedRoute = selectedRoute == key ? nil : key
            } label: {
                HStack(spacing: 18) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(route.route)
                            .font(.system(size: 23, weight: .bold, design: .rounded))
                            .lineLimit(1).minimumScaleFactor(0.6)
                        Text(op.name.text(model.language))
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    .frame(width: 170, alignment: .leading)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.t("往 ", "To ") + route.dest.text(model.language))
                            .font(.system(size: 17, weight: .semibold))
                        Text(model.t("由 ", "From ") + route.orig.text(model.language))
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: selectedRoute == key ? "chevron.up" : "chevron.down")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if selectedRoute == key {
                Divider()
                let stops = route.stops[op.rawValue] ?? []
                ForEach(Array(stops.enumerated()), id: \.offset) { index, code in
                    HStack(spacing: 10) {
                        Image(systemName: "ferry.fill").foregroundStyle(.cyan)
                        Text("\(index + 1). " + (model.db?.stopList[code]?.name.text(model.language) ?? code))
                            .font(.system(size: 13))
                    }
                }
                Link(model.t("查看官方航班時間及票價", "View official timetables & fares"), destination: timetableURL)
                    .font(.system(size: 12))
            }
        }
        .padding(16)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }
}
