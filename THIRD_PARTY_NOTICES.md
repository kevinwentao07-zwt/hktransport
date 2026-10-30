# Third-party notices

This repository was organized from the user-provided `hktransport.zip`. The application sources and bundled map images are preserved as supplied; repository documentation and ignore rules were updated during import on 2026-10-30. Full upstream snapshots, dependency installations and build products are omitted.

## Notch Triage

- Upstream: https://github.com/0Hyacinth0/Notch-Triage
- Attribution: 0Hyacinth0 and the Notch Triage contributors.
- License: GNU General Public License v3.0; the license supplied with the upstream snapshot is retained in `licenses/Notch-Triage-LICENSE`.
- The supplied application's notch panel, hover/expand behavior and geometry are based on this project. Unrelated upstream features were removed in the supplied application.

## HK Bus ETA

- Upstream: https://github.com/hkbus/hk-independent-bus-eta
- Attribution: chunlaw and the HK Bus ETA contributors.
- License: GNU General Public License v3.0; the license supplied with the upstream snapshot is retained in `licenses/HK-Bus-ETA-LICENSE`.
- The supplied application's native Swift ETA fetchers reference the `hk-bus-eta` fetchers used by hkbus.app. The React/Tauri interface and installed Node dependencies are not included.
- Route database: https://data.hkbus.app/routeFareList.min.json
- Fallback database: https://hkbus.github.io/hk-bus-crawling/routeFareList.min.json
- Route data project: https://github.com/hkbus/hk-bus-crawling

## Transport feeds

The supplied code requests arrivals from KMB, Citybus, NLB, green minibus and MTR public endpoints, and traffic notices from the Hong Kong Transport Department. Data remains subject to its respective provider's terms. Application source licensing does not replace data-provider terms.

## Bundled maps

`hktransport/Resources/MTRSystemMap.png` and `hktransport/Resources/LightRailSystemMap.png` are retained unchanged from the supplied archive. The archive does not include separate asset license or provenance documentation for these images. The source-code GPL notice alone does not establish redistribution rights for these images; their original rights remain with their respective owners.
