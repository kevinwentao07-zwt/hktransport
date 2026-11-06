import CoreLocation
import MapKit
import XCTest

@testable import hktransport

final class RoutePlannerTests: XCTestCase {
    /// A–B–C on bus 1, a 41 m walk from C to E, E–F on bus 2, a night-only
    /// bus G–H, and two MTR lines meeting at BBB.
    static func fixture() throws -> TransportDB {
        let json = #"""
        {"routeList":{
          "r1":{"route":"1","co":["kmb"],"orig":{"en":"A","zh":"甲"},"dest":{"en":"C","zh":"丙"},"serviceType":"1","stops":{"kmb":["A","B","C"]},"bound":{"kmb":"O"},"jt":"20","freq":null},
          "r2":{"route":"2","co":["kmb"],"orig":{"en":"E","zh":"戊"},"dest":{"en":"F","zh":"己"},"serviceType":"1","stops":{"kmb":["E","F"]},"bound":{"kmb":"O"},"jt":"10"},
          "night":{"route":"N1","co":["kmb"],"orig":{"en":"G","zh":"庚"},"dest":{"en":"H","zh":"辛"},"serviceType":"1","stops":{"kmb":["G","H"]},"bound":{"kmb":"O"},"jt":"10","freq":{"7":{"2300":["0100","600"]}}},
          "m1":{"route":"XYL","co":["mtr"],"orig":{"en":"AAA","zh":"站一"},"dest":{"en":"BBB","zh":"站二"},"serviceType":"1","stops":{"mtr":["AAA","BBB"]},"bound":{"mtr":"UT"},"jt":null},
          "m2":{"route":"ZZL","co":["mtr"],"orig":{"en":"BBB","zh":"站二"},"dest":{"en":"CCC","zh":"站三"},"serviceType":"1","stops":{"mtr":["BBB","CCC"]},"bound":{"mtr":"UT"},"jt":null}
        },"stopList":{
          "A":{"name":{"en":"A","zh":"甲"},"location":{"lat":22.300,"lng":114.170}},
          "B":{"name":{"en":"B","zh":"乙"},"location":{"lat":22.310,"lng":114.170}},
          "C":{"name":{"en":"C","zh":"丙"},"location":{"lat":22.320,"lng":114.170}},
          "E":{"name":{"en":"E","zh":"戊"},"location":{"lat":22.320,"lng":114.1704}},
          "F":{"name":{"en":"F","zh":"己"},"location":{"lat":22.350,"lng":114.170}},
          "G":{"name":{"en":"G","zh":"庚"},"location":{"lat":22.400,"lng":114.100}},
          "H":{"name":{"en":"H","zh":"辛"},"location":{"lat":22.420,"lng":114.100}},
          "AAA":{"name":{"en":"One","zh":"站一"},"location":{"lat":22.250,"lng":114.250}},
          "BBB":{"name":{"en":"Two","zh":"站二"},"location":{"lat":22.270,"lng":114.250}},
          "CCC":{"name":{"en":"Three","zh":"站三"},"location":{"lat":22.290,"lng":114.250}}
        },"serviceDayMap":{"7":["1","1","1","1","1","1","1"]},"holidays":[]}
        """#
        return try TransportDB.decode(Data(json.utf8))
    }

    static func hongKong(hour: Int, minute: Int = 0) -> Date {
        ServiceClock.hongKong.date(from: DateComponents(year: 2026, month: 11, day: 4, hour: hour, minute: minute))!
    }

    private func planner() throws -> (RoutePlanner, TransportDB) {
        let db = try Self.fixture()
        return (RoutePlanner(network: TransitNetwork.build(from: db)), db)
    }

    private func location(_ id: String, in db: TransportDB) -> StopLocation {
        db.stopList[id]!.location!
    }

    // MARK: Database fields

    func testDecodesJourneyTimeAndFrequency() throws {
        let db = try Self.fixture()
        XCTAssertEqual(db.routeList["r1"]?.journeyMinutes, 20)
        XCTAssertNil(db.routeList["m1"]?.journeyMinutes)
        XCTAssertNil(db.routeList["r1"]?.frequency)
        let band = db.routeList["night"]?.frequency?.days["7"]?.first
        XCTAssertEqual(band, RouteFrequency.Band(start: 23 * 60, end: 60, headwaySeconds: 600))
        XCTAssertEqual(db.serviceDayMap?["7"]?.count, 7)
    }

    func testFrequencyParsingKeepsSingleDeparturesAndSortsBands() {
        let frequency = RouteFrequency(raw: ["1": ["2340": nil, "0535": ["0705", "900"]]])
        XCTAssertEqual(frequency?.days["1"], [
            RouteFrequency.Band(start: 335, end: 425, headwaySeconds: 900),
            RouteFrequency.Band(start: 1420, end: nil, headwaySeconds: nil),
        ])
        XCTAssertNil(RouteFrequency.minuteOfDay("5:35"))
    }

    // MARK: Waits

    func testWaitIsHalfTheHeadwayInsideABandIncludingAcrossMidnight() {
        let bands = [RouteFrequency.Band(start: 23 * 60, end: 60, headwaySeconds: 600)]
        XCTAssertEqual(WaitEstimator.wait(bands: bands, at: 23 * 60 + 30, maxWait: 90), 5)
        XCTAssertEqual(WaitEstimator.wait(bands: bands, at: 30, maxWait: 90), 5)
        XCTAssertEqual(WaitEstimator.wait(bands: bands, at: 22 * 60, maxWait: 90), 60)
        XCTAssertNil(WaitEstimator.wait(bands: bands, at: 12 * 60, maxWait: 90))
    }

    func testSingleDepartureWaitsUntilItLeaves() {
        let bands = [RouteFrequency.Band(start: 600, end: nil, headwaySeconds: nil)]
        XCTAssertEqual(WaitEstimator.wait(bands: bands, at: 590, maxWait: 90), 10)
        XCTAssertNil(WaitEstimator.wait(bands: bands, at: 700, maxWait: 90))
    }

    // MARK: Search

    func testDirectRide() throws {
        let (planner, db) = try planner()
        let journeys = planner.search(from: location("A", in: db), to: location("C", in: db),
                                      departure: Self.hongKong(hour: 12))
        let journey = try XCTUnwrap(journeys.first)
        XCTAssertEqual(journey.rides.map(\.route), ["1"])
        XCTAssertEqual(journey.rides.first?.boardStopID, "A")
        XCTAssertEqual(journey.rides.first?.alightStopID, "C")
        XCTAssertEqual(journey.rides.first?.boardPosition, 0)
        XCTAssertEqual(journey.rides.first?.alightPosition, 2)
        // 15 min default headway -> 7.5 min wait, plus the published 20 min journey.
        XCTAssertEqual(journey.totalMinutes, 27.5, accuracy: 0.01)
    }

    func testTransferWithWalkBetweenStops() throws {
        let (planner, db) = try planner()
        let journey = try XCTUnwrap(planner.search(from: location("A", in: db), to: location("F", in: db),
                                                   departure: Self.hongKong(hour: 12)).first)
        XCTAssertEqual(journey.rides.map(\.route), ["1", "2"])
        XCTAssertEqual(journey.transfers, 1)
        guard journey.legs.count == 3, case .walk(let meters, _, let to) = journey.legs[1] else {
            return XCTFail("expected ride, walk, ride: \(journey.legs)")
        }
        XCTAssertEqual(meters, 41, accuracy: 3)
        XCTAssertEqual(to, "E")
        XCTAssertEqual(journey.rides[1].transferMinutes, PlannerSettings().transferMinutes)
    }

    func testRouteThatIsNotRunningIsSkipped() throws {
        let (planner, db) = try planner()
        let noon = planner.search(from: location("G", in: db), to: location("H", in: db),
                                  departure: Self.hongKong(hour: 12))
        XCTAssertTrue(noon.isEmpty)
        let night = try XCTUnwrap(planner.search(from: location("G", in: db), to: location("H", in: db),
                                                 departure: Self.hongKong(hour: 23, minute: 30)).first)
        XCTAssertEqual(night.rides.first?.waitMinutes ?? -1, 5, accuracy: 0.01)
    }

    func testMTRInterchangeUsesStationTransferTime() throws {
        let (planner, db) = try planner()
        let journey = try XCTUnwrap(planner.search(from: location("AAA", in: db), to: location("CCC", in: db),
                                                   departure: Self.hongKong(hour: 12)).first)
        XCTAssertEqual(journey.rides.map(\.route), ["XYL", "ZZL"])
        XCTAssertEqual(journey.rides[1].transferMinutes, PlannerSettings().mtrInterchangeMinutes)
    }

    func testPlanOffersAWalkForShortTrips() throws {
        let (planner, db) = try planner()
        let journeys = planner.plan(from: location("C", in: db), to: location("E", in: db),
                                    departure: Self.hongKong(hour: 12))
        XCTAssertEqual(journeys.first?.signature, "walk")
    }

    // MARK: Map

    func testMapPathFollowsEveryStopAndWalkOfTheTrip() throws {
        let (planner, db) = try planner()
        let start = StopLocation(lat: 22.2995, lng: 114.170)
        let end = StopLocation(lat: 22.3505, lng: 114.170)
        let journey = try XCTUnwrap(planner.search(from: start, to: end, departure: Self.hongKong(hour: 12)).first)
        let path = JourneyMapPath(journey: journey, origin: start, destination: end, db: db)

        let a = location("A", in: db), b = location("B", in: db), c = location("C", in: db)
        let e = location("E", in: db), f = location("F", in: db)
        XCTAssertEqual(path.segments.map(\.mode), [.walk, .ride(route: "1", op: .kmb), .walk,
                                                   .ride(route: "2", op: .kmb), .walk])
        XCTAssertEqual(path.segments.map(\.points), [[start, a], [a, b, c], [c, e], [e, f], [f, end]])
        XCTAssertEqual(path.segments.map(\.stopIDs), [[], ["A", "B", "C"], [], ["E", "F"], []])
    }

    func testRideListsOnlyTheStopsItPasses() throws {
        let (planner, db) = try planner()
        let journey = try XCTUnwrap(planner.search(from: location("A", in: db), to: location("C", in: db),
                                                   departure: Self.hongKong(hour: 12)).first)
        XCTAssertEqual(journey.rides.first?.stopIDs(in: db), ["A", "B", "C"])

        let partial = try XCTUnwrap(planner.search(from: location("B", in: db), to: location("C", in: db),
                                                   departure: Self.hongKong(hour: 12)).first)
        XCTAssertEqual(partial.rides.first?.stopIDs(in: db), ["B", "C"])
    }

    func testMapPathShowsOnlyTheStopsBetweenBoardingAndAlighting() throws {
        let (planner, db) = try planner()
        let b = location("B", in: db), c = location("C", in: db)
        let journey = try XCTUnwrap(planner.search(from: b, to: c, departure: Self.hongKong(hour: 12)).first)
        let path = JourneyMapPath(journey: journey, origin: b, destination: c, db: db)
        XCTAssertEqual(path.segments.map(\.points), [[b, c]])
    }

    func testMapPathForAWalkOnlyTrip() throws {
        let db = try Self.fixture()
        let c = location("C", in: db), e = location("E", in: db)
        let journey = Journey(legs: [.walk(meters: 41, minutes: 1, toStopID: nil)], departure: Self.hongKong(hour: 12))
        let path = JourneyMapPath(journey: journey, origin: c, destination: e, db: db)
        XCTAssertEqual(path.segments.map(\.mode), [.walk])
        XCTAssertEqual(path.segments.map(\.points), [[c, e]])
    }

    func testLiveRetimingDoesNotMoveTheMapPath() async throws {
        let (planner, db) = try planner()
        let start = location("A", in: db), end = location("C", in: db)
        let departure = Self.hongKong(hour: 12)
        let journey = try XCTUnwrap(planner.search(from: start, to: end, departure: departure).first)
        let live = await LiveRetimer.retime(journey) { _ in [LiveDeparture(date: departure.addingTimeInterval(240))] }
        XCTAssertEqual(live.id, journey.id)
        XCTAssertEqual(JourneyMapPath(journey: live, origin: start, destination: end, db: db),
                       JourneyMapPath(journey: journey, origin: start, destination: end, db: db))
    }

    func testMapRegionFramesEveryPointAndKeepsAMinimumZoom() throws {
        let points = [StopLocation(lat: 22.30, lng: 114.10), StopLocation(lat: 22.40, lng: 114.20)]
        let region = try XCTUnwrap(MKCoordinateRegion(fitting: points))
        XCTAssertEqual(region.center.latitude, 22.35, accuracy: 0.0001)
        XCTAssertEqual(region.center.longitude, 114.15, accuracy: 0.0001)
        XCTAssertTrue(region.span.latitudeDelta > 0.1)
        XCTAssertTrue(region.span.longitudeDelta > 0.1)

        let single = try XCTUnwrap(MKCoordinateRegion(fitting: [points[0]]))
        XCTAssertTrue(single.span.latitudeDelta > 0)
        XCTAssertNil(MKCoordinateRegion(fitting: []))
    }

    // MARK: Live ETAs

    func testLiveRetimerUsesFirstCatchableDeparture() async throws {
        let (planner, db) = try planner()
        let departure = Self.hongKong(hour: 12)
        let journey = try XCTUnwrap(planner.search(from: location("A", in: db), to: location("C", in: db),
                                                   departure: departure).first)

        let live = await LiveRetimer.retime(journey) { _ in
            [LiveDeparture(date: departure.addingTimeInterval(-300)), LiveDeparture(date: departure.addingTimeInterval(240))]
        }
        XCTAssertEqual(live.rides.first?.liveDeparture, departure.addingTimeInterval(240))
        XCTAssertEqual(live.totalMinutes, 24, accuracy: 0.01)
        XCTAssertEqual(live.liveRideCount, 1)

        let offline = await LiveRetimer.retime(journey) { _ in nil }
        XCTAssertNil(offline.rides.first?.liveDeparture)
        XCTAssertEqual(offline.totalMinutes, journey.totalMinutes, accuracy: 0.01)
    }

    func testRailBeyondTheLiveWindowContinuesTheLiveHeadway() {
        let now = Self.hongKong(hour: 12)
        let platform = Name(en: "Platform 1", zh: "1號月台")
        let trains = [0.0, 3, 6, 9].map { LiveDeparture(date: now.addingTimeInterval($0 * 60), platform: platform) }

        let inWindow = LiveRetimer.next(trains, reachedAt: now.addingTimeInterval(4 * 60), projecting: true)
        XCTAssertEqual(inWindow?.departure.date, now.addingTimeInterval(6 * 60))
        XCTAssertEqual(inWindow?.isProjected, false)

        // 20 minutes out: 9 + 3 + 3 + 3 + 3 = 21.
        let projected = LiveRetimer.next(trains, reachedAt: now.addingTimeInterval(20 * 60), projecting: true)
        XCTAssertEqual(projected?.departure.date, now.addingTimeInterval(21 * 60))
        XCTAssertEqual(projected?.isProjected, true)
        XCTAssertEqual(projected?.departure.platform, platform)

        // Buses are too irregular, one train gives no headway, and far ahead is a guess.
        XCTAssertNil(LiveRetimer.next(trains, reachedAt: now.addingTimeInterval(20 * 60), projecting: false))
        XCTAssertNil(LiveRetimer.next([trains[0]], reachedAt: now.addingTimeInterval(20 * 60), projecting: true))
        XCTAssertNil(LiveRetimer.next(trains, reachedAt: now.addingTimeInterval(90 * 60), projecting: true))
    }

    func testRetimedMTRLegsAreLiveEvenAfterAnEarlierLeg() async throws {
        let (planner, db) = try planner()
        let departure = Self.hongKong(hour: 12)
        let journey = try XCTUnwrap(planner.search(from: location("AAA", in: db), to: location("CCC", in: db),
                                                   departure: departure).last)
        XCTAssertEqual(journey.rides.map(\.route), ["XYL", "ZZL"])
        // Each line only publishes the next two trains, inside the first few minutes.
        let live = await LiveRetimer.retime(journey) { _ in
            [LiveDeparture(date: departure.addingTimeInterval(60)), LiveDeparture(date: departure.addingTimeInterval(120))]
        }
        XCTAssertEqual(live.rides.map { $0.liveDeparture != nil }, [true, true])
        XCTAssertEqual(live.rides.map(\.isProjected), [false, true])
    }

    func testShortWorkingAndOtherBranchTrainsAreNotCaught() throws {
        let json = #"""
        {"routeList":{
          "main":{"route":"EAL","co":["mtr"],"orig":{"en":"A","zh":"A"},"dest":{"en":"D","zh":"D"},"serviceType":"1","stops":{"mtr":["A","B","C","D"]},"bound":{"mtr":"UT"}},
          "branch":{"route":"EAL","co":["mtr"],"orig":{"en":"A","zh":"A"},"dest":{"en":"E","zh":"E"},"serviceType":"2","stops":{"mtr":["A","B","E"]},"bound":{"mtr":"UT"}}
        },"stopList":{
          "A":{"name":{"en":"A","zh":"A"},"location":{"lat":22.30,"lng":114.17}},
          "B":{"name":{"en":"B","zh":"B"},"location":{"lat":22.31,"lng":114.17}},
          "C":{"name":{"en":"C","zh":"C"},"location":{"lat":22.32,"lng":114.17}},
          "D":{"name":{"en":"D","zh":"D"},"location":{"lat":22.33,"lng":114.17}},
          "E":{"name":{"en":"E","zh":"E"},"location":{"lat":22.32,"lng":114.18}}
        },"serviceDayMap":{},"holidays":[]}
        """#
        let db = try TransportDB.decode(Data(json.utf8))
        func ride(to stop: String, position: Int) -> PlannedRide {
            PlannedRide(routeKey: "main", route: "EAL", op: .mtr, dest: Name(en: "D", zh: "D"), boardPosition: 0,
                        alightPosition: position, boardStopID: "A", alightStopID: stop,
                        transferMinutes: 0, waitMinutes: 0, rideMinutes: 5)
        }
        func serves(_ terminus: String, _ ride: PlannedRide) -> Bool {
            LiveArrivalCache.train(to: Name(en: terminus, zh: terminus), serves: ride, db: db)
        }
        XCTAssertTrue(serves("D", ride(to: "C", position: 2)))
        XCTAssertFalse(serves("B", ride(to: "C", position: 2)), "ends before the rider's stop")
        XCTAssertFalse(serves("E", ride(to: "C", position: 2)), "takes the other branch")
        XCTAssertTrue(serves("E", ride(to: "B", position: 1)), "both branches share this stretch")
        XCTAssertTrue(serves("New Terminus", ride(to: "C", position: 2)))
    }

    func testMTRShowsLineNamesAndColoursInsteadOfCodes() {
        XCTAssertEqual(Operator.mtr.lineName("EAL").zh, "東鐵綫")
        XCTAssertEqual(Operator.mtr.lineName("ISL").en, "Island Line")
        XCTAssertEqual(Operator.kmb.lineName("1A").zh, "1A")
        XCTAssertEqual(Operator.mtr.lineColor("TWL"), MTRNetwork.lineColor("TWL"))
        XCTAssertEqual(Operator.kmb.lineColor("1A"), Operator.kmb.color)
    }

    // MARK: Search bar and AI box

    func testSearchRequestTellsTheAIBothEndsWithoutCoordinates() {
        let here = TripRequest.search(origin: nil, destination: "理大", preference: .lessWalking)
        XCTAssertTrue(here.aiMessage.contains("Start: current location"))
        XCTAssertTrue(here.aiMessage.contains("Destination: 理大"))
        XCTAssertTrue(here.aiMessage.contains("Preference: lessWalking"))
        XCTAssertEqual(here.offlineIntent, TripIntent(origin: nil, destination: "理大", preference: .lessWalking))

        // A typed place is taken as it is, even if it reads like a sentence.
        let typed = TripRequest.search(origin: "到會所", destination: "去馬路", preference: .fastest)
        XCTAssertEqual(typed.offlineIntent, TripIntent(origin: "到會所", destination: "去馬路"))
        XCTAssertNil(TripRequest.search(origin: nil, destination: "  ", preference: .fastest).offlineIntent)
    }

    func testChatFollowUpsChangeOnlyWhatWasMentioned() {
        let current = TripIntent(origin: "旺角", destination: "中環")
        XCTAssertEqual(TripIntentParser.parse("少行路", current: current),
                       TripIntent(origin: "旺角", destination: "中環", preference: .lessWalking))
        XCTAssertEqual(TripIntentParser.parse("去機場", current: current),
                       TripIntent(origin: "旺角", destination: "機場"))
        XCTAssertEqual(TripIntentParser.parse("我的位置去機場", current: current),
                       TripIntent(origin: nil, destination: "機場"))
        XCTAssertEqual(TripIntentParser.parse("去機場", current: nil), TripIntent(origin: nil, destination: "機場"))
        XCTAssertNil(TripIntentParser.parse("   ", current: current))

        let message = TripRequest.chat("少行路", current: current).aiMessage
        XCTAssertTrue(message.contains("Start: 旺角"))
        XCTAssertTrue(message.contains("Rider says: 少行路"))
        XCTAssertEqual(TripRequest.chat("去機場", current: nil).aiMessage, "去機場")
    }

    @MainActor
    func testSwappingEndsKeepsTheCurrentLocation() {
        let planner = RoutePlannerModel()
        planner.destinationText = "中環"
        planner.swapEnds(language: .zh)
        XCTAssertEqual(planner.originText, "中環")
        XCTAssertEqual(planner.destinationText, "我的位置")
        planner.swapEnds(language: .zh)
        XCTAssertEqual(planner.originText, "")
        XCTAssertEqual(planner.destinationText, "中環")
    }

    func testVoiceInputLanguages() {
        XCTAssertEqual(SpeechLanguage.defaultChoice(for: .zh), .cantonese)
        XCTAssertEqual(SpeechLanguage.defaultChoice(for: .en), .english)
        XCTAssertEqual(SpeechLanguage.allCases.map(\.localeID), ["zh-HK", "zh-CN", "en-US"])
    }

    // MARK: Location

    @MainActor
    func testLocationIsRequestedOncePerLaunch() async throws {
        let manager = FakeLocationManager(status: .authorizedAlways)
        let location = BusLocationModel(manager: manager)

        location.requestOnce()
        location.requestOnce()
        location.resume()
        XCTAssertEqual(manager.requests, 1)

        location.locationManager(manager, didUpdateLocations: [CLLocation(latitude: 22.3, longitude: 114.17)])
        await waitUntil { location.location != nil }
        XCTAssertNotNil(location.location)

        // Closing the notch and coming back, on either page, reuses the fix.
        location.pause()
        location.resume()
        location.requestOnce()
        let fix = await location.currentFix()
        XCTAssertEqual(fix, location.location)
        XCTAssertEqual(manager.requests, 1)

        // The location button is the one way to refresh it.
        location.locate()
        XCTAssertEqual(manager.requests, 2)
    }

    @MainActor
    func testPermissionIsOnlyAskedOnce() {
        let manager = FakeLocationManager(status: .notDetermined)
        let location = BusLocationModel(manager: manager)
        location.requestOnce()
        location.pause()
        location.requestOnce()
        location.resume()
        XCTAssertEqual(manager.permissionPrompts, 1)
        XCTAssertEqual(manager.requests, 0)
    }

    @MainActor
    func testLeavingThePageMidRequestDoesNotUseUpTheRequest() {
        let manager = FakeLocationManager(status: .authorizedAlways)
        let location = BusLocationModel(manager: manager)
        location.requestOnce()
        location.pause()
        location.requestOnce()
        XCTAssertEqual(manager.requests, 2)
    }

    // MARK: Navigation

    private func navigationPath() throws -> (path: JourneyMapPath, db: TransportDB, end: StopLocation) {
        let (planner, db) = try planner()
        let start = StopLocation(lat: 22.2995, lng: 114.170), end = StopLocation(lat: 22.3505, lng: 114.170)
        let journey = try XCTUnwrap(planner.search(from: start, to: end, departure: Self.hongKong(hour: 12)).first)
        return (JourneyMapPath(journey: journey, origin: start, destination: end, db: db), db, end)
    }

    func testProgressFollowsTheTripStopByStop() throws {
        let (path, db, _) = try navigationPath()
        func text(_ progress: JourneyProgress?) throws -> String {
            path.instruction(for: try XCTUnwrap(progress), language: .zh) { $0 }
        }
        XCTAssertEqual(try text(path.progress(at: StopLocation(lat: 22.2997, lng: 114.170))), "步行前往 A")

        // Between A and B on bus 1.
        let onBus = path.progress(at: StopLocation(lat: 22.305, lng: 114.170))
        XCTAssertEqual(onBus?.segment, 1)
        XCTAssertEqual(try text(onBus), "1 · 下一站 B · 還有 2 站到 C 下車")

        // Standing at B, the next stop is C.
        XCTAssertEqual(try text(path.progress(at: location("B", in: db), after: onBus)), "下一站 C 下車")

        // Between C and E is the walk to the second bus.
        XCTAssertEqual(try text(path.progress(at: StopLocation(lat: 22.320, lng: 114.1702), after: onBus)), "步行前往 E")
    }

    func testMapKeepsOnlyWhatIsAheadWithLaterLegsLight() throws {
        let (path, _, end) = try navigationPath()
        let walking = StopLocation(lat: 22.2997, lng: 114.170)
        let before = path.ahead(of: path.progress(at: walking), at: walking)
        XCTAssertEqual(before.map(\.isUpcoming), [false, true, true, true, true])
        XCTAssertEqual(before[1].stops.map { $0.id }, ["A", "B", "C"])

        // On bus 1 between A and B: the walk and A are behind, the line starts at the rider.
        let riding = StopLocation(lat: 22.305, lng: 114.170)
        let onBus = path.ahead(of: path.progress(at: riding), at: riding)
        XCTAssertEqual(onBus.map(\.id), [1, 2, 3, 4])
        XCTAssertFalse(onBus[0].isUpcoming)
        XCTAssertEqual(onBus[0].stops.map { $0.id }, ["B", "C"])
        XCTAssertEqual(onBus[0].points.first?.lat ?? 0, 22.305, accuracy: 1e-6)

        XCTAssertEqual(path.ahead(of: nil, at: nil), path.segments)
        XCTAssertTrue(path.ahead(of: path.progress(at: end), at: end).isEmpty)
    }

    func testNoisyFixCannotUndoProgress() throws {
        let (path, db, _) = try navigationPath()
        let late = try XCTUnwrap(path.progress(at: StopLocation(lat: 22.335, lng: 114.170)))
        XCTAssertEqual(late.segment, 3)
        let noisy = try XCTUnwrap(path.progress(at: location("A", in: db), after: late))
        XCTAssertTrue(noisy.isOffRoute)
        XCTAssertEqual(noisy.edge, late.edge)
    }

    func testArrivalAndLeavingTheRoute() throws {
        let (path, _, end) = try navigationPath()
        XCTAssertEqual(path.progress(at: end)?.hasArrived, true)
        let lost = try XCTUnwrap(path.progress(at: StopLocation(lat: 22.31, lng: 114.20)))
        XCTAssertTrue(lost.isOffRoute)
        XCTAssertTrue(path.instruction(for: lost, language: .zh) { $0 }.contains("不在路線上"))
        // A vague Wi-Fi position isn't evidence of being lost.
        let vague = StopLocation(lat: 22.31, lng: 114.1735)
        XCTAssertEqual(path.progress(at: vague)?.isOffRoute, true)
        XCTAssertEqual(path.progress(at: vague, accuracy: 500)?.isOffRoute, false)
    }

    @MainActor
    func testNavigationKeepsTrackingUntilArrival() async throws {
        let (path, _, end) = try navigationPath()
        let manager = FakeLocationManager(status: .authorizedAlways)
        let location = BusLocationModel(manager: manager)
        let tracker = NavigationTracker(location: location)
        tracker.start(journeyID: "trip", path: path)
        XCTAssertEqual(manager.trackingStarts, 1)

        // Closing the notch must not end it.
        location.pause()
        XCTAssertEqual(manager.trackingStops, 0)

        location.locationManager(manager, didUpdateLocations: [CLLocation(latitude: 22.305, longitude: 114.170)])
        await waitUntil { tracker.progress != nil }
        XCTAssertEqual(tracker.progress?.segment, 1)
        XCTAssertNil(location.location, "the once-per-launch fix is left alone while tracking")

        location.locationManager(manager, didUpdateLocations: [CLLocation(latitude: end.lat, longitude: end.lng)])
        await waitUntil { tracker.progress?.hasArrived == true }
        XCTAssertEqual(tracker.progress?.hasArrived, true)
        XCTAssertEqual(manager.trackingStops, 1, "arriving turns the location off")

        tracker.stop()
        XCTAssertNil(tracker.journeyID)
        XCTAssertEqual(manager.trackingStops, 1)
        XCTAssertNotNil(location.location)
    }

    @MainActor
    func testEndingNavigationTurnsTheLocationOff() throws {
        let (path, _, _) = try navigationPath()
        let manager = FakeLocationManager(status: .authorizedAlways)
        let location = BusLocationModel(manager: manager)
        let tracker = NavigationTracker(location: location)
        tracker.start(journeyID: "trip", path: path)
        tracker.stop()
        XCTAssertEqual(manager.trackingStops, 1)
        XCTAssertNil(tracker.path)
    }

    // MARK: Finding somewhere

    func testAIReplyIsEitherATripOrAWish() {
        XCTAssertEqual(DeepSeekClient.decodeChat(#"{"origin":null,"destination":"理大","preference":"fastest"}"#),
                       .trip(TripIntent(origin: nil, destination: "理大")))
        let wish = #"{"kind":"discover","want":"螺螄粉","searchTerms":["螺螄粉","米線","mixian","noodles","五"],"area":null,"areaOptions":["旺角","佐敦"]}"#
        XCTAssertEqual(DeepSeekClient.decodeChat(wish),
                       .discover(DiscoveryRequest(want: "螺螄粉", searchTerms: ["螺螄粉", "米線", "mixian", "noodles"], area: nil,
                                                  areaOptions: ["旺角", "佐敦"])))
        XCTAssertEqual(DeepSeekClient.decodeChat(#"{"kind":"discover","want":"拉麵","area":"旺角"}"#),
                       .discover(DiscoveryRequest(want: "拉麵", searchTerms: ["拉麵"], area: "旺角")))
        XCTAssertNil(DeepSeekClient.decodeChat(#"{"kind":"discover","want":" "}"#))
    }

    func testWishesAreRecognisedWithoutTheAI() {
        XCTAssertEqual(TripIntentParser.discovery("我想吃螺狮粉")?.want, "螺狮粉")
        XCTAssertEqual(TripIntentParser.discovery("想食拉麵？")?.searchTerms, ["拉麵", "restaurant"])
        XCTAssertEqual(TripIntentParser.discovery("想買手機")?.searchTerms, ["手機"])
        XCTAssertNil(TripIntentParser.discovery("去機場"))
        XCTAssertNil(TripIntentParser.discovery("我想吃"))
    }

    func testAreaButtonsStartWithNearbyAndStayShort() {
        let request = DiscoveryRequest(want: "粉", searchTerms: ["粉"], areaOptions: ["旺角", "附近", "旺角", "佐敦", "荃灣", "沙田", "屯門"])
        XCTAssertEqual(request.areaChoices, ["附近", "旺角", "佐敦", "荃灣", "沙田"])
        XCTAssertEqual(DiscoveryRequest(want: "粉", searchTerms: ["粉"]).areaChoices.first, "附近")
    }

    func testAreaWordsAreCleaned() {
        XCTAssertEqual(PlaceDiscovery.cleanArea("朗豪坊附近"), "朗豪坊")
        XCTAssertEqual(PlaceDiscovery.cleanArea("旺角"), "旺角")
        XCTAssertEqual(PlaceDiscovery.cleanArea("附近"), "附近")
        XCTAssertTrue(PlaceDiscovery.isNearby("附近"))
        XCTAssertTrue(PlaceDiscovery.isNearby("我的位置"))
        XCTAssertFalse(PlaceDiscovery.isNearby("旺角"))
    }

    private static func shop(_ name: String, _ lat: Double) -> PlaceCandidate {
        PlaceCandidate(name: name, address: "\(name)地址", category: "Restaurant", location: StopLocation(lat: lat, lng: 114.250))
    }

    func testResultsAreMergedNearestFirstAndLimitedToTheArea() {
        let center = StopLocation(lat: 22.270, lng: 114.250)
        let near = Self.shop("近", 22.2705), far = Self.shop("遠", 22.275), tooFar = Self.shop("太遠", 22.40)
        let area = SearchArea(name: "區", center: center, radius: 1_500)
        let merged = PlaceDiscovery.merge([[far, near], [near, tooFar]], in: area)
        XCTAssertEqual(merged.map(\.name), ["近", "遠"])
        XCTAssertEqual(merged[0].meters, 56, accuracy: 2)

        // A full list of nearby generic results can't push out the specific shop.
        let generic = (0..<20).map { Self.shop("普通\($0)", 22.2701 + Double($0) * 0.00001) }
        let specific = Self.shop("米線店", 22.278)
        let list = PlaceDiscovery.merge([[specific], generic], in: area)
        XCTAssertEqual(list.count, PlaceDiscovery.maxCandidates)
        XCTAssertTrue(list.contains { $0.name == "米線店" })
    }

    func testNearbyMeansTheRidersOwnDistrict() {
        let center = StopLocation(lat: 22.270, lng: 114.250)
        var inside = Self.shop("區內", 22.300)
        inside.district = "Yau Tsim Mong District"
        var outside = Self.shop("區外", 22.272)
        outside.district = "Kowloon City District"
        let unknown = Self.shop("未知區", 22.271)
        let area = SearchArea(name: "油尖旺區", center: center, radius: PlaceDiscovery.districtRadius,
                              district: "Yau Tsim Mong District")
        XCTAssertEqual(PlaceDiscovery.within(area, [outside, inside, unknown]).map(\.name), ["未知區", "區內"],
                       "a farther shop in the district beats a closer one across the border")
    }

    func testOnlyTheShopTheAINamedCounts() {
        let tamjai = AIPlace(name: "譚仔雲南米線", nameEn: "TamJai Yunnan Mixian")
        XCTAssertTrue(PlaceDiscovery.isSamePlace("Tamjai Yunnan Mixian", as: tamjai))
        XCTAssertTrue(PlaceDiscovery.isSamePlace("譚仔雲南米線 (旺角)", as: tamjai))
        XCTAssertFalse(PlaceDiscovery.isSamePlace("Joe's Billiards & Bar", as: tamjai))
        XCTAssertTrue(PlaceDiscovery.isSamePlace("Tsui Wah Restaurant", as: AIPlace(name: "翠華餐廳", nameEn: "Tsui Wah")))
        XCTAssertTrue(PlaceDiscovery.isSamePlace("ICHIRAN", as: AIPlace(name: "一蘭", nameEn: "Ichiran Ramen")))
        XCTAssertFalse(PlaceDiscovery.isSamePlace("Nam Kee Noodle", as: AIPlace(name: "興記", nameEn: "Hing Kee")))
        XCTAssertFalse(PlaceDiscovery.isSamePlace("Yau Kee Noodles", as: AIPlace(name: "老友記粉麵", nameEn: "Lo Yau Kee Noodles")))
    }

    func testRunningOutOfTokensIsReportedNotHidden() {
        let reply = #"{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"..."}}]}"#
        XCTAssertThrowsError(try DeepSeekClient.parseCompletion(Data(reply.utf8), status: 200)) { error in
            XCTAssertTrue(error.localizedDescription.contains("ran out of tokens"))
        }
    }

    func testAIPlacesAreDecoded() {
        let reply = #"{"places":[{"name":"譚仔","nameEn":"TamJai","reason":"米線專門店"},{"name":" ","nameEn":"Only English"},{"reason":"冇名"}]}"#
        XCTAssertEqual(DeepSeekClient.decodePlaces(reply), [
            AIPlace(name: "譚仔", nameEn: "TamJai", reason: "米線專門店"),
            AIPlace(name: "Only English", nameEn: "Only English", reason: nil),
        ])
        XCTAssertTrue(DeepSeekClient.decodePlaces("sorry").isEmpty)
        XCTAssertTrue(DeepSeekClient.suggestPrompt(.zh).contains("Never make a shop up"))
    }

    func testShopsTheMapCannotFindAreNeverShown() async {
        let center = StopLocation(lat: 22.270, lng: 114.250)
        let area = SearchArea(name: "區", center: center, radius: 3_000)
        let nearBranch = Self.shop("Real Noodle", 22.272), farBranch = Self.shop("Real Noodle", 22.280)
        let named = [AIPlace(name: "幻想店", nameEn: "Dream Shop", reason: "編造"),
                     AIPlace(name: "真店", nameEn: "Real Noodle", reason: "真的"),
                     AIPlace(name: "真店分店", nameEn: "Real Noodle", reason: "同一家")]
        let verified = await PlaceDiscovery.verify(named, in: area) { term, _, _ in
            term == "Real Noodle" ? [farBranch, nearBranch] : [Self.shop("Joe's Billiards", 22.2701)]
        }
        XCTAssertEqual(verified.map(\.place.location), [nearBranch.location])
        XCTAssertEqual(verified.first?.reason, "真的")
        XCTAssertEqual(verified.first?.isNamedByAI, true)
    }

    func testAICanOnlyRecommendPlacesThatExist() {
        let places = [Self.shop("甲", 22.27), Self.shop("乙", 22.271)]
        let reply = #"{"picks":[{"index":1,"reason":"最符合"},{"index":99,"reason":"編造的店"},{"index":1,"reason":"重複"},{"index":0,"reason":" "}]}"#
        let picks = DeepSeekClient.decodePicks(reply, from: places)
        XCTAssertEqual(picks.map(\.place.name), ["乙", "甲"])
        XCTAssertEqual(picks.map(\.reason), ["最符合", nil])
        XCTAssertTrue(DeepSeekClient.decodePicks("not json", from: places).isEmpty)

        let list = DeepSeekClient.placeList(places, want: "粉", extra: "要平啲")
        XCTAssertTrue(list.contains("1. 乙"))
        XCTAssertTrue(list.contains("Also wants: 要平啲"))
        XCTAssertFalse(list.contains("22.27"), "coordinates must not reach the AI")
        XCTAssertTrue(DeepSeekClient.recommendPrompt(.zh).contains("Never invent"))
        XCTAssertTrue(DeepSeekClient.recommendPrompt(.zh).contains("no menus"))
    }

    @MainActor
    func testFindingFoodThenRoutingToThePlacePicked() async throws {
        FakeDeepSeek.start(intent: #"{"kind":"discover","want":"螺螄粉","searchTerms":["螺螄粉","米線"],"area":null,"areaOptions":["站二"]}"#)
        FakeDeepSeek.picks = #"{"picks":[{"index":1,"reason":"較符合"},{"index":42,"reason":"不存在"}]}"#
        defer { FakeDeepSeek.stop() }
        let db = try Self.fixture()
        let planner = RoutePlannerModel()
        let searched = SearchLog()
        let first = Self.shop("近店", 22.2705), second = Self.shop("遠店", 22.2715)
        planner.placeSearch = { term, _, _ in
            await searched.add(term)
            return [first, second]
        }
        planner.originText = "站一"
        planner.chatText = "我想吃螺狮粉"
        let ai = DeepSeekClient(apiKey: "test-key")
        planner.sendChat(db: db, language: .zh, currentLocation: { nil }, ai: ai)
        await waitUntil { planner.discovery != nil }
        guard case .asking(let request) = planner.discovery else { return XCTFail("should ask where to look") }
        XCTAssertEqual(request.areaChoices, ["附近", "站二"])

        planner.chooseArea("站二", db: db, language: .zh, currentLocation: { nil }, ai: ai)
        await waitUntil { planner.visibleSuggestions != nil }
        let terms = await searched.terms
        XCTAssertEqual(terms, ["螺螄粉", "米線"])
        XCTAssertEqual(planner.visibleSuggestions?.map(\.place.name), ["遠店"], "the invented index is dropped")
        XCTAssertEqual(planner.visibleSuggestions?.first?.reason, "較符合")

        let pick = try XCTUnwrap(planner.visibleSuggestions?.first)
        planner.choosePlace(pick, db: db, language: .zh, currentLocation: { nil }, ai: ai)
        await waitUntil { !planner.journeys.isEmpty && planner.phase != .planning }
        XCTAssertEqual(planner.destination?.location, second.location)
        XCTAssertEqual(planner.destinationText, "遠店")
        XCTAssertFalse(planner.journeys.isEmpty)
        XCTAssertNil(planner.visibleSuggestions)

        planner.backToSuggestions()
        XCTAssertEqual(planner.visibleSuggestions?.map(\.place.name), ["遠店"])
    }

    @MainActor
    func testNearbySearchesTheDistrictWithTheAIsOwnPicks() async throws {
        FakeDeepSeek.start(intent: #"{"kind":"discover","want":"螺螄粉","searchTerms":["螺螄粉"],"area":"附近"}"#)
        FakeDeepSeek.places = #"{"places":[{"name":"真店","nameEn":"Real Noodle","reason":"專做螺螄粉"}]}"#
        defer { FakeDeepSeek.stop() }
        let db = try Self.fixture()
        let planner = RoutePlannerModel()
        planner.districtLookup = { _, _ in ("油尖旺區", "Yau Tsim Mong District") }
        var shop = Self.shop("Real Noodle", 22.28)
        shop.district = "Yau Tsim Mong District"
        let found = shop
        planner.placeSearch = { term, _, radius in
            radius == PlaceDiscovery.districtRadius && term == "Real Noodle" ? [found] : []
        }
        planner.chatText = "附近有冇螺螄粉"
        planner.sendChat(db: db, language: .zh, currentLocation: { Self.here }, ai: DeepSeekClient(apiKey: "test-key"))
        await waitUntil { planner.visibleSuggestions != nil || planner.isFailed }

        XCTAssertEqual(planner.visibleSuggestions?.map(\.reason), ["專做螺螄粉"])
        guard case .choosing(_, let area, _) = planner.discovery else { return XCTFail("should show places") }
        XCTAssertEqual(area, "油尖旺區")
        let sent = FakeDeepSeek.bodies.joined()
        XCTAssertTrue(sent.contains("Area: 油尖旺區"))
        XCTAssertFalse(sent.contains("22.25"), "coordinates must not reach the AI")
    }

    @MainActor
    func testTypedAreaAndNoResultsAskAgain() async throws {
        let db = try Self.fixture()
        let planner = RoutePlannerModel()
        planner.placeSearch = { _, _, _ in [] }
        planner.chatText = "想食拉麵"
        planner.sendChat(db: db, language: .zh, currentLocation: { nil }, ai: nil)
        await waitUntil { planner.discovery != nil }

        planner.chatText = "站二附近"
        planner.sendChat(db: db, language: .zh, currentLocation: { nil }, ai: nil)
        await waitUntil { planner.isFailed }
        XCTAssertTrue(planner.isFailed)
        guard case .asking = planner.discovery else { return XCTFail("should offer other areas") }
    }

    @MainActor
    func testNearbyWithoutALocationAsksForAnArea() async throws {
        let db = try Self.fixture()
        let planner = RoutePlannerModel()
        planner.chatText = "想食拉麵"
        planner.sendChat(db: db, language: .zh, currentLocation: { nil }, ai: nil)
        await waitUntil { planner.discovery != nil }
        planner.chooseArea(DiscoveryRequest.nearby, db: db, language: .zh, currentLocation: { nil }, ai: nil)
        await waitUntil { planner.isFailed }
        guard case .asking = planner.discovery else { return XCTFail("should offer other areas") }
    }

    // MARK: Search history

    @MainActor
    private func emptyHistory() throws -> (SearchHistory, UserDefaults, String) {
        let suite = "hktransport.history-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        return (SearchHistory(defaults: defaults), defaults, suite)
    }

    @MainActor
    func testHistoryKeepsNewestFirstWithoutRepeats() throws {
        let (history, defaults, suite) = try emptyHistory()
        defer { defaults.removePersistentDomain(forName: suite) }
        history.add("旺角", to: "box")
        history.add(" 中環 ", to: "box")
        history.add("   ", to: "box")
        history.add("旺角", to: "box")
        XCTAssertEqual(history.entries("box"), ["旺角", "中環"])
        history.add("MONG KOK", to: "box")
        history.add("mong kok", to: "box")
        XCTAssertEqual(history.entries("box"), ["mong kok", "旺角", "中環"])
    }

    @MainActor
    func testEachBoxHasItsOwnHistoryAndItSurvivesARestart() throws {
        let (history, defaults, suite) = try emptyHistory()
        defer { defaults.removePersistentDomain(forName: suite) }
        history.add("旺角", to: SearchHistory.Box.origin)
        history.add("1A", to: SearchHistory.Box.routes(.bus))
        XCTAssertEqual(history.entries(SearchHistory.Box.destination), [])
        XCTAssertEqual(history.entries(SearchHistory.Box.routes(.minibus)), [])

        let reopened = SearchHistory(defaults: defaults)
        XCTAssertEqual(reopened.entries(SearchHistory.Box.origin), ["旺角"])
        XCTAssertEqual(reopened.entries(SearchHistory.Box.routes(.bus)), ["1A"])
    }

    @MainActor
    func testLongEntriesAreShortenedOnTheirButtons() {
        XCTAssertEqual(SearchHistory.label("旺角"), "旺角")
        let long = String(repeating: "長", count: 30)
        XCTAssertEqual(SearchHistory.label(long), String(repeating: "長", count: 14) + "…")
    }

    @MainActor
    func testHistoryIsCappedAndCanBeRemoved() throws {
        let (history, defaults, suite) = try emptyHistory()
        defer { defaults.removePersistentDomain(forName: suite) }
        for index in 0..<(SearchHistory.limit + 5) { history.add("站\(index)", to: "box") }
        XCTAssertEqual(history.entries("box").count, SearchHistory.limit)
        XCTAssertEqual(history.entries("box").first, "站\(SearchHistory.limit + 4)")

        history.remove("站\(SearchHistory.limit + 4)", from: "box")
        XCTAssertEqual(history.entries("box").count, SearchHistory.limit - 1)
        history.clear("box")
        XCTAssertEqual(history.entries("box"), [])
        XCTAssertEqual(SearchHistory(defaults: defaults).entries("box"), [])
    }

    // MARK: Stop search

    func testStopIndexCoversEveryKindOfStop() throws {
        let db = try Self.fixture()
        XCTAssertTrue(db.allStopIndex.sites.contains { TransitMode.mtr.includes($0) })
        XCTAssertTrue(db.allStopIndex.sites.contains { TransitMode.bus.includes($0) })
        XCTAssertFalse(db.busStopIndex.sites.contains { TransitMode.mtr.includes($0) }, "the bus page stays bus only")
    }

    func testExactStopNameBeatsAMapLookupAndStationsComeFirst() throws {
        let json = #"""
        {"routeList":{
          "bus":{"route":"1","co":["kmb"],"orig":{"en":"A","zh":"A"},"dest":{"en":"B","zh":"B"},"serviceType":"1","stops":{"kmb":["BUSMK","X"]},"bound":{"kmb":"O"}},
          "busb":{"route":"2","co":["kmb"],"orig":{"en":"A","zh":"A"},"dest":{"en":"B","zh":"B"},"serviceType":"1","stops":{"kmb":["BUSMK","X"]},"bound":{"kmb":"O"}},
          "rail":{"route":"KTL","co":["mtr"],"orig":{"en":"A","zh":"A"},"dest":{"en":"B","zh":"B"},"serviceType":"1","stops":{"mtr":["MOK","YMT"]},"bound":{"mtr":"UT"}}
        },"stopList":{
          "BUSMK":{"name":{"en":"Mong Kok","zh":"旺角"},"location":{"lat":22.33,"lng":114.17}},
          "X":{"name":{"en":"X","zh":"乙"},"location":{"lat":22.34,"lng":114.17}},
          "MOK":{"name":{"en":"Mong Kok","zh":"旺角"},"location":{"lat":22.319,"lng":114.169}},
          "YMT":{"name":{"en":"Yau Ma Tei","zh":"油麻地"},"location":{"lat":22.313,"lng":114.170}}
        },"serviceDayMap":{},"holidays":[]}
        """#
        let index = try TransportDB.decode(Data(json.utf8)).allStopIndex
        XCTAssertEqual(StopSearch.exactSite("旺角站", in: index)?.location.lat, 22.319)
        XCTAssertEqual(StopSearch.exactSite("mong kok", in: index)?.location.lat, 22.319)
        XCTAssertNil(StopSearch.exactSite("佐敦", in: index))
        XCTAssertEqual(StopSearch.partialSite("Mong", in: index)?.location.lat, 22.319)
        XCTAssertNil(StopSearch.partialSite("旺", in: index), "one character matches too much")
    }

    @MainActor
    private func waitForStopSearch(_ search: StopSearchModel) async {
        await waitUntil { !search.isSearching }
    }

    @MainActor
    func testSearchingAStopListsTheStopsAroundItAndFilters() async throws {
        let db = try Self.fixture()
        let search = StopSearchModel()
        search.placeLookup = { _ in XCTFail("an exact stop name needs no map lookup"); return nil }
        search.query = "乙"
        search.setRadius(1_000, db: db)
        search.search(db: db, language: .zh)
        await waitForStopSearch(search)
        XCTAssertEqual(search.place?.name, "乙")
        XCTAssertEqual(search.stops.first?.site.name.zh, "乙")
        XCTAssertTrue(search.stops.allSatisfy { $0.distance <= 1_000 })

        search.mode = .mtr
        XCTAssertTrue(search.visibleStops.isEmpty)
        search.mode = .bus
        XCTAssertFalse(search.visibleStops.isEmpty)
    }

    @MainActor
    func testAPlaceIsLookedUpOnTheMapAndUnknownTextIsReported() async throws {
        let db = try Self.fixture()
        let search = StopSearchModel()
        search.placeLookup = { $0 == "朗豪坊" ? ResolvedPlace(name: "朗豪坊", location: StopLocation(lat: 22.2505, lng: 114.250)) : nil }
        search.query = "朗豪坊"
        search.search(db: db, language: .zh)
        await waitForStopSearch(search)
        XCTAssertEqual(search.stops.first?.site.name.zh, "站一")

        search.query = "沒有這個地方"
        search.search(db: db, language: .zh)
        await waitForStopSearch(search)
        XCTAssertNil(search.place)
        XCTAssertTrue(search.stops.isEmpty)
        XCTAssertNotNil(search.message)
    }

    @MainActor
    func testNicknamesAreExpandedByTheAIBeforeTheMapLookup() async throws {
        FakeDeepSeek.start(intent: #"{"origin":null,"destination":"香港理工大學","preference":"fastest"}"#)
        defer { FakeDeepSeek.stop() }
        let db = try Self.fixture()
        let search = StopSearchModel()
        let polyU = StopLocation(lat: 22.2505, lng: 114.250)
        search.placeLookup = { text in
            text == "香港理工大學" ? ResolvedPlace(name: "PolyU", location: polyU)
                                   : ResolvedPlace(name: "循道衛理大廈", location: StopLocation(lat: 22.40, lng: 114.10))
        }
        search.query = "理大"
        search.search(db: db, language: .zh, ai: DeepSeekClient(apiKey: "test-key"))
        await waitForStopSearch(search)
        XCTAssertEqual(search.place?.name, "香港理工大學")
        XCTAssertEqual(search.place?.location, polyU)
    }

    @MainActor
    func testStationsAreDrawnLastAndTheListIsNeverCutShort() async throws {
        let db = try Self.fixture()
        let search = StopSearchModel()
        search.placeLookup = { _ in ResolvedPlace(name: "區", location: StopLocation(lat: 22.31, lng: 114.17)) }
        search.query = "某地"
        search.setRadius(1_000, db: db)
        await waitForStopSearch(search)
        search.search(db: db, language: .zh)
        await waitForStopSearch(search)
        XCTAssertEqual(search.stops.count, search.visibleStops.count)
        XCTAssertLessThanOrEqual(search.mapStops.count, StopSearchModel.maxMapStops)
    }

    @MainActor
    func testChangingTheRadiusSearchesAgain() async throws {
        let db = try Self.fixture()
        let search = StopSearchModel()
        search.query = "站一"
        search.search(db: db, language: .zh)
        await waitForStopSearch(search)
        let near = search.stops.count
        search.setRadius(1_000, db: db)
        await waitForStopSearch(search)
        XCTAssertEqual(search.radius, 1_000)
        XCTAssertGreaterThanOrEqual(search.stops.count, near)
    }

    @MainActor
    func testPlanningFromAStopRoutesFromHere() async throws {
        let db = try Self.fixture()
        let planner = RoutePlannerModel()
        planner.originText = "舊起點"
        let stop = ResolvedPlace(name: "站二", location: location("BBB", in: db))
        planner.route(to: stop, db: db, language: .zh, currentLocation: { Self.here }, ai: nil)
        await waitUntil { planner.phase == .done || planner.isFailed }
        XCTAssertEqual(planner.destinationText, "站二")
        XCTAssertEqual(planner.originText, "")
        XCTAssertEqual(planner.journeys.first?.rides.first?.route, "XYL")
    }

    // MARK: AI in both entry points

    private static let here = CLLocation(latitude: 22.250, longitude: 114.250)

    @MainActor
    private func waitUntil(_ done: () -> Bool) async {
        for _ in 0..<500 where !done() {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    @MainActor
    func testSearchBarIsAnalysedByTheAI() async throws {
        FakeDeepSeek.start(intent: #"{"origin":"站一","destination":"站二","preference":"fastest"}"#)
        defer { FakeDeepSeek.stop() }
        let db = try Self.fixture()
        let planner = RoutePlannerModel()
        planner.destinationText = "二站"
        planner.search(db: db, language: .zh, currentLocation: { Self.here },
                       ai: DeepSeekClient(apiKey: "test-key"))
        await waitUntil { planner.explanation != nil || planner.isFailed }

        XCTAssertEqual(planner.journeys.first?.rides.first?.route, "XYL")
        XCTAssertEqual(planner.explanation, FakeDeepSeek.advice)
        // The AI wanted a start, but an empty box means the current location.
        XCTAssertEqual(planner.origin?.name, "我的位置")
        let sent = FakeDeepSeek.bodies.joined()
        XCTAssertTrue(sent.contains("Start: current location"))
        XCTAssertFalse(sent.contains("22.25"), "coordinates must not reach the AI")
        XCTAssertFalse(sent.contains("114.25"), "coordinates must not reach the AI")
    }

    @MainActor
    func testAIBoxFillsInTheSearchBar() async throws {
        FakeDeepSeek.start(intent: #"{"origin":"站一","destination":"站二","preference":"fewerTransfers"}"#)
        defer { FakeDeepSeek.stop() }
        let db = try Self.fixture()
        let planner = RoutePlannerModel()
        planner.chatText = "由一站去二站唔想轉車"
        planner.sendChat(db: db, language: .zh, currentLocation: { nil }, ai: DeepSeekClient(apiKey: "test-key"))
        await waitUntil { planner.explanation != nil || planner.isFailed }

        XCTAssertEqual(planner.originText, "站一")
        XCTAssertEqual(planner.destinationText, "站二")
        XCTAssertEqual(planner.preference, .fewerTransfers)
        XCTAssertEqual(planner.chatText, "")
        XCTAssertEqual(planner.lastChat, "由一站去二站唔想轉車")
        XCTAssertEqual(planner.explanation, FakeDeepSeek.advice)
    }

    @MainActor
    func testFailedAICallFallsBackToBasicParsing() async throws {
        FakeDeepSeek.start(intent: nil)
        defer { FakeDeepSeek.stop() }
        let db = try Self.fixture()
        let planner = RoutePlannerModel()
        planner.originText = "站一"
        planner.destinationText = "站二"
        planner.search(db: db, language: .zh, currentLocation: { nil }, ai: DeepSeekClient(apiKey: "test-key"))
        await waitUntil { planner.phase == .done || planner.isFailed }

        XCTAssertEqual(planner.journeys.first?.rides.first?.route, "XYL")
        XCTAssertNotNil(planner.aiNotice)
    }

    @MainActor
    func testNoLocationAsksForAStart() async throws {
        let db = try Self.fixture()
        let planner = RoutePlannerModel()
        planner.destinationText = "站二"
        planner.search(db: db, language: .zh, currentLocation: { nil }, ai: nil)
        await waitUntil { planner.isFailed }
        XCTAssertTrue(planner.isFailed)
        XCTAssertTrue(planner.journeys.isEmpty)
    }

    // MARK: Request parsing

    func testOfflineParser() {
        XCTAssertEqual(TripIntentParser.parse("由旺角去理大"), TripIntent(origin: "旺角", destination: "理大"))
        XCTAssertEqual(TripIntentParser.parse("去機場最快"), TripIntent(origin: nil, destination: "機場"))
        XCTAssertEqual(TripIntentParser.parse("沙田到中環 唔想轉車"),
                       TripIntent(origin: "沙田", destination: "中環", preference: .fewerTransfers))
        XCTAssertEqual(TripIntentParser.parse("from Mong Kok to Central"),
                       TripIntent(origin: "Mong Kok", destination: "Central"))
        XCTAssertEqual(TripIntentParser.parse("我的位置去九龍塘少行路"),
                       TripIntent(origin: nil, destination: "九龍塘", preference: .lessWalking))
        XCTAssertEqual(TripIntentParser.parse("時代廣場"), TripIntent(origin: nil, destination: "時代廣場"))
        XCTAssertNil(TripIntentParser.parse("   "))
    }

    func testDeepSeekReplyDecoding() {
        let fenced = "```json\n{\"origin\": null, \"destination\": \"香港理工大學\", \"preference\": \"fewerTransfers\"}\n```"
        XCTAssertEqual(DeepSeekClient.decodeIntent(fenced),
                       TripIntent(origin: nil, destination: "香港理工大學", preference: .fewerTransfers))
        XCTAssertEqual(DeepSeekClient.decodeIntent(#"{"origin":"我的位置","destination":"旺角","preference":"odd"}"#),
                       TripIntent(origin: nil, destination: "旺角", preference: .fastest))
        XCTAssertNil(DeepSeekClient.decodeIntent("Sorry, I can't help with that."))
    }

    func testDeepSeekCompletionParsing() throws {
        let ok = #"{"choices":[{"message":{"role":"assistant","content":" 你好 "}}]}"#
        XCTAssertEqual(try DeepSeekClient.parseCompletion(Data(ok.utf8), status: 200), "你好")
        let unauthorized = #"{"error":{"message":"Authentication Fails"}}"#
        XCTAssertThrowsError(try DeepSeekClient.parseCompletion(Data(unauthorized.utf8), status: 401)) { error in
            XCTAssertTrue(error.localizedDescription.contains("invalid"))
        }
    }

    func testSummaryContainsNoCoordinates() throws {
        let (planner, db) = try planner()
        let departure = Self.hongKong(hour: 12)
        let journeys = planner.plan(from: location("A", in: db), to: location("F", in: db), departure: departure)
        let summary = DeepSeekClient.summary(of: journeys, preference: .fastest, now: departure) { $0 }
        XCTAssertTrue(summary.contains("KMB·LWB 1 from A to C"))
        XCTAssertFalse(summary.contains("22.3"))
        XCTAssertFalse(summary.contains("114.1"))
    }
}

private extension RoutePlannerModel {
    var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }
}

/// Stands in for api.deepseek.com, and refuses every other host so tests stay offline.
private final class FakeDeepSeek: URLProtocol {
    static let advice = "建議乘搭第一個方案。"
    nonisolated(unsafe) private static var intent: String?
    nonisolated(unsafe) static var bodies: [String] = []
    nonisolated(unsafe) static var picks = #"{"picks":[]}"#
    nonisolated(unsafe) static var places = #"{"places":[]}"#

    static func start(intent: String?) {
        self.intent = intent
        bodies = []
        URLProtocol.registerClass(FakeDeepSeek.self)
    }

    static func stop() {
        URLProtocol.unregisterClass(FakeDeepSeek.self)
        places = #"{"places":[]}"#
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, url.host == "api.deepseek.com" else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let body = Self.body(of: request)
        Self.bodies.append(body)
        let isIntent = body.contains("route planner.\\nReply with one JSON")
        let isPicking = body.contains("choose from real places")
        let isNaming = body.contains("from your own knowledge")
        let content = isIntent ? Self.intent : isPicking ? Self.picks : isNaming ? Self.places : Self.advice
        let payload: [String: Any] = ["choices": [["message": ["content": content ?? ""]]]]
        let response = HTTPURLResponse(url: url, statusCode: content == nil ? 500 : 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: payload)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func body(of request: URLRequest) -> String {
        if let data = request.httpBody { return String(decoding: data, as: UTF8.self) }
        guard let stream = request.httpBodyStream else { return "" }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return String(decoding: data, as: UTF8.self)
    }
}

private actor SearchLog {
    private(set) var terms: [String] = []
    func add(_ term: String) { terms.append(term) }
}

private final class FakeLocationManager: CLLocationManager {
    private let status: CLAuthorizationStatus
    private(set) var requests = 0
    private(set) var permissionPrompts = 0
    private(set) var trackingStarts = 0
    private(set) var trackingStops = 0

    init(status: CLAuthorizationStatus) {
        self.status = status
        super.init()
    }

    override var authorizationStatus: CLAuthorizationStatus { status }
    override func requestLocation() { requests += 1 }
    override func requestWhenInUseAuthorization() { permissionPrompts += 1 }
    override func startUpdatingLocation() { trackingStarts += 1 }
    override func stopUpdatingLocation() { trackingStops += 1 }
}
