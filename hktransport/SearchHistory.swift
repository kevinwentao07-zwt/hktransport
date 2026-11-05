import SwiftUI

/// What was searched in each search box, newest first. Kept on this Mac only.
@MainActor
final class SearchHistory: ObservableObject {
    static let shared = SearchHistory()

    static let limit = 20
    /// Shown before the rest are folded away.
    static let collapsedCount = 4
    private static let key = "hktransport.searchHistory"

    enum Box {
        static let origin = "origin"
        static let destination = "destination"
        static let chat = "chat"
        static let stops = "stops"
        static func routes(_ category: TransportCategory) -> String { "routes.\(category.rawValue)" }
    }

    @Published private var boxes: [String: [String]]
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        boxes = defaults.dictionary(forKey: Self.key) as? [String: [String]] ?? [:]
    }

    /// Long entries are shortened on the button; hovering shows them in full.
    static func label(_ text: String) -> String {
        text.count > 14 ? text.prefix(14) + "…" : text
    }

    func entries(_ box: String) -> [String] {
        boxes[box] ?? []
    }

    /// Searching something again moves it back to the top.
    func add(_ text: String, to box: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let others = entries(box).filter { $0.caseInsensitiveCompare(text) != .orderedSame }
        boxes[box] = Array(([text] + others).prefix(Self.limit))
        save()
    }

    func remove(_ text: String, from box: String) {
        boxes[box] = entries(box).filter { $0 != text }
        save()
    }

    func clear(_ box: String) {
        boxes[box] = nil
        save()
    }

    private func save() {
        defaults.set(boxes, forKey: Self.key)
    }
}

/// Past searches under a search box: the latest few, with the rest folded away.
struct SearchHistoryBar: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var history = SearchHistory.shared
    let box: String
    let pick: (String) -> Void
    @State private var isExpanded = false

    var body: some View {
        let entries = history.entries(box)
        if !entries.isEmpty {
            let hidden = entries.count - SearchHistory.collapsedCount
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .frame(height: 22)
                if isExpanded {
                    FlowLayout(spacing: 5) { ForEach(entries, id: \.self, content: chip) }
                } else {
                    HStack(spacing: 5) {
                        ForEach(entries.prefix(SearchHistory.collapsedCount), id: \.self, content: chip)
                    }
                }
                Spacer(minLength: 0)
                if hidden > 0 {
                    Button(isExpanded ? model.t("收起", "Less") : model.t("更多 \(hidden)", "\(hidden) more")) {
                        isExpanded.toggle()
                    }
                    .buttonStyle(.link)
                    .frame(height: 22)
                }
                Button(model.t("清除", "Clear")) {
                    isExpanded = false
                    history.clear(box)
                }
                .buttonStyle(.link)
                .frame(height: 22)
            }
            .font(.system(size: 11))
        }
    }

    private func chip(_ text: String) -> some View {
        Button {
            pick(text)
        } label: {
            Text(SearchHistory.label(text))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 8)
                .frame(height: 22)
                .background(.white.opacity(0.08), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(text)
        .contextMenu {
            Button(model.t("刪除此記錄", "Remove"), role: .destructive) { history.remove(text, from: box) }
        }
    }
}

/// Lays views out in rows, wrapping when a row is full.
private struct FlowLayout: Layout {
    var spacing: CGFloat

    private func rows(_ width: CGFloat, _ subviews: Subviews) -> [(view: LayoutSubview, origin: CGPoint)] {
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        return subviews.map { view in
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            defer {
                x += size.width + spacing
                rowHeight = max(rowHeight, size.height)
            }
            return (view, CGPoint(x: x, y: y))
        }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 400
        let bottom = rows(width, subviews).map { $0.origin.y + $0.view.sizeThatFits(.unspecified).height }.max() ?? 0
        return CGSize(width: width, height: bottom)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in rows(bounds.width, subviews) {
            row.view.place(at: CGPoint(x: bounds.minX + row.origin.x, y: bounds.minY + row.origin.y), proposal: .unspecified)
        }
    }
}
