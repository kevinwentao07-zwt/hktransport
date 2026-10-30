import AppKit
import SwiftUI

struct NotchRootView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var panelGeometry: NotchPanelGeometryModel
    @State private var pointerInside = false

    private var hovering: Bool {
        model.isHoveringNotch || model.isExpanded
    }

    private var compactHeight: CGFloat {
        hovering ? NotchLayout.hoveredHeight : model.menuBarHeight
    }

    var body: some View {
        VStack(spacing: NotchLayout.expandedGap) {
            collapsedBar
                .frame(height: compactHeight)

            if model.isExpanded {
                ExpandedPanelSurface(model: model)
            }
        }
        // AppKit owns the panel's frame; keep SwiftUI's root size aligned with it.
        .frame(width: panelGeometry.size.width, height: panelGeometry.size.height, alignment: .top)
        .background {
            if model.isExpanded {
                // Keep transparent gutters hit-testable so a click beside the panel dismisses it.
                Color.clear.contentShape(Rectangle())
            }
        }
    }

    private var collapsedBar: some View {
        Button {
            model.toggleExpanded()
        } label: {
            LivingNotch(model: model)
        }
        .buttonStyle(StableNotchButtonStyle())
        .contextMenu {
            Button(model.t("設定…", "Settings…"), systemImage: "gearshape") {
                model.showSettings()
            }
            Divider()
            Button(model.t("English", "中文")) {
                model.language = model.language == .zh ? .en : .zh
            }
            Divider()
            Button(model.t("結束 hktransport", "Quit hktransport"), role: .destructive) {
                model.quitApplication()
            }
        }
        .background(alignment: .top) {
            NotchHoverTracker { location in
                let inside = location != nil
                guard inside != pointerInside else { return }
                pointerInside = inside
                model.setNotchHovered(inside)
            }
            .frame(height: compactHeight)
        }
        .accessibilityLabel(model.t(model.isExpanded ? "收起" : "展開", model.isExpanded ? "Collapse" : "Expand"))
        .frame(maxWidth: .infinity, alignment: .top)
    }
}

/// The black surface hugging the hardware notch: route + next ETA on the wings,
/// the first saved stop when hovered.
struct LivingNotch: View {
    @ObservedObject var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var hovering: Bool {
        model.isHoveringNotch || model.isExpanded
    }

    private var firstStop: SavedStop? {
        model.savedStops.first
    }

    private var wingWidth: CGFloat {
        firstStop == nil ? 0 : NotchLayout.compactWingSlotWidth
    }

    private var compactBarHeight: CGFloat {
        min(model.menuBarHeight, 40)
    }

    var body: some View {
        NotchSilhouette(shoulderRadius: NotchLayout.shoulderRadius, bottomCornerRadius: hovering ? 22 : 12)
            .fill(.black)
            .frame(
                width: NotchLayout.compactSurfaceWidth(wingWidth: wingWidth, notchWidth: model.notchWidth),
                height: hovering ? NotchLayout.hoveredHeight : compactBarHeight,
                alignment: .top
            )
            .overlay(alignment: .top) {
                compactWings
                    .opacity(hovering ? 0 : 1)
                    .accessibilityHidden(hovering)
            }
            .overlay(alignment: .bottom) {
                peek
                    .frame(height: NotchLayout.hoveredHeight - compactBarHeight)
                    .padding(.horizontal, NotchLayout.shoulderRadius + 12)
                    .opacity(hovering ? 1 : 0)
                    .accessibilityHidden(!hovering)
            }
            .contentShape(Rectangle())
            .foregroundStyle(.white)
            .animation(reduceMotion ? .linear(duration: 0.01) : NotchDesign.Motion.hover, value: hovering)
    }

    private var compactWings: some View {
        HStack(spacing: 0) {
            if let stop = firstStop, let route = model.route(for: stop) {
                Text(route.route)
                    .foregroundStyle(route.operators.first?.color ?? .white)
                    .frame(width: wingWidth)
                Color.clear.frame(width: model.notchWidth)
                Text(nextMinutesText(for: stop))
                    .frame(width: wingWidth)
            }
        }
        .font(.system(size: 12, weight: .bold, design: .rounded))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .frame(height: compactBarHeight)
    }

    @ViewBuilder
    private var peek: some View {
        if let stop = firstStop, let route = model.route(for: stop) {
            HStack(spacing: 10) {
                RouteBadge(route: route, compact: true)
                VStack(alignment: .leading, spacing: 0) {
                    Text("→ \(route.dest.text(model.language))")
                        .font(.system(size: 12, weight: .semibold))
                    Text(model.stopName(route, seq: stop.seq))
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.6))
                }
                .lineLimit(1)
                Spacer(minLength: 4)
                ETASummary(model: model, etas: model.etas[stop], large: false)
            }
        } else {
            Text(model.db == nil
                 ? model.t("正在載入路線資料…", "Loading route data…")
                 : model.t("按一下搜尋路線", "Click to search a route"))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white.opacity(0.7))
        }
    }

    private func nextMinutesText(for stop: SavedStop) -> String {
        guard let etas = model.etas[stop] else { return "…" }
        guard let next = model.upcoming(etas).first, let minutes = model.minutes(until: next) else { return "–" }
        return minutes == 0 ? model.t("即到", "Now") : "\(minutes)'"
    }
}

