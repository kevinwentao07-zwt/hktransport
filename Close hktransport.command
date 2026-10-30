#!/bin/zsh
set -euo pipefail

# Ask the app to quit normally so its shutdown handler can finish.
xcrun swift - <<'SWIFT'
import AppKit

let bundleIDs = ["local.hktransport.debug", "local.hktransport"]
let runningApps = NSWorkspace.shared.runningApplications.filter {
    bundleIDs.contains($0.bundleIdentifier ?? "")
}
if runningApps.isEmpty {
    print("hktransport is already closed.")
} else {
    for app in runningApps {
        guard app.terminate() else {
            fputs("Couldn't close hktransport. Use Quit in the notch menu.\n", stderr)
            exit(1)
        }
    }
    let deadline = Date().addingTimeInterval(5)
    while runningApps.contains(where: { !$0.isTerminated }), Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    guard runningApps.allSatisfy({ $0.isTerminated }) else {
        fputs("hktransport hasn't finished closing. Try Quit in the notch menu.\n", stderr)
        exit(1)
    }
    print("hktransport closed.")
}
SWIFT
