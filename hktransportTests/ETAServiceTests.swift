import XCTest

@testable import hktransport

final class ETAServiceTests: XCTestCase {
    private func data(_ json: String) -> Data {
        Data(json.utf8)
    }

    func testParseDateAcceptsEveryFeedFormat() {
        let expected = ETAService.parseDate("2026-10-29T12:00:00+08:00")
        XCTAssertNotNil(expected)
        XCTAssertEqual(ETAService.parseDate("2026-10-29T12:00:00.000+08:00"), expected)
        XCTAssertEqual(ETAService.parseDate("2026-10-29 12:00:00"), expected)
        XCTAssertNil(ETAService.parseDate(""))
    }

    func testKMBKeepsBoundAndNearestSequence() throws {
        let json = """
        {"data":[
          {"dir":"O","seq":3,"eta":"2026-10-29T12:05:00+08:00","rmk_tc":"","rmk_en":"","dest_tc":"尖沙咀","dest_en":"TST"},
          {"dir":"O","seq":9,"eta":"2026-10-29T12:01:00+08:00","rmk_tc":"","rmk_en":"","dest_tc":"尖沙咀","dest_en":"TST"},
          {"dir":"I","seq":3,"eta":"2026-10-29T12:02:00+08:00","rmk_tc":"","rmk_en":"","dest_tc":"X","dest_en":"X"},
          {"dir":"O","seq":3,"eta":null,"rmk_tc":"原定班次","rmk_en":"Scheduled Bus","dest_tc":"尖沙咀","dest_en":"TST"}
        ]}
        """
        let etas = try ETAService.parseKMB(data(json), bound: "O", seq: 2, stopId: "B", stops: ["A", "B", "C"])
        XCTAssertEqual(etas.count, 2)
        XCTAssertEqual(etas.first?.dest.en, "TST")
        XCTAssertEqual(etas.first?.date, ETAService.parseDate("2026-10-29T12:05:00+08:00"))
    }

    func testCTBMatchesEitherDirectionOfCircularBound() throws {
        let json = """
        {"data":[
          {"dir":"O","seq":1,"eta":"2026-10-29T12:05:00+08:00"},
          {"dir":"I","seq":1,"eta":"2026-10-29T12:07:00+08:00"},
          {"dir":"","seq":1,"eta":"2026-10-29T12:09:00+08:00"}
        ]}
        """
        XCTAssertEqual(try ETAService.parseCTB(data(json), bound: "OI", seq: 0).count, 2)
    }

