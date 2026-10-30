# hktransport

讓 MacBook 劉海顯示香港公共交通到站預報的原生 macOS 應用，使用 Swift / SwiftUI / AppKit 開發。

繁體中文 | [English](README.en.md)

## 功能

- **巴士與小巴**：九巴／龍運、城巴、嶼巴及綠色專線小巴的到站預報。
- **附近巴士站**：巴士頁內嵌 Apple 地圖，取得位置後按直線距離排列最近站點，可切換 500 米／1 公里／3 公里範圍，點選站點及路線查看最近兩班。
- **港鐵與輕鐵**：點選路綫圖車站，查看月台、行車方向及到站時間；支援縮放、平移與車站搜尋。
- **收藏站點**：收藏常用路綫與方向，將首個收藏顯示在劉海兩側，懸停查看接下來的班次。
- **渡輪**：瀏覽新渡輪、港九小輪及富裕小輪的航線與碼頭，連至官方時間表及票價；目前沒有即時到站預報。
- **交通通告**：讀取運輸署交通消息，支援搜尋及每分鐘更新。
- **個人設定**：中文／英文介面、到站預報更新間隔（1、15、30 或 60 秒），以及登入時啟動。

## 快速開始

需要 **macOS 14 或以上**及 Apple Command Line Tools。建議使用配備劉海的 MacBook。

```bash
git clone https://github.com/kevinwentao07-zwt/hktransport.git
cd hktransport
./"Start hktransport.command"
```

也可以在 Finder 雙擊 **Start hktransport.command**。首次啟動會編譯應用，之後會在原始碼有變更時重新編譯。若尚未安裝命令列工具，先執行 `xcode-select --install`。

停止應用：在設定或劉海右鍵選單選擇 **Quit**，或執行：

```bash
./"Close hktransport.command"
```

若曾更新過 Command Line Tools，系統可能殘留重複的 `SwiftBridging` 模組宣告，令編譯長時間沒有結果並最終報錯。啟動及結束腳本會自動檢查這個特定問題，使用專案內的檔案映射略過重複宣告，不修改系統檔案，也不需要管理員權限。相容檔案保存在忽略提交的 `build/.toolchain/`；首次編譯仍可能需要數分鐘。

啟動腳本將編譯好的應用儲存在 `~/Library/Caches/hktransport/`，每個專案目錄使用獨立快取，避免 iCloud／File Provider 對原始碼資料夾附加的中繼資料影響應用簽署。

### 操作方式

1. 懸停劉海查看預覽，點擊打開完整面板。
2. 在側邊欄選擇交通類型，輸入路綫號碼、車站名稱或代碼搜尋，例如 `1A`、`960`、`TML`、`ADM`、`505`。
3. 在巴士／小巴路綫的站點列表點選站名，即可在下方展開最近兩班到站預報，無需收藏。再次點選可收起；切換站點會收起前一站。預報依設定的間隔自動更新，也可手動重新查詢。
4. 點選站點或方向旁的星號加入收藏；右鍵收藏可置頂或移除。
5. 港鐵與輕鐵頁面可直接點選地圖上的車站，使用 **+ / −** 縮放及 **Fit** 還原。
6. `Esc` 逐層返回（先收起到站預覽）；`⌘W` 關閉面板；`⌘Q` 結束應用；`⌘,` 開啟設定（面板啟用時）。

到站預報預設每 30 秒更新。路綫資料首次使用時下載，快取於 `~/Library/Application Support/hktransport/`，每週更新。首次載入及即時預報需要網絡連線。

### 附近巴士與定位

在「巴士」頁保持搜尋欄空白，即可開啟附近站點地圖。首次點選「使用我的位置」，並在 macOS 提示中允許定位。右側站點由近至遠排列，地圖標記與站點列表可互相選取。點開站點後，再點選途經路線，就能直接查看最近兩班，無需收藏；輸入路線號碼仍可使用原有搜尋。

「我的位置」會重新取得位置並將地圖移回附近。列表顯示定位精度及時間；距離是直線距離，不代表步行距離。定位只在附近巴士頁使用，座標僅保存在記憶體；離開頁面即停止定位。Apple 地圖需要連接 Apple 地圖服務，巴士預報接口只接收路線與站點代碼，不包含你的座標。若拒絕授權，可從頁面的「定位設定」重新開啟；拒絕定位不影響路線搜尋。

## 開發與測試

命令列啟動腳本可使用 Command Line Tools 編譯；開啟 Xcode 工程及執行 XCTest 需要完整 **Xcode 16 或以上**。

```bash
open hktransport.xcodeproj
```

選擇 `hktransport` Scheme 執行；測試可按 `⌘U`，或執行：

```bash
xcodebuild test \
  -project hktransport.xcodeproj \
  -scheme hktransport \
  -destination 'platform=macOS'
```

應用採用本機 ad-hoc 簽署。版本號統一維護於 [`Config/Version.xcconfig`](Config/Version.xcconfig)。

## 專案結構

```text
hktransport/
├── Config/                         # 版本設定
├── hktransport/                    # 原生應用原始碼
│   └── Resources/                  # 港鐵及輕鐵路綫圖
├── hktransport.xcodeproj/           # Xcode 工程
├── hktransportTests/               # 現有 XCTest 測試
├── Start hktransport.command       # 編譯並啟動
├── Close hktransport.command       # 正常結束應用
├── README.en.md                    # 英文說明
├── THIRD_PARTY_NOTICES.md           # 原專案與資源來源
└── LICENSE                         # GPL-3.0
```

介面狀態及劉海幾何位於 `PanelState.swift`、`NotchLayout.swift`；主要視窗由 `AppDelegate.swift` 管理。`AppModel.swift` 管理收藏與更新，`TransportDB.swift` 下載路綫資料，`ETAService.swift` 處理各營辦商預報。

倉庫只保留本應用所需的原始碼、資源、測試與文件；參考專案完整副本、`node_modules`、編譯產物、臨時檔案及 macOS 中繼資料不隨倉庫提交。原始壓縮包不受影響。

## 來源與授權

劉海視窗與動畫基於 [Notch Triage](https://github.com/0Hyacinth0/Notch-Triage)，交通資料處理參考 [HK Bus ETA](https://github.com/hkbus/hk-independent-bus-eta) 及其使用的 `hk-bus-eta`，改寫為原生 Swift。

本專案沿用 **GPL-3.0**，保留原有 [`LICENSE`](LICENSE)。原專案、資料來源及隨附地圖的來源紀錄見 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
