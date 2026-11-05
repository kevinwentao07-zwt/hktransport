# hktransport

[繁體中文](README.md) | English

A macOS notch app for Hong Kong public transport arrivals: KMB / LWB, Citybus, NLB, green minibus, Light Rail and MTR.

It combines the notch shell from [Notch Triage](https://github.com/0Hyacinth0/Notch-Triage) (the panel, hover and expand animations, notch geometry) with the ETA logic of [hk-independent-bus-eta](https://github.com/hkbus/hk-independent-bus-eta) (the `hk-bus-eta` fetchers and the hkbus.app route database), rewritten in native Swift. There is no web UI.

## Download

Get the latest `.dmg` from [Releases](https://github.com/kevinwentao07-zwt/hktransport/releases/latest), open it and drag hktransport into Applications. Requires macOS 14 or later, on Apple silicon or Intel.

The app isn't notarized by Apple, so the first launch says macOS can't verify the developer: press Done, go to **System Settings → Privacy & Security** and press **Open Anyway** near the bottom. You only do this once. AI features need your own DeepSeek API key, added in Settings.

To build a DMG yourself, run `Package hktransport.command`; it writes to `dist/`.

## Using it

**Stop search** takes a stop or place and lists all bus, minibus, MTR and Light Rail stops around it, filtered by type and radius. Open a stop for routes and arrivals, or to plan a trip there.

Every search box keeps its last 20 searches on this Mac. Only the latest 4 show, with the rest folded under **more**: press one to search again, right-click to remove it, or press **Clear**.

The Bus page shows an embedded Apple Map and a list of nearby bus stops when the search field is empty. Click **Use my location** and allow the macOS location prompt. Stops are sorted by straight-line distance within a selectable 500 m / 1 km / 3 km radius (up to 30 stops). Select a map marker or list entry, then a route to preview its next two arrivals without saving it. Location accuracy and the last fix time are shown; **My location** requests a new fix and recenters the map. Route-number search remains available.

Location is requested once per launch and shared by the nearby-bus and Plan trip pages; the location buttons refresh it, and only navigation keeps it on. It stays in memory. Apple Maps connects to Apple's map services; ETA requests contain route/stop codes, not your coordinates. Denied permissions and unavailable location fixes have recovery controls on the page.

The nearby menu expands as **station → routes at this station → next two arrivals**. Same-name platforms within 100 m share a station entry while retaining their original operator and stop sequence for ETA requests. Distant stops with the same name stay separate. Distance is measured to the station's closest boarding platform.

The map supports native trackpad pinch-to-zoom and two-finger panning, plus on-map zoom buttons. **My location** recenters the map around your location.

Double-click **Start hktransport.command** to build and open the app. Later starts reuse the build unless the source has changed. Double-click **Close hktransport.command** to quit. These shortcuts use the installed Xcode Command Line Tools; full Xcode isn't required.

On some upgraded Command Line Tools installations, a redundant legacy `SwiftBridging` module map can cause a long compile followed by module-redefinition errors. Both shortcuts automatically detect identical duplicate declarations and apply a project-local compiler filesystem overlay. System files are never modified and administrator access is not required. Compatibility files live in the ignored `build/.toolchain/` directory. The first build can still take a few minutes.

Compiled apps are cached under `~/Library/Caches/hktransport/`, separately for each project directory, to keep signed bundles outside iCloud/File Provider-managed source folders.

Click **×** or press `⌘W` while the notch panel is active to close the panel. To quit the app, click **Quit** in Settings, press `⌘Q` while the panel is active, or use the notch's right-click menu.

| Where | What you see |
| --- | --- |
| Notch (idle) | Your first saved route on the left wing, minutes to the next arrival on the right |
| Hover | Route, destination, stop, and the next three arrivals |
| Click | Your saved stops with live ETAs, plus route search |

1. Click the notch and type a route number (`1A`, `960`, `TML`, `505`). Press Return to open the first match.
2. Click a stop name to expand the next two arrivals directly below it, without saving. Click again to collapse, or choose another stop. The preview refreshes at your configured interval and has a manual refresh button. Use the separate star button to save or unsave the stop.
3. Esc steps back: collapse the arrival preview → search results → clear search → close the panel.
4. Right-click a saved stop to move it to the top (that one shows on the notch) or remove it.
5. Right-click the notch to switch between 中文 and English, or to quit.
6. Choose **Settings** in the sidebar, press `⌘,` while the panel is active, or right-click the notch and choose **Settings…**, to change language, arrival refresh frequency (1, 15, 30 or 60 seconds), or launch at login. Changes save automatically; press Esc or click Back to return to routes.
7. Use the sidebar to browse saved stops, buses, green minibuses, Light Rail, MTR, ferries, or traffic notices. Route search stays available and is filtered to the selected transport type.
8. In **MTR**, click a station marker on the supplied system map to see live arrivals for every line there, including platforms and branch destinations. Use **+ / −** to zoom and scroll to pan; **Fit** restores the full map. Search also accepts Chinese/English station names, station codes (`ADM`) and line codes (`TML`). Click a star beside a direction to save it to the notch.

ETAs refresh every 30 seconds by default. The route database (about 8 MB, from `data.hkbus.app`, with the GitHub mirror as fallback) is cached in `~/Library/Application Support/hktransport/` and refreshed weekly.

### Trip planning (AI)

**Plan trip** in the sidebar works like a navigation app: type a start and destination at the top. With no start, your current location is used, and ⇄ swaps the two. The AI box at the bottom takes text or voice, e.g. `airport with no transfers`, and follow-ups such as `walk less`: the AI changes only what you mention and fills in the search bar.

- **Both are analysed by the AI.** With a DeepSeek API key, the search bar and the AI box both go through the AI, which reads places and preferences and explains the recommendation.
- **AI finds places.** Say `I want rice noodles` in the AI box and it first asks where to look: press Nearby or a district, or type or say a narrower area. The AI names the shops it recommends and says why, then each one is checked on Apple Maps: any it can't find, or whose name doesn't match, is not shown. Pressing one plans the route. Nearby means your own district, e.g. Yau Tsim Mong, showing only shops inside it and the closest branch of a chain. The AI can't browse the web, so its picks come from what it knows and can be out of date, so check before you go; if none can be confirmed, the map is searched by shop type instead. DeepSeek receives your request and the district name, never your coordinates.
- **Voice input.** Uses macOS speech recognition in Cantonese, Mandarin or English, chosen beside the microphone, and sends about two seconds after you stop talking. With the language's on-device model installed, recognition stays on the Mac; otherwise audio goes to Apple. Recordings are not kept. The first use asks for Microphone and Speech Recognition access.

- **Route map.** An Apple Map stays on the right of the page. Open any option and it zooms to the whole trip, drawing each ride's stops with their names (crowded names appear as you zoom in), the route number where you board and dotted walks.
- **Navigation.** Open an option and press **Start navigation**: the map follows you and shows the next stop, the stops left and where to get off. It keeps going after the notch closes, and location turns off when you arrive or press End. Mac positions mostly come from Wi-Fi, so they are approximate and may not update underground or without Wi-Fi. The data only has stop coordinates, so lines join the stops rather than following the exact road.
- **Routes are computed on the Mac.** `RoutePlanner.swift` runs RAPTOR over the bus, green minibus, Light Rail and MTR network for up to three vehicles, including walks between stops. Ride times spread each route's published journey time (`jt`) by distance; waits come from timetable bands (`freq`), and routes that are not running are skipped.
- **Live correction.** Every leg of each candidate is then re-timed with the stop's live ETAs, taking the first catchable departure, and the options are re-ranked. Legs based on live data are marked **Live**.
- **MTR.** Lines show their full names and colours, with live arrivals and platforms from the MTR open data API. The API only lists about the next four trains, so a later leg continues that live headway and is marked **Projected from live**. Short workings and trains on the other branch that never reach your stop are ignored.
- **The AI only interprets and explains.** With a DeepSeek API key, the AI turns phrasing like "理大" or "less walking" into a destination and a preference, and writes a one-line recommendation. Routes, stops and times always come from the planner and operator data. Without a key, or if the call fails, a built-in rule parser is used.
- **Privacy.** Only your typed text, stop names and route numbers are sent to DeepSeek, never your coordinates. Places are looked up with Apple Maps. The key is stored in the macOS keychain; because the app is ad-hoc signed, macOS may ask once after a rebuild whether hktransport may read it — choose Always Allow.

Setup: Settings → AI trip assistant (DeepSeek) → paste the key → Save. The model defaults to `deepseek-flash` and can be changed on the same page.

All planner constants (walking speed, transfer time, walking radii, …) live in `PlannerSettings` in `RoutePlanner.swift`.

## Build

Requirements: macOS 14+, Xcode 16+.

```bash
open hktransport.xcodeproj
```

Run the `hktransport` scheme. The app is ad-hoc signed (`CODE_SIGN_IDENTITY = "-"`); set your own team under Signing & Capabilities if you want to distribute it. Tests: `⌘U`, or

```bash
xcodebuild test -project hktransport.xcodeproj -scheme hktransport
```

## Layout

| File | Role |
| --- | --- |
| `hktransport/AppDelegate.swift` | App entry, notch `NSPanel`, frame animation, click-outside dismissal |
| `hktransport/PanelState.swift` | compact / peek / workspace state machine |
| `hktransport/NotchLayout.swift` | Notch geometry, motion constants |
| `hktransport/NotchRootView.swift` | Notch surface, wings, hover preview |
| `hktransport/TransportPanel.swift` | Expanded panel: sidebar, saved stops, search, stop picker |
| `hktransport/MTRPanel.swift` | Clickable map, station search and live arrivals by line/direction |
| `hktransport/MTRNetwork.swift` | Map station targets, bilingual search and line metadata |
| `hktransport/AppModel.swift` | Saved stops, refresh loop, panel actions |
| `hktransport/TransportDB.swift` | Route database model, download and cache |
| `hktransport/ETAService.swift` | Per-operator ETA fetchers and parsers |
| `hktransport/RoutePlanner.swift` | Transit network, RAPTOR search, timetable waits, live re-timing |
| `hktransport/RoutePlannerModel.swift` | Plan flow: request parsing, place lookup, search, live ETAs |
| `hktransport/TripAssistant.swift` | DeepSeek client and the offline request parser |
| `hktransport/JourneyMapPath.swift` | Turns a journey into lines and a map region |
| `hktransport/RoutePlanPanel.swift` | Plan trip page |
| `hktransport/SpeechInputModel.swift` | Voice input for the AI box |
| `hktransport/NavigationTracker.swift` | Follows a journey and works out the next stop |
| `hktransport/PlaceDiscovery.swift` | AI place finding: areas, Apple Maps search, recommendations |
| `hktransport/StopSearchModel.swift` | Finds a stop or place and lists the stops around it |
| `hktransport/SearchHistory.swift` | Per-box search history |
| `hktransport/KeychainStore.swift` | Keychain storage for the API key |

## What was removed

From Notch Triage: AI usage, media and lyrics, system HUD, power, notifications, trash, file shelf, clipboard, desktop companion, updater, settings window, Liquid Glass (so it runs on macOS 14 instead of 26 only), and the vendored MediaRemote framework.

From hk-independent-bus-eta: the React/Tauri web UI, geographic maps, nearby search, fares, timetables and the Light Rail feeder buses. MTR and Light Rail have native clickable system maps based on the supplied reference images. Ferry routes and piers are browsable with links to official timetables; live ferry ETAs are not implemented. The traffic notice panel reads the Transport Department feed.

## License

GPL-3.0, the same license as both source projects.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for source credits and bundled asset provenance. Upstream project copies, node_modules, temporary files and build output are excluded from this repository.