    func testNLBFallsBackToMessage() throws {
        let etas = try ETAService.parseNLB(data(#"{"estimatedArrivals":[],"message":"暫停服務"}"#))
        XCTAssertEqual(etas.count, 1)
        XCTAssertNil(etas[0].date)
        XCTAssertEqual(etas[0].remark.zh, "暫停服務")
    }

    func testGMBFiltersRouteAndStopSequence() throws {
        let json = """
        {"data":[
          {"route_seq":1,"stop_seq":3,"enabled":true,"eta":[{"timestamp":"2026-10-29T12:05:00.000+08:00","remarks_tc":null,"remarks_en":null}]},
          {"route_seq":2,"stop_seq":3,"enabled":true,"eta":[{"timestamp":"2026-10-29T12:06:00.000+08:00"}]},
          {"route_seq":1,"stop_seq":4,"enabled":false,"description_tc":"x","description_en":"x"}
        ]}
        """
        let etas = try ETAService.parseGMB(data(json), bound: "O", seq: 2)
        XCTAssertEqual(etas.count, 1)
        XCTAssertEqual(etas[0].date, ETAService.parseDate("2026-10-29T12:05:00+08:00"))
        XCTAssertEqual(etas[0].remark, .empty)
    }

    func testLightRailMatchesRouteAndDestination() throws {
        let json = """
        {"platform_list":[{"platform_id":1,"route_list":[
          {"route_no":"505","dest_ch":"兆康","dest_en":"Siu Hong","stop":0,"time_en":"3 min","train_length":2},
          {"route_no":"505","dest_ch":"三聖","dest_en":"Sam Shing","stop":0,"time_en":"1 min","train_length":1},
          {"route_no":"505","dest_ch":"兆康","dest_en":"Siu Hong","stop":0,"time_en":"Arriving","train_length":1}
        ]}]}
        """
        let now = Date(timeIntervalSince1970: 0)
        let etas = try ETAService.parseLightRail(data(json), route: "505", dest: Name(en: "Siu Hong", zh: "兆康"), now: now)
        XCTAssertEqual(etas.map(\.date), [now.addingTimeInterval(180), now])
        XCTAssertEqual(etas[0].remark.zh, "1號月台 - ▭▭")
    }

    func testLightRailReportsEndOfService() throws {
        let json = #"{"platform_list":[{"platform_id":1,"end_service_status":1}]}"#
        let etas = try ETAService.parseLightRail(data(json), route: "505", dest: .empty, now: Date())
        XCTAssertEqual(etas.count, 1)
        XCTAssertNil(etas[0].date)
    }

    func testMTRUsesDirectionAndStationNames() throws {
        let json = """
        {"status":1,"data":{"TML-TUM":{
          "UP":[{"time":"2026-10-29 12:03:00","plat":"1","dest":"WKS"}],
          "DOWN":[{"time":"2026-10-29 12:04:00","plat":"2","dest":"TUM"}]
        }}}
        """
        let stops = ["WKS": Stop(name: Name(en: "Wu Kai Sha", zh: "烏溪沙"))]
        let etas = try ETAService.parseMTR(data(json), line: "TML", stopId: "TUM", bound: "UT", stopList: stops)
        XCTAssertEqual(etas.count, 1)
        XCTAssertEqual(etas[0].dest.zh, "烏溪沙")
        XCTAssertEqual(etas[0].remark.en, "Platform 1")
        XCTAssertEqual(etas[0].date, ETAService.parseDate("2026-10-29T12:03:00+08:00"))
    }

    func testMergeDropsNoticesWhenAnyTimeExists() {
        let later = ETA(date: Date(timeIntervalSince1970: 200), remark: .empty, dest: .empty, co: .kmb)
        let sooner = ETA(date: Date(timeIntervalSince1970: 100), remark: .empty, dest: .empty, co: .ctb)
        let notice = ETA(date: nil, remark: Name(en: "n", zh: "n"), dest: .empty, co: .kmb)
        XCTAssertEqual(ETAService.merge([[later, notice], [sooner]]), [sooner, later])
        XCTAssertEqual(ETAService.merge([[notice]]), [notice])
    }

    func testDatabaseDecodesMixedTypesAndSkipsUnsupportedOperators() throws {
        let json = """
        {"routeList":{
          "10+1+A+B":{"route":"10","co":["kmb"],"orig":{"en":"A","zh":"甲"},"dest":{"en":"B","zh":"乙"},"serviceType":"1","stops":{"kmb":["S1","S2"]},"bound":{"kmb":"O"},"gtfsId":"1","nlbId":null},
          "2+1+A+B":{"route":"2","co":["ctb"],"orig":{"en":"A","zh":"甲"},"dest":{"en":"B","zh":"乙"},"serviceType":1,"stops":{"ctb":["S1"]},"bound":{"ctb":"I"},"gtfsId":null,"nlbId":null},
          "F1+1+A+B":{"route":"F1","co":["sunferry"],"orig":{"en":"A","zh":"甲"},"dest":{"en":"B","zh":"乙"},"serviceType":"1","stops":{"sunferry":["S1"]},"bound":{"sunferry":"O"},"gtfsId":null,"nlbId":null}
        },"stopList":{"S1":{"name":{"en":"One","zh":"一"},"location":{"lat":0,"lng":0}}},"holidays":[]}
        """
        let db = try TransportDB.decode(data(json))
        XCTAssertEqual(db.sortedRouteKeys, ["2+1+A+B", "10+1+A+B"])
        XCTAssertEqual(db.routeList["2+1+A+B"]?.serviceType, "1")
        XCTAssertEqual(db.routeList["10+1+A+B"]?.stopIDs, ["S1", "S2"])
    }
}

final class PanelStateTests: XCTestCase {
    func testHoverCollapseRejectsStaleCompletionAfterPointerReenters() {
        var state = PanelState()
        XCTAssertEqual(state.reduce(.pointerEntered), [.cancelHoverCollapse])
        XCTAssertEqual(state.mode, .peek)
        XCTAssertEqual(
            state.reduce(.pointerExited),
            [.cancelHoverCollapse, .scheduleHoverCollapse(revision: 2, delayMilliseconds: 130)]
        )
        _ = state.reduce(.hoverCollapseDelayElapsed(revision: 2))
        XCTAssertEqual(state.mode, .compact)
        XCTAssertEqual(state.windowGeometryPhase, .peek)

        _ = state.reduce(.pointerEntered)
        _ = state.reduce(.hoverCollapseAnimationCompleted(revision: 2))
        XCTAssertEqual(state.mode, .peek)
    }

    func testWorkspaceCloseSequence() {
        var state = PanelState()
        _ = state.reduce(.workspaceOpened)
        XCTAssertEqual(state.windowGeometryPhase, .workspace)
        let effects = state.reduce(.workspaceCloseRequested)
        XCTAssertEqual(state.mode, .closingWorkspace)
        guard case .scheduleWorkspaceClose(let revision, _, _)? = effects.last else {
            return XCTFail("close was not scheduled")
        }
        _ = state.reduce(.workspaceSurfaceCloseDelayElapsed(revision: revision))
        XCTAssertEqual(state.windowGeometryPhase, .peek)
        _ = state.reduce(.workspaceCanvasCloseDelayElapsed(revision: revision))
        XCTAssertEqual(state.windowGeometryPhase, .compact)
    }
}
