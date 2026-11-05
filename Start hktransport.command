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

    source "$project_root/Config/AppBundle.zsh"
    hktransport_write_info_plist "$project_root" local.hktransport.debug "$staging_dir/hktransport.app/Contents/Info.plist"

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
print 'hktransport is ready.'
