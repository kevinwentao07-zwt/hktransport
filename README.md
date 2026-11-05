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
- **站點搜尋**：輸入站名或地點，列出該處附近所有巴士站、小巴站、港鐵及輕鐵站，可按類型及範圍篩選；點開站點查看路線及到站時間，或直接規劃路線。
- **搜尋記錄**：每個搜尋框各自保留最近 20 項記錄，只儲存在本機。較多時只顯示最近 4 項，其餘收在「更多」；點選可重新搜尋，右鍵刪除單項，或按「清除」清空。
- **個人設定**：中文／英文介面、到站預報更新間隔（1、15、30 或 60 秒），以及登入時啟動。

## 下載安裝

到 [Releases](https://github.com/kevinwentao07-zwt/hktransport/releases/latest) 下載最新的 `.dmg`，打開後把 hktransport 拖到 Applications。需要 macOS 14 或以上，支援 Apple 晶片及 Intel Mac。

此 app 沒有經過 Apple 公證，首次打開時 macOS 會提示無法驗證開發者：按「完成」，到 **系統設定 → 私隱與安全性**，在頁面底部按 **仍要打開**，只需做一次。AI 功能需要在設定加入你自己的 DeepSeek API key。

## 快速開始

從原始碼編譯：

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

「我的位置」會重新取得位置並將地圖移回附近。列表顯示定位精度及時間；距離是直線距離，不代表步行距離。每次啟動只取得一次位置，附近巴士及路線規劃頁共用；按定位按鈕才會更新，只有導航時才會持續定位。座標僅保存在記憶體，離開頁面即停止定位。Apple 地圖需要連接 Apple 地圖服務，巴士預報接口只接收路線與站點代碼，不包含你的座標。若拒絕授權，可從頁面的「定位設定」重新開啟；拒絕定位不影響路線搜尋。

附近列表以「站點 → 此站不同路線 → 最近兩班」展開。同名、相距 100 米以內的站牌會合併為一個站點入口，各路線仍使用各自站牌的預報與站序；相距較遠的同名站不會合併。距離按該站點最近的上車站牌計算。

地圖支援觸控板雙指開合縮放、雙指滑動平移，也可使用地圖內的放大／縮小按鈕。「我的位置」可隨時返回目前位置附近。

### 路線規劃（AI）

在側邊欄選擇「路線規劃」。頁面上方和導航軟件一樣輸入起點及目的地；起點留空時會由目前位置出發，可用 ⇄ 對調。頁面下方是 AI 對話框，可以打字或按麥克風說話，例如「去機場不想轉車」，也可以接著說「改為少行路」，AI 只修改提及的部分，並把結果填回上方。

- **兩個入口都由 AI 分析**：設定 DeepSeek API key 後，上方搜尋及下方對話都會交由 AI 理解地名與偏好，並解釋推薦方案。
- **AI 幫你找地點**：在對話框說「我想吃螺螄粉」，AI 會先問在哪裡找，可按「附近」或地區按鈕，也可以輸入或說出更精確的範圍（例如「朗豪坊附近，要平啲」）。AI 會直接點名推薦的店舖並說明原因，再逐一在 Apple 地圖核實，找不到或名稱不符的不會顯示；點選地點即可規劃路線。「附近」指你所在的區（例如油尖旺區），只顯示區內的店，連鎖店取最近分店。AI 無法上網，推薦來自它已知的資料，可能過時，出發前請確認仍在營業；如果一間都核實不到，會改用地圖按店舖類型搜尋。傳送給 DeepSeek 的是你的要求及區名，不包括座標。
- **語音輸入**：使用 macOS 語音辨識，可在麥克風旁選擇粵語、普通話或 English，說完約兩秒後自動送出。已安裝該語言的本機模型時只在本機辨識，否則聲音會傳送至 Apple 辨識；錄音不會保存。首次使用需要允許麥克風及語音辨識。

- **路線地圖**：頁面右側一直顯示 Apple 地圖。點開任何一個方案，地圖會自動縮放到全程，並畫出每一程車經過的站及站名（空間不足時會自動隱藏，放大後再顯示）、上車點的路線號碼及虛線步行段。
- **導航追蹤**：點開方案後按「開始導航」，地圖會跟隨你的位置，並提示下一站、還有幾站及在哪裡下車。收起劉海後仍會繼續；到達目的地或按「結束」後停止定位。Mac 的位置主要來自 Wi-Fi，精度有限，在地底或沒有 Wi-Fi 時可能不會更新。資料只有站點座標，所以線段按站點連線，並非實際行車路徑。
- **路線在本機計算**：`RoutePlanner.swift` 以 RAPTOR 演算法，在巴士、小巴、輕鐵及港鐵網絡上搜尋最多三程車的方案，包括轉車之間的步行。行車時間按路線資料庫的全程時間（`jt`）依距離分配；候車時間按班次資料（`freq`）估算，未開出或已收車的路線會被略過。
- **實時修正**：找到候選方案後，每程車都會查詢上車站的實時到站時間，以第一班趕得及的班次取代估算，再重新排序。採用實時資料的方案會標示「實時」。
- **港鐵**：顯示綫路全名及綫路顏色，實時資料來自港鐵開放數據接口，並顯示月台。接口只提供接下來約四班車，所以較後的一程會按同一批實時資料的班距往後推算，標示為「實時推算」。不會到達下車站的短程車及另一支綫的列車不計算在內。
- **AI 只負責理解及解釋**：設定 DeepSeek API key 後，AI 會把口語輸入（例如「理大」、「少行路」）轉換為目的地及偏好，並以一兩句話解釋推薦方案。路線、站名及時間全部來自本機計算及營辦商數據，AI 不會自行編造路線。未設定 key 或 AI 出錯時，會自動改用內置的規則解析。
- **私隱**：傳送給 DeepSeek 的只有你輸入的文字、車站名稱及路線號碼，**不會傳送位置座標**。地點搜尋使用 Apple 地圖。API key 儲存於 macOS 鑰匙圈；由於應用採用 ad-hoc 簽署，重新編譯後 macOS 可能詢問一次是否允許讀取，選擇「永遠允許」即可。

設定方法：設定 → AI 路線助手（DeepSeek）→ 貼上 API key → 儲存。模型預設為 `deepseek-flash`，如 DeepSeek 更改型號名稱，可在同一頁修改。

所有規劃參數（步行速度、轉車時間、步行範圍等）集中在 `RoutePlanner.swift` 的 `PlannerSettings`，方便調校及在報告中說明。

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

執行 `Package hktransport.command` 可在 `dist/` 製作包含 Apple 晶片及 Intel 版本的安裝 DMG。應用採用本機 ad-hoc 簽署。版本號統一維護於 [`Config/Version.xcconfig`](Config/Version.xcconfig)。

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

介面狀態及劉海幾何位於 `PanelState.swift`、`NotchLayout.swift`；主要視窗由 `AppDelegate.swift` 管理。`AppModel.swift` 管理收藏與更新，`TransportDB.swift` 下載路綫資料，`ETAService.swift` 處理各營辦商預報。路線規劃由 `RoutePlanner.swift`（演算法）、`RoutePlannerModel.swift`（流程、地點搜尋、實時修正）、`TripAssistant.swift`（DeepSeek 及離線解析）、`JourneyMapPath.swift`（地圖路線）、`SpeechInputModel.swift`（語音輸入）、`NavigationTracker.swift`（導航追蹤）、`PlaceDiscovery.swift`（AI 找地點）、`RoutePlanPanel.swift`（介面）組成。

倉庫只保留本應用所需的原始碼、資源、測試與文件；參考專案完整副本、`node_modules`、編譯產物、臨時檔案及 macOS 中繼資料不隨倉庫提交。原始壓縮包不受影響。

## 來源與授權

劉海視窗與動畫基於 [Notch Triage](https://github.com/0Hyacinth0/Notch-Triage)，交通資料處理參考 [HK Bus ETA](https://github.com/hkbus/hk-independent-bus-eta) 及其使用的 `hk-bus-eta`，改寫為原生 Swift。

本專案沿用 **GPL-3.0**，保留原有 [`LICENSE`](LICENSE)。原專案、資料來源及隨附地圖的來源紀錄見 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
