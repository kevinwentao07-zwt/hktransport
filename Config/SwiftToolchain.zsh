# Shared by the command-line launch and quit scripts.
# Some upgraded Command Line Tools installations retain two identical
# SwiftBridging module maps. Hide only the redundant legacy declaration in
# the compiler's virtual filesystem; never modify the installed toolchain.
hktransport_prepare_swift() {
    local project_dir="$1"
    local compiler_path="$(xcrun --find swiftc)"
    local include_dir="${compiler_path:h:h}/include/swift"
    typeset -ga hktransport_swift_flags=()

    if [[ -f "$include_dir/module.modulemap" && -f "$include_dir/bridging.modulemap" ]]; then
        local overlay_path
        overlay_path="$(/usr/bin/python3 - "$include_dir" "$project_dir/build/.toolchain" <<'PY'
import json
from pathlib import Path
import re
import sys

include_dir, output_dir = map(Path, sys.argv[1:])
legacy = include_dir / "module.modulemap"
current = include_dir / "bridging.modulemap"

def declarations(path):
    return re.sub(r"\s+", "", re.sub(r"//[^\n]*", "", path.read_text()))

expected = 'moduleSwiftBridging{header"bridging"export*}'
if declarations(legacy) == declarations(current) == expected:
    output_dir.mkdir(parents=True, exist_ok=True)
    empty = output_dir / "empty.modulemap"
    overlay = output_dir / "swift-overlay.json"
    contents = {
        empty: "// Redundant legacy SwiftBridging declaration hidden for this build.\n",
        overlay: json.dumps({"version": 0, "roots": [{
            "type": "file", "name": str(legacy), "external-contents": str(empty)
        }]}) + "\n",
    }
    for path, content in contents.items():
        if not path.exists() or path.read_text() != content:
            path.write_text(content)
    print(overlay)
PY
)" || return
        if [[ -n "$overlay_path" ]]; then
            hktransport_swift_flags=(-vfsoverlay "$overlay_path")
        fi
    fi
}
