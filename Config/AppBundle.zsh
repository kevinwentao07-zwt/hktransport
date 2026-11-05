# Shared by the launch script and the release package, so both ask for the same permissions.
hktransport_write_info_plist() {
    local project_dir="$1" bundle_id="$2" output="$3"
    local app_version="$(awk '/^MARKETING_VERSION =/ {print $3}' "$project_dir/Config/Version.xcconfig")"
    local build_version="$(awk '/^CURRENT_PROJECT_VERSION =/ {print $3}' "$project_dir/Config/Version.xcconfig")"
    cat > "$output" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>hktransport</string>
<key>CFBundleIdentifier</key><string>$bundle_id</string>
<key>CFBundleName</key><string>hktransport</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$app_version</string>
<key>CFBundleVersion</key><string>$build_version</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSLocationUsageDescription</key><string>在 Apple 地圖顯示你的位置、排列附近巴士站，並作為路線規劃的起點。</string>
<key>NSLocationWhenInUseUsageDescription</key><string>在 Apple 地圖顯示你的位置、排列附近巴士站，並作為路線規劃的起點。</string>
<key>NSMicrophoneUsageDescription</key><string>在路線規劃頁用語音告訴 AI 你要去哪裡。錄音不會保存。</string>
<key>NSSpeechRecognitionUsageDescription</key><string>把你的語音轉換為文字，讓 AI 規劃路線。</string>
</dict></plist>
PLIST
}
