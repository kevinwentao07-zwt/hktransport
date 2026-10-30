import AppKit
import SwiftUI

enum PanelGeometryPhase: Equatable {
    case compact
    case peek
    case workspace
}

enum NotchLayout {
    static let panelWidth: CGFloat = 1120
    static let hoveredHeight: CGFloat = 74
    static let expandedGap: CGFloat = 12
    static let expandedPanelWidth: CGFloat = 1080
    static let expandedPanelHeight: CGFloat = 600
    static let shoulderRadius: CGFloat = 6
    static let compactWingSlotWidth: CGFloat = 50
    static let minimumMenuBarHeight: CGFloat = 32

    static var expandedHeight: CGFloat {
        hoveredHeight + expandedGap + expandedPanelHeight
    }

    static func menuBarHeight(screenFrame: CGRect, visibleFrame: CGRect) -> CGFloat {
        max(minimumMenuBarHeight, screenFrame.maxY - visibleFrame.maxY)
    }

    static func panelHeight(menuBarHeight: CGFloat, phase: PanelGeometryPhase) -> CGFloat {
        switch phase {
        case .compact: return menuBarHeight
        case .peek: return max(menuBarHeight, hoveredHeight)
        case .workspace: return expandedHeight
        }
    }

    static func windowFrame(screenFrame: CGRect, height: CGFloat) -> CGRect {
        CGRect(
            x: screenFrame.midX - panelWidth / 2,
            y: screenFrame.maxY - height,
            width: panelWidth,
            height: height
        )
    }

    static func workspaceVisibleSurfaceFrame(in panelFrame: CGRect) -> CGRect {
        CGRect(
            x: panelFrame.midX - expandedPanelWidth / 2,
            y: panelFrame.maxY - expandedHeight,
            width: expandedPanelWidth,
            height: expandedHeight
        )
    }

    static func compactSurfaceWidth(wingWidth: CGFloat, notchWidth: CGFloat) -> CGFloat {
        wingWidth * 2 + notchWidth + shoulderRadius * 2
    }

    static func resolvedNotchWidth(hasSafeArea: Bool, measuredWidth: CGFloat?) -> CGFloat {
        guard hasSafeArea else { return 168 }
        guard let measuredWidth, measuredWidth.isFinite, measuredWidth > 100 else {
            return 186
        }
        return measuredWidth
    }
}

enum NotchDesign {
    enum Radius {
        static let panel: CGFloat = 26
        static let row: CGFloat = 12
    }

    enum Motion {
        static let hover = Animation.timingCurve(0.22, 0.72, 0, 1, duration: 0.28)
        static let panelOpen = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.38)
        static let panelClose = Animation.timingCurve(0.4, 0, 1, 1, duration: 0.30)
    }
}

enum NotchScreen {
    @MainActor static var preferred: NSScreen? {
        NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main ?? NSScreen.screens.first
    }
}
