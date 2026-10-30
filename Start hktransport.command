#!/bin/zsh
set -euo pipefail

project_root="${0:A:h}"
project_id="$(print -r -- "$project_root" | cksum | awk '{print $1}')"
# Keep signed bundles outside iCloud/File Provider-managed source folders.
build_root="$HOME/Library/Caches/hktransport/$project_id"
app_bundle="$build_root/hktransport.app"
executable="$app_bundle/Contents/MacOS/hktransport"
needs_build=false

clear_bundle_metadata() {
    if [[ -d "$app_bundle" ]]; then
        # Finder/File Provider may add these attributes when discovering an app.
        xattr -dr com.apple.FinderInfo "$app_bundle" 2>/dev/null || true
        xattr -dr com.apple.ResourceFork "$app_bundle" 2>/dev/null || true
    fi
}

clear_bundle_metadata
if [[ ! -x "$executable" ]] || ! codesign --verify --strict "$app_bundle" >/dev/null 2>&1; then
    needs_build=true
else
    for source_file in "$project_root"/hktransport/*.swift "$project_root"/hktransport/Resources/* "$project_root"/Config/* "$0"; do
        if [[ "$source_file" -nt "$executable" ]]; then
            needs_build=true
            break
        fi
    done
fi

if [[ "$needs_build" == true ]]; then
    print 'Building hktransport…'
    mkdir -p "$build_root"
    staging_dir="$(mktemp -d "$build_root/.launch.XXXXXX")"
    trap 'rm -rf "$staging_dir"' EXIT
    mkdir -p "$staging_dir/hktransport.app/Contents/MacOS"

    source "$project_root/Config/SwiftToolchain.zsh"
    hktransport_prepare_swift "$project_root"
    if (( ${#hktransport_swift_flags} )); then
        print 'Applying project-local compatibility fix for duplicate SwiftBridging modules.'
    fi
    print 'Compiling Swift sources (the first build can take a few minutes)…'
    xcrun swiftc "${hktransport_swift_flags[@]}" \
        -swift-version 5 -D DEBUG -whole-module-optimization -Onone \
        -target "$(uname -m)-apple-macosx14.0" -parse-as-library \
        "$project_root"/hktransport/*.swift \
        -o "$staging_dir/hktransport.app/Contents/MacOS/hktransport"

    app_version="$(awk '/^MARKETING_VERSION =/ {print $3}' "$project_root/Config/Version.xcconfig")"
    build_version="$(awk '/^CURRENT_PROJECT_VERSION =/ {print $3}' "$project_root/Config/Version.xcconfig")"
    cat > "$staging_dir/hktransport.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>hktransport</string>
<key>CFBundleIdentifier</key><string>local.hktransport.debug</string>
<key>CFBundleName</key><string>hktransport</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$app_version</string>
<key>CFBundleVersion</key><string>$build_version</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSLocationUsageDescription</key><string>在 Apple 地圖顯示你的位置，並按距離排列附近巴士站。位置只在使用附近巴士功能時取得。</string>
<key>NSLocationWhenInUseUsageDescription</key><string>在 Apple 地圖顯示你的位置，並按距離排列附近巴士站。</string>
</dict></plist>
PLIST

    ditto --norsrc --noextattr "$project_root/hktransport/Resources" "$staging_dir/hktransport.app/Contents/Resources"

    "$project_root/Close hktransport.command"
    ditto --norsrc --noextattr "$staging_dir/hktransport.app" "$app_bundle"
    clear_bundle_metadata
    codesign --force --options runtime \
        --entitlements "$project_root/Config/hktransport.entitlements" \
        --sign - "$app_bundle"
    print 'Build complete. Opening hktransport…'
fi

open "$app_bundle"
clear_bundle_metadata
print 'hktransport is ready. Click the notch to open it.'
