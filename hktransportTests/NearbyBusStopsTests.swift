import XCTest

@testable import hktransport

final class NearbyBusStopsTests: XCTestCase {
    static func fixture() throws -> TransportDB {
        let json = #"""
        {"routeList":{
          "bus":{"route":"2","co":["kmb"],"orig":{"en":"A","zh":"甲"},"dest":{"en":"B","zh":"乙"},"serviceType":"1","stops":{"kmb":["A","B","A"]},"bound":{"kmb":"O"}},
          "joint":{"route":"10","co":["kmb","ctb"],"orig":{"en":"A","zh":"甲"},"dest":{"en":"E","zh":"戊"},"serviceType":"1","stops":{"kmb":["A","B"],"ctb":["C","D","E"]},"bound":{"kmb":"O","ctb":"I"}},
          "minibus":{"route":"1","co":["gmb"],"orig":{"en":"G","zh":"庚"},"dest":{"en":"E","zh":"戊"},"serviceType":"1","stops":{"gmb":["G","E"]},"bound":{"gmb":"O"}},
          "invalid":{"route":"3","co":["kmb"],"orig":{"en":"X","zh":"無"},"dest":{"en":"E","zh":"戊"},"serviceType":"1","stops":{"kmb":["INVALID","MISSING","E"]},"bound":{"kmb":"O"}}
        },"stopList":{
          "A":{"name":{"en":"A","zh":"甲"},"location":{"lat":22.3,"lng":114.17}},
          "B":{"name":{"en":"B","zh":"乙"},"location":{"lat":22.301,"lng":114.17}},
          "C":{"name":{"en":"C","zh":"丙"},"location":{"lat":22.302,"lng":114.17}},
          "D":{"name":{"en":"D","zh":"丁"},"location":{"lat":22.32,"lng":114.17}},
          "E":{"name":{"en":"E","zh":"戊"},"location":{"lat":22.3,"lng":114.17}},
          "G":{"name":{"en":"G","zh":"庚"},"location":{"lat":22.3,"lng":114.17}},
          "INVALID":{"name":{"en":"X","zh":"無"},"location":{"lat":91,"lng":114.17}},
          "MISSING":{"name":{"en":"M","zh":"缺"}}
        }}
        """#
        return try TransportDB.decode(Data(json.utf8))
    }

    func testIndexContainsOnlyBoardableBusStopsWithValidCoordinates() throws {
        let db = try Self.fixture()
        XCTAssertEqual(Set(db.busStopIndex.sites.map(\.id)), ["A", "B", "C", "D"])
        let a = try XCTUnwrap(db.busStopIndex.sites.first { $0.id == "A" })
        XCTAssertEqual(a.routeNumbers, ["2", "10"])
        XCTAssertEqual(a.visits.filter { $0.routeKey == "bus" }.map(\.seq), [0])
    }

    func testNearbySortsByDistanceBeforeApplyingTheLimit() throws {
        let db = try Self.fixture()
        let ranked = db.busStopIndex.nearby(to: StopLocation(lat: 22.3, lng: 114.17), radius: 500, limit: 2)
        XCTAssertEqual(ranked.map(\.id), ["A", "B"])
        XCTAssertEqual(ranked.first?.distance ?? -1, 0, accuracy: 0.01)
        XCTAssertTrue(ranked[1].distance > 100 && ranked[1].distance < 120)
        XCTAssertTrue(db.busStopIndex.nearby(to: StopLocation(lat: 91, lng: 0)).isEmpty)
        XCTAssertTrue(db.busStopIndex.nearby(to: StopLocation(lat: 0, lng: 0)).isEmpty)
    }

    func testJointRouteKeepsTheSelectedOperatorsOwnStopSequence() throws {
        let db = try Self.fixture()
        let site = try XCTUnwrap(db.busStopIndex.sites.first { $0.id == "D" })
        let visit = try XCTUnwrap(site.visits.first)
        let route = try XCTUnwrap(visit.route(in: db))
        XCTAssertEqual(visit.co, .ctb)
        XCTAssertEqual(visit.seq, 1)
        XCTAssertEqual(route.operators, [.ctb])
        XCTAssertEqual(route.stopIDs[visit.seq], "D")
        XCTAssertEqual(route.bound["ctb"], "I")
    }
}
