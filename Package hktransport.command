#!/bin/zsh
# Builds dist/hktransport-<version>.dmg: a universal app to drag into Applications.
set -euo pipefail

project_root="${0:A:h}"
source "$project_root/Config/SwiftToolchain.zsh"
source "$project_root/Config/AppBundle.zsh"
hktransport_prepare_swift "$project_root"

version="$(awk '/^MARKETING_VERSION =/ {print $3}' "$project_root/Config/Version.xcconfig")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
app="$work/dmg/hktransport.app"
mkdir -p "$app/Contents/MacOS"

for arch in arm64 x86_64; do
    print "Compiling for $arch…"
    xcrun swiftc "${hktransport_swift_flags[@]}" \
        -swift-version 5 -O -whole-module-optimization \
        -target "$arch-apple-macosx14.0" -parse-as-library \
        "$project_root"/hktransport/*.swift -o "$work/hktransport-$arch"
done
lipo -create "$work/hktransport-arm64" "$work/hktransport-x86_64" -output "$app/Contents/MacOS/hktransport"

hktransport_write_info_plist "$project_root" local.hktransport "$app/Contents/Info.plist"
ditto --norsrc --noextattr "$project_root/hktransport/Resources" "$app/Contents/Resources"
codesign --force --options runtime --entitlements "$project_root/Config/hktransport.entitlements" --sign - "$app"

cp "$project_root/Config/Install.txt" "$work/dmg/安裝說明 Install.txt"
cp "$project_root/LICENSE" "$work/dmg/LICENSE.txt"
ln -s /Applications "$work/dmg/Applications"
mkdir -p "$project_root/dist"
output="$project_root/dist/hktransport-$version.dmg"
rm -f "$output"
hdiutil create -quiet -volname "hktransport $version" -srcfolder "$work/dmg" -format UDZO -ov "$output"
print "Created $output"
