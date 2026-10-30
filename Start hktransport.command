#!/bin/zsh
set -euo pipefail

project_root="${0:A:h}"
app_bundle="$project_root/build/hktransport.app"
executable="$app_bundle/Contents/MacOS/hktransport"
needs_build=false

if [[ ! -x "$executable" ]]; then
    needs_build=true
else
    for source_file in "$project_root"/hktransport/*.swift "$project_root"/hktransport/Resources/* "$project_root/Config/Version.xcconfig" "$0"; do
        if [[ "$source_file" -nt "$executable" ]]; then
            needs_build=true
            break
        fi
    done
fi

if [[ "$needs_build" == true ]]; then
    print 'Building hktransport…'
    mkdir -p "$project_root/build"
    staging_dir="$(mktemp -d "$project_root/build/.launch.XXXXXX")"
    trap 'rm -rf "$staging_dir"' EXIT
    mkdir -p "$staging_dir/hktransport.app/Contents/MacOS"

    xcrun swiftc -swift-version 5 -D DEBUG \
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
</dict></plist>
PLIST

    ditto "$project_root/hktransport/Resources" "$staging_dir/hktransport.app/Contents/Resources"

    "$project_root/Close hktransport.command"
    ditto "$staging_dir/hktransport.app" "$app_bundle"
    codesign --force --options runtime --sign - "$app_bundle"
fi

open "$app_bundle"
print 'hktransport is ready. Click the notch to open it.'