struct ExpandedPanelSurface: View {
    @ObservedObject var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isVisible = false

    var body: some View {
        TransportPanel(model: model)
            .frame(width: NotchLayout.expandedPanelWidth, height: NotchLayout.expandedPanelHeight)
            .background(.black, in: RoundedRectangle(cornerRadius: NotchDesign.Radius.panel, style: .continuous))
            .environment(\.colorScheme, .dark)
            .opacity(isVisible ? 1 : 0)
            .offset(y: reduceMotion || isVisible ? 0 : 8)
            .task {
                await Task.yield()
                guard !model.isPanelClosing else { return }
                withAnimation(reduceMotion ? .linear(duration: 0.12) : NotchDesign.Motion.panelOpen) {
                    isVisible = true
                }
            }
            .onChange(of: model.isPanelClosing) { _, closing in
                withAnimation(
                    reduceMotion
                        ? .linear(duration: 0.12)
                        : closing ? NotchDesign.Motion.panelClose : NotchDesign.Motion.panelOpen
                ) {
                    isVisible = !closing
                }
            }
            .allowsHitTesting(!model.isPanelClosing)
    }
}

struct NotchSilhouette: Shape {
    let shoulderRadius: CGFloat
    let bottomCornerRadius: CGFloat

    func path(in rect: CGRect) -> Path {
        let shoulder = min(shoulderRadius, min(rect.width / 4, rect.height / 3))
        let bodyLeft = rect.minX + shoulder
        let bodyRight = rect.maxX - shoulder
        let bottomRadius = min(bottomCornerRadius, min((bodyRight - bodyLeft) / 2, max(0, rect.height - shoulder)))
        let bottom = rect.maxY

        var path = Path()
        // Extend the top edge past the bounds so antialiasing never shows a seam at the bezel.
        path.move(to: CGPoint(x: rect.minX, y: rect.minY - 1))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY - 1))
        // Concave shoulders where the notch meets the top bezel.
        path.addCurve(
            to: CGPoint(x: bodyRight, y: rect.minY + shoulder),
            control1: CGPoint(x: rect.maxX - shoulder * 0.58, y: rect.minY - 1),
            control2: CGPoint(x: bodyRight, y: rect.minY + shoulder * 0.42)
        )
        path.addLine(to: CGPoint(x: bodyRight, y: bottom - bottomRadius))
        path.addCurve(
            to: CGPoint(x: bodyRight - bottomRadius, y: bottom),
            control1: CGPoint(x: bodyRight, y: bottom - bottomRadius * 0.45),
            control2: CGPoint(x: bodyRight - bottomRadius * 0.45, y: bottom)
        )
        path.addLine(to: CGPoint(x: bodyLeft + bottomRadius, y: bottom))
        path.addCurve(
            to: CGPoint(x: bodyLeft, y: bottom - bottomRadius),
            control1: CGPoint(x: bodyLeft + bottomRadius * 0.45, y: bottom),
            control2: CGPoint(x: bodyLeft, y: bottom - bottomRadius * 0.45)
        )
        path.addLine(to: CGPoint(x: bodyLeft, y: rect.minY + shoulder))
        path.addCurve(
            to: CGPoint(x: rect.minX, y: rect.minY - 1),
            control1: CGPoint(x: bodyLeft, y: rect.minY + shoulder * 0.42),
            control2: CGPoint(x: rect.minX + shoulder * 0.58, y: rect.minY - 1)
        )
        path.closeSubpath()
        return path
    }
}

private struct StableNotchButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
    }
}

private struct NotchHoverTracker: NSViewRepresentable {
    let onPointerLocation: (CGPoint?) -> Void

    func makeNSView(context: Context) -> HoverTrackingView {
        let view = HoverTrackingView()
        view.onPointerLocation = onPointerLocation
        return view
    }

    func updateNSView(_ nsView: HoverTrackingView, context: Context) {
        nsView.onPointerLocation = onPointerLocation
    }
}

@MainActor
private final class HoverTrackingView: NSView {
    var onPointerLocation: ((CGPoint?) -> Void)?
    private var hoverArea: NSTrackingArea?
    private var pendingPointerLocation: CGPoint?
    private var hasPendingPointerLocation = false
    private var pointerDeliveryScheduled = false

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        // inVisibleRect follows the view bounds; replacing the area on every
        // layout pass would itself fire enter/move callbacks while resizing.
        guard hoverArea == nil else { return }
        let area = NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        hoverArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        schedulePointerLocation(convert(event.locationInWindow, from: nil))
    }

    override func mouseMoved(with event: NSEvent) {
        schedulePointerLocation(convert(event.locationInWindow, from: nil))
    }

    override func mouseExited(with event: NSEvent) {
        schedulePointerLocation(nil)
    }

    private func schedulePointerLocation(_ location: CGPoint?) {
        pendingPointerLocation = location
        hasPendingPointerLocation = true
        guard !pointerDeliveryScheduled else { return }
        pointerDeliveryScheduled = true

        // The callback changes SwiftUI layout; deliver it after the current
        // AppKit event pass and coalesce movement generated by that change.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pointerDeliveryScheduled = false
            guard self.hasPendingPointerLocation else { return }
            let location = self.pendingPointerLocation
            self.pendingPointerLocation = nil
            self.hasPendingPointerLocation = false
            self.onPointerLocation?(location)
        }
    }
}
