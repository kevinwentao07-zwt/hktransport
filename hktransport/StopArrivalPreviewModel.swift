import Combine
import Foundation

/// A transient stop lookup. Previewing never changes the user's saved stops.
@MainActor
final class StopArrivalPreviewModel: ObservableObject {
    typealias Fetcher = @Sendable (Route, Int, [String: Stop], Lang) async throws -> [ETA]

    @Published private(set) var etas: [ETA]?
    @Published private(set) var isLoading = false
    @Published private(set) var error: String?
    @Published private(set) var updatedAt: Date?

    private let fetcher: Fetcher
    private var revision = 0

    init(fetcher: @escaping Fetcher = { route, seq, stops, language in
        try await ETAService.fetch(route: route, seq: seq, stopList: stops, language: language)
    }) {
        self.fetcher = fetcher
    }

    func refresh(route: Route, seq: Int, stopList: [String: Stop], language: Lang) async {
        revision += 1
        let request = revision
        isLoading = true
        error = nil
        defer { if request == revision { isLoading = false } }
        do {
            let fetched = try await fetcher(route, seq, stopList, language)
            guard !Task.isCancelled, request == revision else { return }
            etas = fetched
            updatedAt = Date()
        } catch {
            guard !Task.isCancelled, request == revision else { return }
            // Keep the last successful result visible, with an explicit error.
            self.error = error.localizedDescription
        }
    }

    func nextArrivals(at now: Date) -> [ETA] {
        Array((etas ?? []).filter {
            guard let date = $0.date else { return false }
            return date > now.addingTimeInterval(-30)
        }.sorted { $0.date! < $1.date! }.prefix(2))
    }
}
