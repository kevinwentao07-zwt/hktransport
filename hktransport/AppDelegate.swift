import AppKit
import Combine
import SwiftUI

@main
struct HKTransportApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            SettingsPanel(model: appDelegate.model, showsBackButton: false)
                .padding(20)
                .frame(width: 460, height: 400)
                .preferredColorScheme(.dark)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    private var panelController: NotchPanelController?

    nonisolated static func shouldStartAppServices(environment: [String: String]) -> Bool {
        environment["XCTestConfigurationFilePath"] == nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hosted unit tests launch the app executable; keep the shell dormant there.
        guard Self.shouldStartAppServices(environment: ProcessInfo.processInfo.environment) else { return }

        // Accessory apps can be auto-terminated when no window is visible.
        // The notch panel stays resident even while collapsed.
        ProcessInfo.processInfo.automaticTerminationSupportEnabled = true
        ProcessInfo.processInfo.disableAutomaticTermination(
            "hktransport remains available while its panel is collapsed"
        )
        NSApp.setActivationPolicy(.accessory)

        let controller = NotchPanelController(model: model)
        panelController = controller
        controller.show()
        model.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

@MainActor
private final class InteractiveNotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
final class NotchPanelGeometryModel: ObservableObject {
    @Published private(set) var size: CGSize

    init(size: CGSize) {
        self.size = size
    }

    func update(size: CGSize) {
        guard self.size != size else { return }
        self.size = size
    }
}

@MainActor
final class NotchPanelController {
    private let model: AppModel
    private let panel: NSPanel
    private let hostedPanelGeometry: NotchPanelGeometryModel
    private var cancellables = Set<AnyCancellable>()
    private var resizeRevision = 0
    private var scheduledResizeTask: Task<Void, Never>?
    private var frameAnimationTimer: Timer?
    private var globalMouseMonitor: Any?
    private var localMouseMonitor: Any?
    private var outsideCollapseTask: Task<Void, Never>?

    init(model: AppModel) {
        self.model = model

        panel = InteractiveNotchPanel(
            contentRect: NSRect(x: 0, y: 0, width: NotchLayout.panelWidth, height: model.menuBarHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        let hostedPanelGeometry = NotchPanelGeometryModel(
            size: CGSize(width: NotchLayout.panelWidth, height: model.menuBarHeight)
        )
        self.hostedPanelGeometry = hostedPanelGeometry

        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.acceptsMouseMovedEvents = true
        panel.becomesKeyOnlyIfNeeded = false
        let hostingView = NSHostingView(
            rootView: NotchRootView(model: model, panelGeometry: hostedPanelGeometry)
        )
        hostingView.sizingOptions = []
        panel.contentView = hostingView

        installOutsideClickMonitors()

        model.$panelState
            .map(\.windowGeometryPhase)
            .removeDuplicates()
            .sink { [weak self] _ in
                self?.scheduleResize(animated: true)
            }
            .store(in: &cancellables)

        model.$panelState
            .map { !$0.isExpanded }
            .removeDuplicates()
            .filter { $0 }
            .sink { [weak self] _ in
                guard let self, self.panel.isKeyWindow else { return }
                self.panel.resignKey()
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
            .sink { [weak self] _ in
                self?.scheduleResize(animated: false)
            }
            .store(in: &cancellables)
    }

    deinit {
        scheduledResizeTask?.cancel()
        outsideCollapseTask?.cancel()
        frameAnimationTimer?.invalidate()
        if let globalMouseMonitor {
            NSEvent.removeMonitor(globalMouseMonitor)
        }
        if let localMouseMonitor {
            NSEvent.removeMonitor(localMouseMonitor)
        }
    }

    func show() {
        resize(state: model.panelState, animated: false)
        panel.orderFrontRegardless()
    }

    private func scheduleResize(animated: Bool) {
        scheduledResizeTask?.cancel()
        scheduledResizeTask = Task { @MainActor [weak self] in
            // Resizing the hosting window inside SwiftUI's constraint pass traps;
            // defer one display interval and coalesce intermediate states.
            try? await Task.sleep(for: .milliseconds(16))
            guard !Task.isCancelled, let self else { return }
            self.resize(state: self.model.panelState, animated: animated)
        }
    }

    private func resize(state: PanelState, animated: Bool) {
        guard let screen = NotchScreen.preferred else { return }
        let shouldAnimate = animated && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

        let menuBarHeight = NotchLayout.menuBarHeight(
            screenFrame: screen.frame,
            visibleFrame: screen.visibleFrame
        )
        let notchWidth = resolvedNotchWidth(on: screen)
        if model.menuBarHeight != menuBarHeight {
            model.menuBarHeight = menuBarHeight
        }
        if model.notchWidth != notchWidth {
            model.notchWidth = notchWidth
        }

        let frame = NotchLayout.windowFrame(
            screenFrame: screen.frame,
            height: NotchLayout.panelHeight(menuBarHeight: menuBarHeight, phase: state.windowGeometryPhase)
        )
        hostedPanelGeometry.update(size: frame.size)

        // Hover and close animate inside a stationary canvas, so resize the window
        // immediately and let SwiftUI animate the black surface. Only opening grows the frame.
        guard shouldAnimate, state.isExpanded else {
            resizeRevision += 1
            frameAnimationTimer?.invalidate()
            frameAnimationTimer = nil
            if panel.frame != frame {
                panel.setFrame(frame, display: true)
            }
            panel.orderFrontRegardless()
            return
        }

        resizeRevision += 1
        frameAnimationTimer?.invalidate()
        frameAnimationTimer = nil
        animatePanel(
            to: frame,
            duration: state.isExpanded && !state.isPanelClosing ? 0.38 : 0.30,
            curve: state.isExpanded && !state.isPanelClosing ? .open : .close,
            revision: resizeRevision
        )
        panel.orderFrontRegardless()
    }

    private func animatePanel(to targetFrame: NSRect, duration: TimeInterval, curve: FrameAnimationCurve, revision: Int) {
        let startFrame = panel.frame
        guard startFrame != targetFrame, duration > 0 else {
            panel.setFrame(targetFrame, display: true)
            return
        }

        let startTime = Date.timeIntervalSinceReferenceDate
        let timer = Timer(timeInterval: 1 / 120, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self, self.resizeRevision == revision else {
                    timer.invalidate()
                    return
                }

                let elapsed = Date.timeIntervalSinceReferenceDate - startTime
                let linearProgress = min(1, max(0, elapsed / duration))
                let progress = curve.value(at: CGFloat(linearProgress))
                let interpolatedFrame = NSRect(
                    x: startFrame.origin.x + (targetFrame.origin.x - startFrame.origin.x) * progress,
                    y: startFrame.origin.y + (targetFrame.origin.y - startFrame.origin.y) * progress,
                    width: startFrame.width + (targetFrame.width - startFrame.width) * progress,
                    height: startFrame.height + (targetFrame.height - startFrame.height) * progress
                )
                self.panel.setFrame(interpolatedFrame, display: true)

                if linearProgress >= 1 {
                    timer.invalidate()
                    self.frameAnimationTimer = nil
                    self.panel.setFrame(targetFrame, display: true)
                }
            }
        }
        timer.tolerance = 1 / 480
        frameAnimationTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func installOutsideClickMonitors() {
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] _ in
            // Global monitors only see clicks delivered to other apps.
            Task { @MainActor [weak self] in
                self?.scheduleGlobalOutsideCollapse()
            }
        }

        localMouseMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .keyDown]
        ) { [weak self] event in
            let shouldForward = MainActor.assumeIsolated {
                guard let self, event.window === self.panel else { return true }
                // Settings has no text field, so handle shortcuts even when
                // SwiftUI has no focused control to receive onExitCommand.
                if event.type == .keyDown {
                    if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "q" {
                        self.model.quitApplication()
                        return false
                    }
                    if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "w" {
                        self.model.collapseExpanded()
                        return false
                    }
                    if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "," {
                        self.model.showSettings()
                        return false
                    }
                    if event.keyCode == 53, self.model.isShowingSettings, self.model.isExpanded {
                        self.model.hideSettings()
                        return false
                    }
                    return true
                }
                if event.type == .leftMouseDown, !self.panel.isKeyWindow {
                    // Become key without activating the app so the search field takes typing.
                    self.panel.makeKey()
                }
                let location = self.panel.convertPoint(toScreen: event.locationInWindow)
                if self.model.isExpanded,
                   !NotchLayout.workspaceVisibleSurfaceFrame(in: self.panel.frame).contains(location) {
                    self.model.collapseExpanded()
                }
                return true
            }
            return shouldForward ? event : nil
        }
    }

    private func scheduleGlobalOutsideCollapse() {
        outsideCollapseTask?.cancel()
        outsideCollapseTask = Task { @MainActor [weak self] in
            while NSEvent.pressedMouseButtons != 0 {
                try? await Task.sleep(for: .milliseconds(40))
                guard !Task.isCancelled else { return }
            }
            guard !Task.isCancelled, let self, self.model.isExpanded else { return }
            self.model.collapseExpanded()
        }
    }

    private func resolvedNotchWidth(on screen: NSScreen) -> CGFloat {
        var measuredWidth: CGFloat?
        if let leftArea = screen.auxiliaryTopLeftArea, let rightArea = screen.auxiliaryTopRightArea {
            measuredWidth = rightArea.minX - leftArea.maxX
        }
        return NotchLayout.resolvedNotchWidth(
            hasSafeArea: screen.safeAreaInsets.top > 0,
            measuredWidth: measuredWidth
        )
    }
}

private enum FrameAnimationCurve {
    case open
    case close

    func value(at progress: CGFloat) -> CGFloat {
        let progress = min(1, max(0, progress))
        switch self {
        case .open:
            // Quintic smootherstep: zero velocity and acceleration at both ends.
            return min(1, max(0, progress * progress * progress * (progress * (progress * 6 - 15) + 10)))
        case .close:
            if progress < 0.5 {
                return 4 * pow(progress, 3)
            }
            return 1 - pow(-2 * progress + 2, 3) / 2
        }
    }
}
