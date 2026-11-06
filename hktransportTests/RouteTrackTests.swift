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

    func testABusFarFromTheTimeShownIsADifferentBus() {
        let stops = ["a": stop(22.30), "b": stop(22.31), "c": stop(22.32), "d": stop(22.33), "e": stop(22.34)]
        let route = route(["a", "b", "c", "d", "e"])
        let coming = RouteVehicle(position: 1, location: StopLocation(lat: 22.31, lng: 114.1), heading: 0, minutes: 1, isNext: true)
        XCTAssertEqual(RouteVehicles.due(coming, in: 120, route: route, op: .kmb, boardPosition: 2, stopList: stops), coming)
        XCTAssertEqual(RouteVehicles.due(coming, in: 120, route: route, op: .kmb, boardPosition: 4, stopList: stops)?.position, 3)
        XCTAssertNil(RouteVehicles.due(coming, in: 19 * 60, route: route, op: .kmb, boardPosition: 2, stopList: stops))
    }

    func testABusAtTheRidersStopHasGone() {
        let stops = ["a": stop(22.30), "b": stop(22.31), "c": stop(22.32), "d": stop(22.33), "e": stop(22.34)]
        let now = Date(), arrivals = [RouteArrival(position: 0, times: [now.addingTimeInterval(19 * 60)]),
                                      RouteArrival(position: 3, times: [now.addingTimeInterval(60)])]
        let found = RouteVehicles.find(arrivals, route: route(["a", "b", "c", "d", "e"]), op: .kmb, boardPosition: 0, stopList: stops, now: now)
        XCTAssertFalse(found.contains(where: \.isNext))
    }
}
