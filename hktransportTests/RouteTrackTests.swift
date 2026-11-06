import XCTest
@testable import hktransport

final class RouteTrackTests: XCTestCase {
    private func stop(_ lat: Double, _ zh: String = "") -> Stop {
        try! JSONDecoder().decode(Stop.self, from: Data(#"{"location":{"lat":\#(lat),"lng":114.1},"name":{"en":"","zh":"\#(zh)"}}"#.utf8))
    }

    private func route(_ ids: [String], dest: String = "總站", minutes: Double? = 8) -> Route {
        var route = Route(route: "1", co: ["kmb"], orig: Name(en: "", zh: "總站"), dest: Name(en: "", zh: dest), serviceType: "1",
                          stops: ["kmb": ids], bound: ["kmb": "O"], gtfsId: nil, nlbId: nil)
        route.journeyMinutes = minutes
        return route
    }

    func testAnOutAndBackLineKeepsItsStopsInOrder() throws {
        let line = [22.30, 22.31, 22.32, 22.31, 22.30].map { StopLocation(lat: $0, lng: 114.1) }
        let stops: [StopLocation?] = [22.30, 22.31, 22.32, 22.31, 22.30].map { StopLocation(lat: $0, lng: 114.1) }
        let track = try XCTUnwrap(RouteTrack(line: line, stops: stops))
        let passes = track.passes.compactMap { $0?.at }
        XCTAssertEqual(passes, passes.sorted())
        XCTAssertEqual(track.place(at: 3).location.lat, 22.31, accuracy: 0.0001)
        XCTAssertGreaterThan(abs(track.place(at: 3.5).heading), 90) // On its way back south.
    }

    func testACircularRouteTurnsWhereItIsSigned() {
        let stops = ["a": stop(22.30, "總站"), "b": stop(22.315, "三門仔"), "c": stop(22.32, "路口"), "d": stop(22.31, "村"), "e": stop(22.30, "總站")]
        let ids = ["a", "b", "c", "d", "e"]
        XCTAssertEqual(route(ids).circularTurn(.kmb, stopList: stops), 2)
        XCTAssertEqual(route(ids, dest: "三門仔(循環線)").circularTurn(.kmb, stopList: stops), 1)
        XCTAssertNil(route(["a", "b", "c", "d"]).circularTurn(.kmb, stopList: stops))
    }

    private func times(_ rows: [[Double]], from now: Date) -> [RouteArrival] {
        rows.enumerated().map { RouteArrival(position: $0.offset, times: $0.element.map { now.addingTimeInterval($0 * 60) }) }
    }

    func testBusesComeFromTheTimesAtEveryStop() {
        let stops = ["a": stop(22.30), "b": stop(22.31), "c": stop(22.32), "d": stop(22.33), "e": stop(22.34)]
        let route = route(["a", "b", "c", "d", "e"]), now = Date()
        // Stops are 2 minutes apart. One bus reaches d in 1 minute; the one behind it reaches c in 1.
        let two = times([[], [], [1], [1, 3], [3, 5]], from: now)
        let found = RouteVehicles.find(two, route: route, op: .kmb, boardPosition: 3, stopList: stops, now: now)
        XCTAssertEqual(found.map(\.position), [2.5, 1.5])
        XCTAssertEqual(found.map(\.minutes), [1, 3])
        XCTAssertEqual(found.map(\.isNext), [true, false])
        // Choosing another stop only changes the times read off: the buses stay where they are.
        let later = RouteVehicles.find(two, route: route, op: .kmb, boardPosition: 4, stopList: stops, now: now)
        XCTAssertEqual(later.map(\.position), [2.5, 1.5])
        XCTAssertEqual(later.map(\.minutes), [3, 5])
        XCTAssertEqual(RouteVehicles.find(two, route: route, op: .kmb, boardPosition: nil, stopList: stops, now: now).count, 2)
    }

    func testABusAtTheRidersStopHasGone() {
        let stops = ["a": stop(22.30), "b": stop(22.31), "c": stop(22.32), "d": stop(22.33), "e": stop(22.34)]
        let now = Date(), two = times([[], [], [1], [1, 3], [3, 5]], from: now)
        let found = RouteVehicles.find(two, route: route(["a", "b", "c", "d", "e"]), op: .kmb, boardPosition: 1, stopList: stops, now: now)
        XCTAssertEqual(found.map(\.minutes), [nil, nil])
        XCTAssertFalse(found.contains(where: \.isNext))
    }

    func testABusNotFollowedOrNotSetOffIsNotShown() {
        let stops = ["a": stop(22.30), "b": stop(22.31), "c": stop(22.32), "d": stop(22.33), "e": stop(22.34)]
        let route = route(["a", "b", "c", "d", "e"]), now = Date()
        let waiting = times([[5], [7], [9], [11], [13]], from: now)
        XCTAssertTrue(RouteVehicles.find(waiting, route: route, op: .kmb, boardPosition: 3, stopList: stops, now: now).isEmpty)
        let planned = (0..<5).map { RouteArrival(position: $0, times: [], planned: [now.addingTimeInterval(Double($0 * 2 - 3) * 60)]) }
        XCTAssertTrue(RouteVehicles.find(planned, route: route, op: .kmb, boardPosition: 3, stopList: stops, now: now).isEmpty)
    }

    func testABusTimedUnevenlyStaysOneBus() {
        let stops = ["a": stop(22.30), "b": stop(22.31), "c": stop(22.32), "d": stop(22.33), "e": stop(22.34)]
        let uneven = times([[], [1], [1, 6], [3, 4], [5, 6]], from: Date())
        XCTAssertEqual(RouteVehicles.find(uneven, route: route(["a", "b", "c", "d", "e"]), op: .kmb, boardPosition: 3, stopList: stops, now: Date()).count, 2)
    }

    func testKMBPositionsFollowTheStops() {
        XCTAssertEqual(ETAService.kmbPositions(["a", "b", "x", "c", "a"], in: ["a", "b", "c", "a"]), [1: 0, 2: 1, 4: 2, 5: 3])
    }
}
