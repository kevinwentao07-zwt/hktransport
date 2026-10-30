import Foundation
import SwiftUI

struct TrafficNotice: Identifiable, Sendable {
    let id: String
    let heading: Name
    let content: Name
    let status: Name
    let date: Date?

    func matches(_ query: String) -> Bool {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty || [heading.en, heading.zh, content.en, content.zh, status.en, status.zh]
            .contains { $0.localizedCaseInsensitiveContains(text) }
    }
}

enum TrafficNoticeService {
    static func fetch() async throws -> [TrafficNotice] {
        let url = URL(string: "https://www.td.gov.hk/tc/special_news/trafficnews.xml")!
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try parse(data)
    }

    static func parse(_ data: Data) throws -> [TrafficNotice] {
        let delegate = NoticeXMLDelegate()
        let parser = XMLParser(data: data)
        parser.shouldResolveExternalEntities = false
        parser.delegate = delegate
        guard parser.parse(), delegate.validRoot else { throw URLError(.cannotParseResponse) }
        return delegate.notices.sorted {
            let a = $0.date ?? .distantPast, b = $1.date ?? .distantPast
            return a == b ? $0.id > $1.id : a > b
        }
    }
}

private final class NoticeXMLDelegate: NSObject, XMLParserDelegate {
    var notices: [TrafficNotice] = []
    var validRoot = false
    private var fields: [String: String] = [:]
    private var field = ""
    private var inMessage = false

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
                qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
        if elementName == "list" { validRoot = true }
        if elementName == "message" { fields = [:]; inMessage = true }
        field = elementName
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if inMessage { fields[field, default: ""] += string }
    }

    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
        if let text = String(data: CDATABlock, encoding: .utf8), inMessage { fields[field, default: ""] += text }
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        guard elementName == "message" else { return }
        inMessage = false
        func value(_ key: String) -> String { fields[key, default: ""].trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !value("CONTENT_CN").isEmpty || !value("CONTENT_EN").isEmpty else { return }
        let formatter = ISO8601DateFormatter()
        let rawDate = value("ANNOUNCEMENT_DATE")
        let date = formatter.date(from: rawDate) ?? formatter.date(from: rawDate + "+08:00")
        notices.append(TrafficNotice(
            id: value("ID").isEmpty ? value("INCIDENT_NUMBER") + "-\(notices.count)" : value("ID"),
            heading: Name(en: value("INCIDENT_HEADING_EN"), zh: value("INCIDENT_HEADING_CN")),
            content: Name(en: value("CONTENT_EN"), zh: value("CONTENT_CN")),
            status: Name(en: value("INCIDENT_STATUS_EN"), zh: value("INCIDENT_STATUS_CN")), date: date
        ))
    }
}

@MainActor
final class NoticeModel: ObservableObject {
    @Published private(set) var notices: [TrafficNotice] = []
    @Published private(set) var isLoading = false
    @Published private(set) var error: String?
    @Published private(set) var updatedAt: Date?

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let fetched = try await TrafficNoticeService.fetch()
            guard !Task.isCancelled else { return }
            notices = fetched
            updatedAt = Date()
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}

struct NoticePanel: View {
    @ObservedObject var model: AppModel
    let query: String
    @StateObject private var feed = NoticeModel()
    @State private var revision = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(model.t("運輸署 · 特別交通消息", "Transport Department · Special traffic news"), systemImage: "megaphone")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer()
                if feed.isLoading { ProgressView().controlSize(.small) }
                Button { revision += 1 } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).disabled(feed.isLoading)
                    .help(model.t("重新整理", "Refresh"))
            }
            if let error = feed.error {
                HStack {
                    Text(model.t("無法更新通告：", "Couldn't refresh notices: ") + error)
                    Spacer()
                    Button(model.t("重試", "Retry")) { revision += 1 }
                }
                .font(.system(size: 12)).foregroundStyle(.orange)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    let notices = feed.notices.filter { $0.matches(query) }
                    if notices.isEmpty, !feed.isLoading, feed.error == nil {
                        Text(query.isEmpty ? model.t("目前沒有特別交通消息", "No special traffic news at present")
                             : model.t("沒有符合的通告", "No matching notice"))
                            .font(.system(size: 13)).foregroundStyle(.secondary).padding(30)
                    }
                    ForEach(notices) { notice in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text(notice.heading.text(model.language))
                                    .font(.system(size: 14, weight: .semibold))
                                Text(notice.status.text(model.language))
                                    .font(.system(size: 10, weight: .medium)).foregroundStyle(.yellow)
                                Spacer()
                                if let date = notice.date {
                                    Text(date.formatted(date: .abbreviated, time: .shortened))
                                        .font(.system(size: 11)).foregroundStyle(.secondary)
                                }
                            }
                            Text(notice.content.text(model.language))
                                .font(.system(size: 13)).lineSpacing(4)
                                .textSelection(.enabled)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
            .scrollIndicators(.never)
            HStack {
                Text(model.t("每分鐘自動更新", "Refreshes every minute"))
                if let updated = feed.updatedAt {
                    Text("· " + model.t("更新於 ", "Updated ") + updated.formatted(date: .omitted, time: .standard))
                }
                Spacer()
                Link(model.t("官方通告", "Official notices"), destination: URL(string: "https://www.td.gov.hk/\(model.language == .zh ? "tc" : "en")/special_news/spnews.htm")!)
            }
            .font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .task(id: revision) {
            while !Task.isCancelled {
                await feed.refresh()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }
}
