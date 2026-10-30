import Foundation
import SwiftUI

enum TransportCategory: String, CaseIterable, Identifiable {
    case saved, bus, minibus, lightRail, mtr, ferry, notice

    var id: String { rawValue }
    var name: Name {
        switch self {
        case .saved: return Name(en: "Saved", zh: "已儲存")
        case .bus: return Name(en: "Bus", zh: "巴士")
        case .minibus: return Name(en: "Minibus", zh: "小巴")
        case .lightRail: return Name(en: "Light Rail", zh: "輕鐵")
        case .mtr: return Name(en: "MTR", zh: "港鐵")
        case .ferry: return Name(en: "Ferry", zh: "渡輪")
        case .notice: return Name(en: "Notice", zh: "通告")
        }
    }
    var icon: String {
        switch self {
        case .saved: return "star.fill"
        case .bus: return "bus.fill"
        case .minibus: return "bus"
        case .lightRail: return "tram.fill"
        case .mtr: return "tram.tunnel.fill"
        case .ferry: return "ferry.fill"
        case .notice: return "bell.badge.fill"
        }
    }
    func includes(_ route: Route) -> Bool {
        switch self {
        case .saved: return true
        case .bus: return route.operators.contains { [.kmb, .ctb, .nlb].contains($0) }
        case .minibus: return route.operators.contains(.gmb)
        case .lightRail: return route.operators.contains(.lightRail)
        case .mtr: return route.operators.contains(.mtr)
        case .ferry: return route.ferryOperator != nil
        case .notice: return false
        }
    }
}

struct MTRMapStation: Identifiable, Equatable {
    let code: String
    let name: Name
    /// Coordinates in the source map's native size (pixels or PDF points).
    let x: CGFloat
    let y: CGFloat
    let lines: [String]
    var id: String { code }
}

