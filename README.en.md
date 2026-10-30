# hktransport

[繁體中文](README.md) | English

A macOS notch app for Hong Kong public transport arrivals: KMB / LWB, Citybus, NLB, green minibus, Light Rail and MTR.

It combines the notch shell from [Notch Triage](https://github.com/0Hyacinth0/Notch-Triage) (the panel, hover and expand animations, notch geometry) with the ETA logic of [hk-independent-bus-eta](https://github.com/hkbus/hk-independent-bus-eta) (the `hk-bus-eta` fetchers and the hkbus.app route database), rewritten in native Swift. There is no web UI.

## Using it

The Bus page shows an embedded Apple Map and a list of nearby bus stops when the search field is empty. Click **Use my location** and allow the macOS location prompt. Stops are sorted by straight-line distance within a selectable 500 m / 1 km / 3 km radius (up to 30 stops). Select a map marker or list entry, then a route to preview its next two arrivals without saving it. Location accuracy and the last fix time are shown; **My location** requests a new fix and recenters the map. Route-number search remains available.

Location is requested only while the nearby-bus page is visible and stays in memory. Apple Maps connects to Apple's map services; ETA requests contain route/stop codes, not your coordinates. Denied permissions and unavailable location fixes have recovery controls on the page.

The nearby menu expands as **station → routes at this station → next two arrivals**. Same-name platforms within 100 m share a station entry while retaining their original operator and stop sequence for ETA requests. Distant stops with the same name stay separate. Distance is measured to the station's closest boarding platform.

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

## What was removed

From Notch Triage: AI usage, media and lyrics, system HUD, power, notifications, trash, file shelf, clipboard, desktop companion, updater, settings window, Liquid Glass (so it runs on macOS 14 instead of 26 only), and the vendored MediaRemote framework.

From hk-independent-bus-eta: the React/Tauri web UI, geographic maps, nearby search, fares, timetables and the Light Rail feeder buses. MTR and Light Rail have native clickable system maps based on the supplied reference images. Ferry routes and piers are browsable with links to official timetables; live ferry ETAs are not implemented. The traffic notice panel reads the Transport Department feed.

## License

GPL-3.0, the same license as both source projects.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for source credits and bundled asset provenance. Upstream project copies, node_modules, temporary files and build output are excluded from this repository.
