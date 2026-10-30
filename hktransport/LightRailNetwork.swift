import Foundation
import SwiftUI

enum LightRailNetwork {
    static func normalizedCode(_ code: String) -> Int? {
        Int(code.uppercased().replacingOccurrences(of: "LR", with: ""))
    }

    static func search(_ query: String) -> [MTRMapStation] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return [] }
        return stations.filter { station in
            [station.code, station.name.en, station.name.zh].contains { $0.localizedCaseInsensitiveContains(text) }
                || normalizedCode(text) == normalizedCode(station.code)
                || station.lines.contains(where: { $0.lowercased().hasPrefix(text.lowercased()) })
        }.sorted { $0.name.en.localizedStandardCompare($1.name.en) == .orderedAscending }
    }

    static func routeColor(_ code: String) -> Color {
        switch code {
        case "505": return .red
        case "507": return .green
        case "610": return Color(red: 0.45, green: 0.16, blue: 0.10)
        case "614": return .cyan
        case "614P": return .pink
        case "615": return .yellow
        case "615P": return .blue
        case "705": return Color(red: 0.35, green: 0.7, blue: 0.15)
        case "706": return Color(red: 0.6, green: 0.3, blue: 0.65)
        case "751": return .orange
        case "761P": return .purple
        default: return .gray
        }
    }

    // Coordinates are in the supplied PDF's 1200 × 561 point page.
    static let stations: [MTRMapStation] = [
        MTRMapStation(code: "LR1", name: Name(en: "Tuen Mun Ferry Pier", zh: "屯門碼頭"), x: 88, y: 242, lines: ["506P*", "507", "507P*", "610", "614", "614P", "615", "615P", "751*"]),
        MTRMapStation(code: "LR10", name: Name(en: "Melody Garden", zh: "美樂"), x: 88, y: 179, lines: ["506P*", "610", "615", "615P"]),
        MTRMapStation(code: "LR15", name: Name(en: "Butterfly", zh: "蝴蝶"), x: 115.5, y: 139, lines: ["506P*", "610", "615", "615P"]),
        MTRMapStation(code: "LR20", name: Name(en: "Light Rail Depot", zh: "輕鐵車廠"), x: 164.5, y: 139, lines: ["506P*", "610", "615", "615P"]),
        MTRMapStation(code: "LR30", name: Name(en: "Lung Mun", zh: "龍門"), x: 214, y: 139, lines: ["506P*", "610", "615", "615P"]),
        MTRMapStation(code: "LR40", name: Name(en: "Tsing Shan Tsuen", zh: "青山村"), x: 267.5, y: 139, lines: ["506P*", "610", "615", "615P"]),
        MTRMapStation(code: "LR50", name: Name(en: "Tsing Wun", zh: "青雲"), x: 319.5, y: 139, lines: ["506P*", "610", "615", "615P"]),
        MTRMapStation(code: "LR60", name: Name(en: "Kin On", zh: "建安"), x: 350, y: 221.5, lines: ["505", "506P*"]),
        MTRMapStation(code: "LR70", name: Name(en: "Ho Tin", zh: "河田"), x: 372.5, y: 285, lines: ["507", "507P*", "751", "751*"]),
        MTRMapStation(code: "LR75", name: Name(en: "Choy Yee Bridge", zh: "蔡意橋"), x: 425, y: 285, lines: ["507", "507P*", "751", "751*"]),
        MTRMapStation(code: "LR80", name: Name(en: "Affluence", zh: "澤豐"), x: 499.5, y: 285, lines: ["610", "610P*", "751", "751*"]),
        MTRMapStation(code: "LR90", name: Name(en: "Tuen Mun Hospital", zh: "屯門醫院"), x: 553, y: 285, lines: ["610", "610P*", "751", "751*"]),
        MTRMapStation(code: "LR100", name: Name(en: "Siu Hong", zh: "兆康"), x: 627, y: 275, lines: ["505", "506P*", "507P*", "610", "610P*", "614", "614P", "615", "615P", "720*", "751", "751*", "SPR"]),
        MTRMapStation(code: "LR110", name: Name(en: "Kei Lun", zh: "麒麟"), x: 628, y: 232, lines: ["505", "610P*", "615P"]),
        MTRMapStation(code: "LR120", name: Name(en: "Ching Chung", zh: "青松"), x: 607.5, y: 182, lines: ["505", "507P*", "610P*", "615", "615P"]),
        MTRMapStation(code: "LR130", name: Name(en: "Kin Sang", zh: "建生"), x: 607.5, y: 142.5, lines: ["505", "507P*", "610P*", "615", "615P"]),
        MTRMapStation(code: "LR140", name: Name(en: "Tin King", zh: "田景"), x: 607.5, y: 102.5, lines: ["505", "507", "507P*", "610P*", "615", "615P"]),
        MTRMapStation(code: "LR150", name: Name(en: "Leung King", zh: "良景"), x: 573, y: 62.5, lines: ["505", "507", "507P*", "610P*", "615", "615P"]),
        MTRMapStation(code: "LR160", name: Name(en: "San Wai", zh: "新圍"), x: 534, y: 62.5, lines: ["505", "507", "507P*", "610P*", "615", "615P"]),
        MTRMapStation(code: "LR170", name: Name(en: "Shek Pai", zh: "石排"), x: 427.5, y: 135.5, lines: ["505", "610", "615", "615P"]),
        MTRMapStation(code: "LR180", name: Name(en: "Shan King (North)", zh: "山景(北)"), x: 396, y: 101, lines: ["505"]),
        MTRMapStation(code: "LR190", name: Name(en: "Shan King (South)", zh: "山景(南)"), x: 364.5, y: 101, lines: ["505"]),
        MTRMapStation(code: "LR200", name: Name(en: "Ming Kum", zh: "鳴琴"), x: 372.5, y: 135.5, lines: ["505", "610", "615", "615P"]),
        MTRMapStation(code: "LR212", name: Name(en: "Tai Hing (North)", zh: "大興(北)"), x: 467.5, y: 192, lines: ["507", "507P*", "610", "610P*"]),
        MTRMapStation(code: "LR220", name: Name(en: "Tai Hing (South)", zh: "大興(南)"), x: 467.5, y: 225.5, lines: ["507", "507P*", "610", "610P*"]),
        MTRMapStation(code: "LR230", name: Name(en: "Ngan Wai", zh: "銀圍"), x: 467.5, y: 256.5, lines: ["507", "507P*", "610", "610P*"]),
        MTRMapStation(code: "LR240", name: Name(en: "Siu Hei", zh: "兆禧"), x: 88, y: 304, lines: ["507", "507P*", "614", "614P", "751*"]),
        MTRMapStation(code: "LR250", name: Name(en: "Hoi Wong Road", zh: "海皇路"), x: 118.5, y: 340.5, lines: ["507", "507P*", "614", "614P", "751*"]),
        MTRMapStation(code: "LR260", name: Name(en: "Goodview Garden", zh: "豐景園"), x: 160.5, y: 340.5, lines: ["507", "507P*", "614", "614P", "751*"]),
        MTRMapStation(code: "LR265", name: Name(en: "Siu Lun", zh: "兆麟"), x: 217, y: 338, lines: ["505", "507", "507P*", "614", "614P", "751*"]),
        MTRMapStation(code: "LR270", name: Name(en: "On Ting", zh: "安定"), x: 264.5, y: 336, lines: ["505", "507", "507P*", "614", "614P", "751", "751*"]),
        MTRMapStation(code: "LR275", name: Name(en: "Yau Oi", zh: "友愛"), x: 264.5, y: 291, lines: ["751"]),
        MTRMapStation(code: "LR280", name: Name(en: "Town Centre", zh: "市中心"), x: 311, y: 337, lines: ["505", "507", "507P*", "614", "614P", "751", "751*"]),
        MTRMapStation(code: "LR295", name: Name(en: "Tuen Mun", zh: "屯門"), x: 350, y: 309.5, lines: ["505", "506P*", "507", "507P*", "751", "751*"]),
        MTRMapStation(code: "LR300", name: Name(en: "Pui To", zh: "杯渡"), x: 353, y: 389, lines: ["506P*", "614", "614P"]),
        MTRMapStation(code: "LR310", name: Name(en: "Hoh Fuk Tong", zh: "何福堂"), x: 398, y: 404, lines: ["506P*", "614", "614P"]),
        MTRMapStation(code: "LR320", name: Name(en: "San Hui", zh: "新墟"), x: 445.5, y: 404, lines: ["506P*", "614", "614P"]),
        MTRMapStation(code: "LR330", name: Name(en: "Prime View", zh: "景峰"), x: 493.5, y: 404, lines: ["506P*", "614", "614P"]),
        MTRMapStation(code: "LR340", name: Name(en: "Fung Tei", zh: "鳳地"), x: 558, y: 404, lines: ["506P*", "614", "614P"]),
        MTRMapStation(code: "LR350", name: Name(en: "Lam Tei", zh: "藍地"), x: 661, y: 291, lines: ["610", "614", "615", "720*", "751", "751*", "SPR"]),
        MTRMapStation(code: "LR360", name: Name(en: "Nai Wai", zh: "泥圍"), x: 690, y: 291, lines: ["610", "614", "615", "720*", "751", "751*", "SPR"]),
        MTRMapStation(code: "LR370", name: Name(en: "Chung Uk Tsuen", zh: "鍾屋村"), x: 728, y: 291, lines: ["610", "614", "615", "720*", "751", "751*", "SPR"]),
        MTRMapStation(code: "LR380", name: Name(en: "Hung Shui Kiu", zh: "洪水橋"), x: 791.5, y: 291, lines: ["610", "614", "615", "720*", "751", "751*", "SPR"]),
        MTRMapStation(code: "LR390", name: Name(en: "Tong Fong Tsuen", zh: "塘坊村"), x: 1059, y: 291, lines: ["610", "614", "615", "761P"]),
        MTRMapStation(code: "LR400", name: Name(en: "Ping Shan", zh: "屏山"), x: 1117, y: 291, lines: ["610", "614", "615", "761P"]),
        MTRMapStation(code: "LR425", name: Name(en: "Hang Mei Tsuen", zh: "坑尾村"), x: 929.5, y: 247.5, lines: ["720*", "751", "751*", "761P", "SPR"]),
        MTRMapStation(code: "LR430", name: Name(en: "Tin Shui Wai", zh: "天水圍"), x: 985, y: 197, lines: ["705", "706", "751", "751*", "751P", "SPR"]),
        MTRMapStation(code: "LR435", name: Name(en: "Tin Tsz", zh: "天慈"), x: 1027.5, y: 200, lines: ["705", "706", "751", "751*", "751P", "SPR"]),
        MTRMapStation(code: "LR445", name: Name(en: "Tin Yiu", zh: "天耀"), x: 896.5, y: 206.5, lines: ["705", "706", "720*", "761P"]),
        MTRMapStation(code: "LR448", name: Name(en: "Locwood", zh: "樂湖"), x: 857, y: 206.5, lines: ["705", "706", "720*", "761P"]),
        MTRMapStation(code: "LR450", name: Name(en: "Tin Wu", zh: "天湖"), x: 1059, y: 200, lines: ["705", "706", "751", "751*", "751P", "SPR"]),
        MTRMapStation(code: "LR455", name: Name(en: "Ginza", zh: "銀座"), x: 1090.5, y: 200, lines: ["705", "706", "751", "751*", "751P", "SPR"]),
        MTRMapStation(code: "LR460", name: Name(en: "Tin Shui", zh: "天瑞"), x: 819.5, y: 172, lines: ["705", "706", "720*", "761P"]),
        MTRMapStation(code: "LR468", name: Name(en: "Chung Fu", zh: "頌富"), x: 823, y: 96, lines: ["705", "706", "751", "751*", "751P", "761P", "SPR"]),
        MTRMapStation(code: "LR480", name: Name(en: "Tin Fu", zh: "天富"), x: 853.5, y: 55.5, lines: ["705", "706", "751", "751*", "751P", "761P", "SPR"]),
        MTRMapStation(code: "LR490", name: Name(en: "Chestwood", zh: "翠湖"), x: 928.5, y: 139.5, lines: ["720*", "751", "751*", "751P", "SPR"]),
        MTRMapStation(code: "LR500", name: Name(en: "Tin Wing", zh: "天榮"), x: 1116, y: 161.5, lines: ["705", "706", "720*", "751", "751*", "751P", "SPR"]),
        MTRMapStation(code: "LR510", name: Name(en: "Tin Yuet", zh: "天悅"), x: 1119, y: 96, lines: ["705", "706"]),
        MTRMapStation(code: "LR520", name: Name(en: "Tin Sau", zh: "天秀"), x: 1091, y: 55.5, lines: ["705", "706"]),
        MTRMapStation(code: "LR530", name: Name(en: "Wetland Park", zh: "濕地公園"), x: 1035.5, y: 55.5, lines: ["705", "706"]),
        MTRMapStation(code: "LR540", name: Name(en: "Tin Heng", zh: "天恒"), x: 986, y: 55.5, lines: ["705", "706"]),
        MTRMapStation(code: "LR550", name: Name(en: "Tin Yat", zh: "天逸"), x: 928.5, y: 55.5, lines: ["705", "706", "751", "751*", "751P", "761P", "SPR"]),
        MTRMapStation(code: "LR560", name: Name(en: "Shui Pin Wai", zh: "水邊圍"), x: 1117, y: 382, lines: ["610", "614", "615", "761P"]),
        MTRMapStation(code: "LR570", name: Name(en: "Fung Nin Road", zh: "豐年路"), x: 1060, y: 382, lines: ["610", "614", "615", "761P"]),
        MTRMapStation(code: "LR580", name: Name(en: "Hong Lok Road", zh: "康樂路"), x: 1001.5, y: 382, lines: ["610", "614", "615", "761P"]),
        MTRMapStation(code: "LR590", name: Name(en: "Tai Tong Road", zh: "大棠路"), x: 943.5, y: 382, lines: ["610", "614", "615", "761P"]),
        MTRMapStation(code: "LR600", name: Name(en: "Yuen Long", zh: "元朗"), x: 878.5, y: 381, lines: ["610", "614", "615", "761P"]),
        MTRMapStation(code: "LR920", name: Name(en: "Sam Shing", zh: "三聖"), x: 196, y: 395.5, lines: ["505"]),
    ]
}

struct LightRailArrival: Identifiable, Sendable {
    let id: String
    let route: String
    let destination: Name
    let time: Name
    let date: Date?
    let cars: Int
    let remark: Name
}

struct LightRailPlatform: Identifiable, Sendable {
    let id: String
    let serviceEnded: Bool
    let arrivals: [LightRailArrival]
}

struct LightRailBoard: Sendable {
    let platforms: [LightRailPlatform]
    let updatedAt: Date?
}