enum MTRNetwork {
    static func search(_ query: String) -> [MTRMapStation] {
        let text = normalized(query.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !text.isEmpty else { return [] }
        return stations.filter { station in
            [station.code, station.name.en, station.name.zh]
                .contains { normalized($0).localizedCaseInsensitiveContains(text) }
                || station.lines.contains { code in
                    code.localizedCaseInsensitiveContains(text)
                        || lineName(code).en.localizedCaseInsensitiveContains(text)
                        || normalized(lineName(code).zh).contains(text)
                }
        }.sorted { $0.name.en.localizedStandardCompare($1.name.en) == .orderedAscending }
    }

    private static func normalized(_ text: String) -> String {
        text.replacingOccurrences(of: "茘", with: "荔")
            .replacingOccurrences(of: "線", with: "綫")
    }

    static func lineName(_ code: String) -> Name {
        switch code {
        case "AEL": return Name(en: "Airport Express", zh: "機場快綫")
        case "TCL": return Name(en: "Tung Chung Line", zh: "東涌綫")
        case "DRL": return Name(en: "Disneyland Resort Line", zh: "迪士尼綫")
        case "EAL": return Name(en: "East Rail Line", zh: "東鐵綫")
        case "TML": return Name(en: "Tuen Ma Line", zh: "屯馬綫")
        case "TWL": return Name(en: "Tsuen Wan Line", zh: "荃灣綫")
        case "KTL": return Name(en: "Kwun Tong Line", zh: "觀塘綫")
        case "ISL": return Name(en: "Island Line", zh: "港島綫")
        case "TKL": return Name(en: "Tseung Kwan O Line", zh: "將軍澳綫")
        case "SIL": return Name(en: "South Island Line", zh: "南港島綫")
        default: return Name(en: code, zh: code)
        }
    }

    static func lineColor(_ code: String) -> Color {
        let rgb: UInt32
        switch code {
        case "AEL": rgb = 0x00888A
        case "TCL": rgb = 0xF7941D
        case "DRL": rgb = 0xE868A2
        case "EAL": rgb = 0x53B7E8
        case "TML": rgb = 0xAB4205
        case "TWL": rgb = 0xED1D24
        case "KTL": rgb = 0x00A040
        case "ISL": rgb = 0x007DC5
        case "TKL": rgb = 0x8B3D96
        case "SIL": rgb = 0xB5BD00
        default: rgb = 0x888888
        }
        return Color(red: Double((rgb >> 16) & 255) / 255,
                     green: Double((rgb >> 8) & 255) / 255,
                     blue: Double(rgb & 255) / 255)
    }

    static let stations: [MTRMapStation] = [
        MTRMapStation(code: "ADM", name: Name(en: "Admiralty", zh: "金鐘"), x: 972, y: 887, lines: ["EAL", "ISL", "SIL", "TWL"]),
        MTRMapStation(code: "AIR", name: Name(en: "Airport", zh: "機場"), x: 310, y: 665, lines: ["AEL"]),
        MTRMapStation(code: "AUS", name: Name(en: "Austin", zh: "柯士甸"), x: 922, y: 722, lines: ["TML"]),
        MTRMapStation(code: "AWE", name: Name(en: "AsiaWorld-Expo", zh: "博覽館"), x: 363, y: 588, lines: ["AEL"]),
        MTRMapStation(code: "CAB", name: Name(en: "Causeway Bay", zh: "銅鑼灣"), x: 1162, y: 887, lines: ["ISL"]),
        MTRMapStation(code: "CEN", name: Name(en: "Central", zh: "中環"), x: 878, y: 883, lines: ["ISL", "TWL"]),
        MTRMapStation(code: "CHH", name: Name(en: "Choi Hung", zh: "彩虹"), x: 1530, y: 438, lines: ["KTL"]),
        MTRMapStation(code: "CHW", name: Name(en: "Chai Wan", zh: "柴灣"), x: 1863, y: 1123, lines: ["ISL"]),
        MTRMapStation(code: "CIO", name: Name(en: "City One", zh: "第一城"), x: 1401, y: 104, lines: ["TML"]),
        MTRMapStation(code: "CKT", name: Name(en: "Che Kung Temple", zh: "車公廟"), x: 1351, y: 269, lines: ["TML"]),
        MTRMapStation(code: "CSW", name: Name(en: "Cheung Sha Wan", zh: "長沙灣"), x: 898, y: 438, lines: ["TWL"]),
        MTRMapStation(code: "DIH", name: Name(en: "Diamond Hill", zh: "鑽石山"), x: 1466, y: 439, lines: ["KTL", "TML"]),
        MTRMapStation(code: "DIS", name: Name(en: "Disneyland Resort", zh: "迪士尼"), x: 532, y: 676, lines: ["DRL"]),
        MTRMapStation(code: "ETS", name: Name(en: "East Tsim Sha Tsui", zh: "尖東"), x: 1065, y: 771, lines: ["TML"]),
        MTRMapStation(code: "EXC", name: Name(en: "Exhibition Centre", zh: "會展"), x: 1066, y: 847, lines: ["EAL"]),
        MTRMapStation(code: "FAN", name: Name(en: "Fanling", zh: "粉嶺"), x: 887, y: 104, lines: ["EAL"]),
        MTRMapStation(code: "FOH", name: Name(en: "Fortress Hill", zh: "炮台山"), x: 1351, y: 887, lines: ["ISL"]),
        MTRMapStation(code: "FOT", name: Name(en: "Fo Tan", zh: "火炭"), x: 1207, y: 197, lines: ["EAL"]),
        MTRMapStation(code: "HAH", name: Name(en: "Hang Hau", zh: "坑口"), x: 1863, y: 582, lines: ["TKL"]),
        MTRMapStation(code: "HEO", name: Name(en: "Heng On", zh: "恆安"), x: 1675, y: 104, lines: ["TML"]),
        MTRMapStation(code: "HFC", name: Name(en: "Heng Fa Chuen", zh: "杏花邨"), x: 1863, y: 1040, lines: ["ISL"]),
        MTRMapStation(code: "HIK", name: Name(en: "Hin Keng", zh: "顯徑"), x: 1321, y: 373, lines: ["TML"]),
        MTRMapStation(code: "HKU", name: Name(en: "HKU", zh: "香港大學"), x: 589, y: 887, lines: ["ISL"]),
        MTRMapStation(code: "HOK", name: Name(en: "Hong Kong", zh: "香港"), x: 878, y: 855, lines: ["AEL", "TCL"]),
        MTRMapStation(code: "HOM", name: Name(en: "Ho Man Tin", zh: "何文田"), x: 1252, y: 663, lines: ["KTL", "TML"]),
        MTRMapStation(code: "HUH", name: Name(en: "Hung Hom", zh: "紅磡"), x: 1163, y: 743, lines: ["EAL", "TML"]),
        MTRMapStation(code: "JOR", name: Name(en: "Jordan", zh: "佐敦"), x: 1032, y: 673, lines: ["TWL"]),
        MTRMapStation(code: "KAT", name: Name(en: "Kai Tak", zh: "啟德"), x: 1466, y: 504, lines: ["TML"]),
        MTRMapStation(code: "KET", name: Name(en: "Kennedy Town", zh: "堅尼地城"), x: 494, y: 887, lines: ["ISL"]),
        MTRMapStation(code: "KOB", name: Name(en: "Kowloon Bay", zh: "九龍灣"), x: 1591, y: 451, lines: ["KTL"]),
        MTRMapStation(code: "KOT", name: Name(en: "Kowloon Tong", zh: "九龍塘"), x: 1207, y: 442, lines: ["EAL", "KTL"]),
        MTRMapStation(code: "KOW", name: Name(en: "Kowloon", zh: "九龍"), x: 729, y: 722, lines: ["AEL", "TCL"]),
        MTRMapStation(code: "KSR", name: Name(en: "Kam Sheung Road", zh: "錦上路"), x: 284, y: 287, lines: ["TML"]),
        MTRMapStation(code: "KWF", name: Name(en: "Kwai Fong", zh: "葵芳"), x: 586, y: 438, lines: ["TWL"]),
        MTRMapStation(code: "KWH", name: Name(en: "Kwai Hing", zh: "葵興"), x: 500, y: 438, lines: ["TWL"]),
        MTRMapStation(code: "KWT", name: Name(en: "Kwun Tong", zh: "觀塘"), x: 1604, y: 567, lines: ["KTL"]),
        MTRMapStation(code: "LAK", name: Name(en: "Lai King", zh: "茘景"), x: 662, y: 443, lines: ["TCL", "TWL"]),
        MTRMapStation(code: "LAT", name: Name(en: "Lam Tin", zh: "藍田"), x: 1604, y: 631, lines: ["KTL"]),
        MTRMapStation(code: "LCK", name: Name(en: "Lai Chi Kok", zh: "茘枝角"), x: 817, y: 438, lines: ["TWL"]),
        MTRMapStation(code: "LET", name: Name(en: "Lei Tung", zh: "利東"), x: 772, y: 1098, lines: ["SIL"]),
        MTRMapStation(code: "LHP", name: Name(en: "LOHAS Park", zh: "康城"), x: 1863, y: 762, lines: ["TKL"]),
        MTRMapStation(code: "LMC", name: Name(en: "Lok Ma Chau", zh: "落馬洲"), x: 651, y: 138, lines: ["EAL"]),
        MTRMapStation(code: "LOF", name: Name(en: "Lok Fu", zh: "樂富"), x: 1268, y: 438, lines: ["KTL"]),
        MTRMapStation(code: "LOP", name: Name(en: "Long Ping", zh: "朗屏"), x: 284, y: 157, lines: ["TML"]),
        MTRMapStation(code: "LOW", name: Name(en: "Lo Wu", zh: "羅湖"), x: 710, y: 104, lines: ["EAL"]),
        MTRMapStation(code: "MEF", name: Name(en: "Mei Foo", zh: "美孚"), x: 741, y: 443, lines: ["TML", "TWL"]),
        MTRMapStation(code: "MKK", name: Name(en: "Mong Kok East", zh: "旺角東"), x: 1207, y: 557, lines: ["EAL"]),
        MTRMapStation(code: "MOK", name: Name(en: "Mong Kok", zh: "旺角"), x: 1036, y: 551, lines: ["KTL", "TWL"]),
        MTRMapStation(code: "MOS", name: Name(en: "Ma On Shan", zh: "馬鞍山"), x: 1766, y: 104, lines: ["TML"]),
        MTRMapStation(code: "NAC", name: Name(en: "Nam Cheong", zh: "南昌"), x: 737, y: 519, lines: ["TCL", "TML"]),
        MTRMapStation(code: "NOP", name: Name(en: "North Point", zh: "北角"), x: 1448, y: 883, lines: ["ISL", "TKL"]),
        MTRMapStation(code: "NTK", name: Name(en: "Ngau Tau Kok", zh: "牛頭角"), x: 1604, y: 503, lines: ["KTL"]),
        MTRMapStation(code: "OCP", name: Name(en: "Ocean Park", zh: "海洋公園"), x: 1032, y: 987, lines: ["SIL"]),
        MTRMapStation(code: "OLY", name: Name(en: "Olympic", zh: "奧運"), x: 733, y: 631, lines: ["TCL"]),
        MTRMapStation(code: "POA", name: Name(en: "Po Lam", zh: "寶琳"), x: 1863, y: 504, lines: ["TKL"]),
        MTRMapStation(code: "PRE", name: Name(en: "Prince Edward", zh: "太子"), x: 1036, y: 494, lines: ["KTL", "TWL"]),
        MTRMapStation(code: "QUB", name: Name(en: "Quarry Bay", zh: "鰂魚涌"), x: 1544, y: 883, lines: ["ISL", "TKL"]),
        MTRMapStation(code: "RAC", name: Name(en: "Racecourse", zh: "馬場"), x: 1239, y: 197, lines: ["EAL"]),
        MTRMapStation(code: "SHM", name: Name(en: "Shek Mun", zh: "石門"), x: 1492, y: 104, lines: ["TML"]),
        MTRMapStation(code: "SHS", name: Name(en: "Sheung Shui", zh: "上水"), x: 799, y: 104, lines: ["EAL"]),
        MTRMapStation(code: "SHT", name: Name(en: "Sha Tin", zh: "沙田"), x: 1207, y: 269, lines: ["EAL"]),
        MTRMapStation(code: "SHW", name: Name(en: "Sheung Wan", zh: "上環"), x: 780, y: 887, lines: ["ISL"]),
        MTRMapStation(code: "SIH", name: Name(en: "Siu Hong", zh: "兆康"), x: 214, y: 217, lines: ["TML"]),
        MTRMapStation(code: "SKM", name: Name(en: "Shek Kip Mei", zh: "石硤尾"), x: 1090, y: 438, lines: ["KTL"]),
        MTRMapStation(code: "SKW", name: Name(en: "Shau Kei Wan", zh: "筲箕灣"), x: 1823, y: 954, lines: ["ISL"]),
        MTRMapStation(code: "SOH", name: Name(en: "South Horizons", zh: "海怡半島"), x: 646, y: 1098, lines: ["SIL"]),
        MTRMapStation(code: "SSP", name: Name(en: "Sham Shui Po", zh: "深水埗"), x: 982, y: 438, lines: ["TWL"]),
        MTRMapStation(code: "STW", name: Name(en: "Sha Tin Wai", zh: "沙田圍"), x: 1351, y: 197, lines: ["TML"]),
        MTRMapStation(code: "SUN", name: Name(en: "Sunny Bay", zh: "欣澳"), x: 474, y: 607, lines: ["DRL", "TCL"]),
        MTRMapStation(code: "SUW", name: Name(en: "Sung Wong Toi", zh: "宋皇臺"), x: 1429, y: 579, lines: ["TML"]),
        MTRMapStation(code: "SWH", name: Name(en: "Sai Wan Ho", zh: "西灣河"), x: 1732, y: 887, lines: ["ISL"]),
        MTRMapStation(code: "SYP", name: Name(en: "Sai Ying Pun", zh: "西營盤"), x: 685, y: 887, lines: ["ISL"]),
        MTRMapStation(code: "TAK", name: Name(en: "Tai Koo", zh: "太古"), x: 1636, y: 887, lines: ["ISL"]),
        MTRMapStation(code: "TAP", name: Name(en: "Tai Po Market", zh: "大埔墟"), x: 1064, y: 104, lines: ["EAL"]),
        MTRMapStation(code: "TAW", name: Name(en: "Tai Wai", zh: "大圍"), x: 1212, y: 342, lines: ["EAL", "TML"]),
        MTRMapStation(code: "TIH", name: Name(en: "Tin Hau", zh: "天后"), x: 1258, y: 887, lines: ["ISL"]),
        MTRMapStation(code: "TIK", name: Name(en: "Tiu Keng Leng", zh: "調景嶺"), x: 1734, y: 686, lines: ["KTL", "TKL"]),
        MTRMapStation(code: "TIS", name: Name(en: "Tin Shui Wai", zh: "天水圍"), x: 250, y: 97, lines: ["TML"]),
        MTRMapStation(code: "TKO", name: Name(en: "Tseung Kwan O", zh: "將軍澳"), x: 1815, y: 695, lines: ["TKL"]),
        MTRMapStation(code: "TKW", name: Name(en: "To Kwa Wan", zh: "土瓜灣"), x: 1379, y: 630, lines: ["TML"]),
        MTRMapStation(code: "TSH", name: Name(en: "Tai Shui Hang", zh: "大水坑"), x: 1583, y: 104, lines: ["TML"]),
        MTRMapStation(code: "TST", name: Name(en: "Tsim Sha Tsui", zh: "尖沙咀"), x: 1032, y: 734, lines: ["TWL"]),
        MTRMapStation(code: "TSW", name: Name(en: "Tsuen Wan", zh: "荃灣"), x: 318, y: 438, lines: ["TWL"]),
        MTRMapStation(code: "TSY", name: Name(en: "Tsing Yi", zh: "青衣"), x: 559, y: 508, lines: ["AEL", "TCL"]),
        MTRMapStation(code: "TUC", name: Name(en: "Tung Chung", zh: "東涌"), x: 350, y: 725, lines: ["TCL"]),
        MTRMapStation(code: "TUM", name: Name(en: "Tuen Mun", zh: "屯門"), x: 214, y: 314, lines: ["TML"]),
        MTRMapStation(code: "TWH", name: Name(en: "Tai Wo Hau", zh: "大窩口"), x: 416, y: 438, lines: ["TWL"]),
        MTRMapStation(code: "TWO", name: Name(en: "Tai Wo", zh: "太和"), x: 976, y: 104, lines: ["EAL"]),
        MTRMapStation(code: "TWW", name: Name(en: "Tsuen Wan West", zh: "荃灣西"), x: 318, y: 365, lines: ["TML"]),
        MTRMapStation(code: "UNI", name: Name(en: "University", zh: "大學"), x: 1165, y: 104, lines: ["EAL"]),
        MTRMapStation(code: "WAC", name: Name(en: "Wan Chai", zh: "灣仔"), x: 1066, y: 887, lines: ["ISL"]),
        MTRMapStation(code: "WCH", name: Name(en: "Wong Chuk Hang", zh: "黃竹坑"), x: 917, y: 1038, lines: ["SIL"]),
        MTRMapStation(code: "WHA", name: Name(en: "Whampoa", zh: "黃埔"), x: 1331, y: 694, lines: ["KTL"]),
        MTRMapStation(code: "WKS", name: Name(en: "Wu Kai Sha", zh: "烏溪沙"), x: 1858, y: 104, lines: ["TML"]),
        MTRMapStation(code: "WTS", name: Name(en: "Wong Tai Sin", zh: "黃大仙"), x: 1334, y: 438, lines: ["KTL"]),
        MTRMapStation(code: "YAT", name: Name(en: "Yau Tong", zh: "油塘"), x: 1652, y: 686, lines: ["KTL", "TKL"]),
        MTRMapStation(code: "YMT", name: Name(en: "Yau Ma Tei", zh: "油麻地"), x: 1036, y: 609, lines: ["KTL", "TWL"]),
        MTRMapStation(code: "YUL", name: Name(en: "Yuen Long", zh: "元朗"), x: 280, y: 217, lines: ["TML"]),
    ]
}

struct MTRLineBoard: Identifiable, Sendable {
    let line: String
    let up: [ETA]
    let down: [ETA]
    let updatedAt: Date?
    let isDelayed: Bool
    let message: String?
    var id: String { line }
}
