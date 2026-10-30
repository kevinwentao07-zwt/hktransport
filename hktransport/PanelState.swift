import Foundation

/// The single source of truth for the notch panel's presentation.
///
/// Transport data stays in AppModel. This state only owns presentation,
/// temporary geometry holds, and the revisions used to reject stale
/// asynchronous completions.
struct PanelState: Equatable {
    enum Mode: Equatable {
        case compact
        case peek
        case workspace
        case closingWorkspace
    }

    struct EffectRevisions: Equatable {
        var hover: UInt64 = 0
        var close: UInt64 = 0
    }

    var mode: Mode = .compact
    var isPointerInside = false
    var isCanvasHeldOpen = false
    var effectRevisions = EffectRevisions()

    var isExpanded: Bool {
        mode == .workspace || mode == .closingWorkspace
    }

    var isPanelClosing: Bool {
        mode == .closingWorkspace
    }

    var isHoveringNotch: Bool {
        mode == .peek
    }

    var isNotchCanvasExpanded: Bool {
        windowGeometryPhase != .compact
    }

    var windowGeometryPhase: PanelGeometryPhase {
        switch mode {
        case .workspace, .closingWorkspace:
            return .workspace
        case .peek:
            return .peek
        case .compact:
            return isCanvasHeldOpen ? .peek : .compact
        }
    }

    mutating func reduce(_ event: PanelEvent) -> [PanelEffect] {
        switch event {
        case .pointerEntered:
            isPointerInside = true
            guard mode != .workspace, mode != .closingWorkspace else { return [] }
            effectRevisions.hover &+= 1
            mode = .peek
            isCanvasHeldOpen = false
            return [.cancelHoverCollapse]

        case .pointerExited:
            isPointerInside = false
            guard mode == .peek else { return [] }
            effectRevisions.hover &+= 1
            let revision = effectRevisions.hover
            return [
                .cancelHoverCollapse,
                .scheduleHoverCollapse(revision: revision, delayMilliseconds: 130),
            ]

        case .hoverCollapseDelayElapsed(let revision):
            guard revision == effectRevisions.hover,
                  mode == .peek,
                  !isPointerInside else { return [] }
            mode = .compact
            isCanvasHeldOpen = true
            return []

        case .hoverCollapseAnimationCompleted(let revision):
            guard revision == effectRevisions.hover, mode == .compact else { return [] }
            isCanvasHeldOpen = false
            return []

        case .workspaceOpened:
            effectRevisions.hover &+= 1
            effectRevisions.close &+= 1
            mode = .workspace
            isCanvasHeldOpen = false
            return [.cancelHoverCollapse, .cancelWorkspaceClose]

        case .workspaceCloseRequested:
            guard mode == .workspace else { return [] }
            effectRevisions.hover &+= 1
            effectRevisions.close &+= 1
            let revision = effectRevisions.close
            mode = .closingWorkspace
            isCanvasHeldOpen = false
            return [
                .cancelHoverCollapse,
                .cancelWorkspaceClose,
                .scheduleWorkspaceClose(
                    revision: revision,
                    surfaceDelayMilliseconds: 340,
                    canvasDelayMilliseconds: 320
                ),
            ]

        case .workspaceSurfaceCloseDelayElapsed(let revision):
            guard revision == effectRevisions.close, mode == .closingWorkspace else { return [] }
            mode = .compact
            isPointerInside = false
            isCanvasHeldOpen = true
            return []

        case .workspaceCanvasCloseDelayElapsed(let revision):
            guard revision == effectRevisions.close, mode == .compact else { return [] }
            isCanvasHeldOpen = false
            return []
        }
    }
}

enum PanelEvent: Equatable {
    case pointerEntered
    case pointerExited
    case hoverCollapseDelayElapsed(revision: UInt64)
    case hoverCollapseAnimationCompleted(revision: UInt64)
    case workspaceOpened
    case workspaceCloseRequested
    case workspaceSurfaceCloseDelayElapsed(revision: UInt64)
    case workspaceCanvasCloseDelayElapsed(revision: UInt64)
}

enum PanelEffect: Equatable {
    case cancelHoverCollapse
    case scheduleHoverCollapse(revision: UInt64, delayMilliseconds: Int)
    case cancelWorkspaceClose
    case scheduleWorkspaceClose(
        revision: UInt64,
        surfaceDelayMilliseconds: Int,
        canvasDelayMilliseconds: Int
    )
}
