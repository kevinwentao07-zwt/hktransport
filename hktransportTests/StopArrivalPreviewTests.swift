import XCTest

@testable import hktransport

final class StopArrivalPreviewTests: XCTestCase {
    private let route = Route(route: "74K", co: ["kmb"], orig: .empty, dest: .empty,
                              serviceType: "1", stops: ["kmb": ["S1", "S2"]],
                              bound: ["kmb": "O"], gtfsId: nil, nlbId: nil)

    private static func arrival(_ seconds: Double?) -> ETA {
        ETA(date: seconds.map(Date.init(timeIntervalSince1970:)), remark: .empty, dest: .empty, co: .kmb)
    }

    @MainActor
    func testPreviewReturnsOnlyTheNearestTwoUnexpiredTimedArrivals() async {
        let preview = StopArrivalPreviewModel { _, _, _, _ in
            [Self.arrival(400), Self.arrival(nil), Self.arrival(60), Self.arrival(300), Self.arrival(200)]
        }
        await preview.refresh(route: route, seq: 1, stopList: [:], language: .zh)
        XCTAssertEqual(preview.nextArrivals(at: Date(timeIntervalSince1970: 100)).map(\.date),
                       [Date(timeIntervalSince1970: 200), Date(timeIntervalSince1970: 300)])
        XCTAssertFalse(preview.isLoading)
        XCTAssertNil(preview.error)
        XCTAssertNotNil(preview.updatedAt)
    }

    @MainActor
    func testFailedRefreshPreservesLastSuccessfulResultAndCanRetry() async {
        actor Feed {
            var requests = 0
            func fetch() throws -> [ETA] {
                requests += 1
                if requests == 2 { throw URLError(.notConnectedToInternet) }
                return [StopArrivalPreviewTests.arrival(Double(requests * 100))]
            }
        }
        let feed = Feed()
        let preview = StopArrivalPreviewModel { _, _, _, _ in try await feed.fetch() }
        await preview.refresh(route: route, seq: 0, stopList: [:], language: .zh)
        let initial = preview.etas
        await preview.refresh(route: route, seq: 0, stopList: [:], language: .zh)
        XCTAssertEqual(preview.etas, initial)
        XCTAssertNotNil(preview.error)
        XCTAssertFalse(preview.isLoading)
        await preview.refresh(route: route, seq: 0, stopList: [:], language: .zh)
        XCTAssertNil(preview.error)
        XCTAssertEqual(preview.etas?.first?.date, Date(timeIntervalSince1970: 300))
    }

    @MainActor
    func testCancelledLookupCannotPublishALateResponse() async {
        actor Feed {
            var continuation: CheckedContinuation<[ETA], Never>?
            func fetch() async -> [ETA] {
                await withCheckedContinuation { continuation = $0 }
            }
            func started() -> Bool { continuation != nil }
            func finish() { continuation?.resume(returning: [StopArrivalPreviewTests.arrival(100)]) }
        }
        let feed = Feed()
        let preview = StopArrivalPreviewModel { _, _, _, _ in await feed.fetch() }
        let lookup = Task { await preview.refresh(route: route, seq: 0, stopList: [:], language: .zh) }
        while !(await feed.started()) { await Task.yield() }
        lookup.cancel()
        await feed.finish()
        await lookup.value
        XCTAssertNil(preview.etas)
        XCTAssertNil(preview.updatedAt)
        XCTAssertNil(preview.error)
        XCTAssertFalse(preview.isLoading)
    }

    @MainActor
    func testOlderLookupCannotReplaceTheNewerResponse() async {
        actor Feed {
            var continuation: CheckedContinuation<[ETA], Never>?
            func fetch(_ seq: Int) async -> [ETA] {
                if seq == 1 { return [StopArrivalPreviewTests.arrival(200)] }
                return await withCheckedContinuation { continuation = $0 }
            }
            func started() -> Bool { continuation != nil }
            func finish() { continuation?.resume(returning: [StopArrivalPreviewTests.arrival(100)]) }
        }
        let feed = Feed()
        let preview = StopArrivalPreviewModel { _, seq, _, _ in await feed.fetch(seq) }
        let older = Task { await preview.refresh(route: route, seq: 0, stopList: [:], language: .zh) }
        while !(await feed.started()) { await Task.yield() }
        await preview.refresh(route: route, seq: 1, stopList: [:], language: .en)
        await feed.finish()
        await older.value
        XCTAssertEqual(preview.etas?.first?.date, Date(timeIntervalSince1970: 200))
        XCTAssertFalse(preview.isLoading)
    }
}
