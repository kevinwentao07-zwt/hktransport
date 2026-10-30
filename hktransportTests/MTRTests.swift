import XCTest

@testable import hktransport

final class MTRTests: XCTestCase {
    func testMapStationTargetsAndInterchanges() {
        let stations = MTRNetwork.stations
        XCTAssertEqual(Set(stations.map(\.code)).count, stations.count)
        XCTAssertTrue(stations.allSatisfy { (0...2000).contains($0.x) && (0...1172).contains($0.y) && !$0.lines.isEmpty })
        XCTAssertEqual(Set(stations.first { $0.code == "ADM" }!.lines), ["EAL", "ISL", "SIL", "TWL"])
        XCTAssertEqual(stations.first { $0.code == "RAC" }?.lines, ["EAL"])
    }

    func testStationSearchKeepsNamesCodesAndLines() {
        for query in ["金鐘", "admiralty", "adm"] {
            XCTAssertTrue(MTRNetwork.search(query).contains { $0.code == "ADM" })
        }
        XCTAssertTrue(MTRNetwork.search("TML").allSatisfy { $0.lines.contains("TML") })
        XCTAssertFalse(MTRNetwork.search("TML").isEmpty)
        XCTAssertTrue(MTRNetwork.search("荔景").contains { $0.code == "LAK" })
        XCTAssertTrue(MTRNetwork.search("觀塘線").contains { $0.code == "KOT" })
        XCTAssertTrue(MTRNetwork.search("   ").isEmpty)
        XCTAssertTrue(MTRNetwork.search("no such station").isEmpty)
    }

    func testBothDirectionsAndBranchDestinations() throws {
        let data = Data(#"{"status":1,"isdelay":"Y","data":{"EAL-KOT":{"curr_time":"2026-10-30 13:00:00","UP":[{"time":"2026-10-30 13:02:00","plat":"1","dest":"LOW"},{"time":"2026-10-30 13:05:00","plat":"1","dest":"LMC"}],"DOWN":[{"time":"2026-10-30 13:03:00","plat":"2","dest":"ADM"}]}}}"#.utf8)
        let stops = ["LOW": Stop(name: Name(en: "Lo Wu", zh: "羅湖")),
                     "LMC": Stop(name: Name(en: "Lok Ma Chau", zh: "落馬洲"))]
        let board = try ETAService.parseMTRBoard(data, line: "EAL", station: "KOT", stopList: stops)
        XCTAssertEqual(board.up.map(\.dest.zh), ["羅湖", "落馬洲"])
        XCTAssertEqual(board.down.first?.dest.en, "ADM")
        XCTAssertEqual(board.down.first?.remark.en, "Platform 2")
        XCTAssertNotNil(board.updatedAt)
        XCTAssertTrue(board.isDelayed)
    }

    func testServiceNoticeAndMissingStation() throws {
        let notice = try ETAService.parseMTRBoard(Data(#"{"status":0,"message":"Service suspended"}"#.utf8),
                                                  line: "EAL", station: "KOT", stopList: [:])
        XCTAssertEqual(notice.message, "Service suspended")
        XCTAssertTrue(notice.up.isEmpty)
        XCTAssertThrowsError(try ETAService.parseMTRBoard(Data(#"{"status":1,"data":{}}"#.utf8),
                                                        line: "EAL", station: "KOT", stopList: [:]))
    }
}
