import AppKit
import SwiftUI

struct StationMapView: View {
    @ObservedObject var model: AppModel
    let stations: [MTRMapStation]
    let imageName: String
    let imageSize: CGSize
    let title: String
    @Binding var selectedStation: String?
    @State private var zoom: CGFloat = 1
    @State private var hoveredStation: String?

    private static let images: [String: NSImage] = {
        Dictionary(uniqueKeysWithValues: ["MTRSystemMap", "LightRailSystemMap"].compactMap { name in
            let url = Bundle.main.url(forResource: name, withExtension: "png")
                ?? Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "Resources")
            guard let image = url.flatMap(NSImage.init(contentsOf:)) else { return nil }
            return (name, image)
        })
    }()

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Label(title, systemImage: "map")
                    .font(.system(size: 12, weight: .medium))
                Spacer()
                Button { zoom = max(1, zoom - 0.5) } label: { Image(systemName: "minus.magnifyingglass") }
                    .disabled(zoom <= 1).help(model.t("縮小", "Zoom out"))
                Text("\(Int(zoom * 100))%")
                    .font(.system(size: 10)).monospacedDigit().frame(width: 34)
                Button { zoom = min(4, zoom + 0.5) } label: { Image(systemName: "plus.magnifyingglass") }
                    .disabled(zoom >= 4).help(model.t("放大", "Zoom in"))
                Button(model.t("全圖", "Fit")) { zoom = 1 }
                    .font(.system(size: 11))
            }
            .buttonStyle(.borderless)

            GeometryReader { geometry in
                let fitScale = min(geometry.size.width / imageSize.width, geometry.size.height / imageSize.height)
                let scale = fitScale * zoom
                ScrollViewReader { proxy in
                    ScrollView([.horizontal, .vertical]) {
                        ZStack(alignment: .topLeading) {
                            if let image = Self.images[imageName] {
                                Image(nsImage: image)
                                    .resizable()
                                    .frame(width: imageSize.width * scale, height: imageSize.height * scale)
                                    .accessibilityHidden(true)
                            }
                            ForEach(stations) { station in
                                stationButton(station, scale: scale)
                                    .position(x: station.x * scale, y: station.y * scale)
                                    .id(station.code)
                            }
                        }
                        .frame(width: imageSize.width * scale, height: imageSize.height * scale)
                        .frame(minWidth: geometry.size.width, minHeight: geometry.size.height)
                    }
                    .onChange(of: selectedStation) { _, code in
                        guard let code else { return }
                        withAnimation(model.motion(.easeInOut(duration: 0.2))) {
                            proxy.scrollTo(code, anchor: .center)
                        }
                    }
                    .onChange(of: zoom) { _, _ in
                        if let selectedStation { proxy.scrollTo(selectedStation, anchor: .center) }
                    }
                }
            }
            .background(imageName == "MTRSystemMap" ? Color(red: 0.73, green: 0.88, blue: 0.92) : .white)
            .clipShape(RoundedRectangle(cornerRadius: 12))

            Text(model.t("點選車站圓點 · 放大後可捲動瀏覽", "Click a station marker · Zoom in and scroll to explore"))
                .font(.system(size: 10)).foregroundStyle(.secondary)
        }
    }

    private func stationButton(_ station: MTRMapStation, scale: CGFloat) -> some View {
        let selected = selectedStation == station.code
        let hovered = hoveredStation == station.code
        return Button {
            selectedStation = station.code
        } label: {
            Circle()
                .fill(selected ? Color.yellow.opacity(0.85) : hovered ? Color.yellow.opacity(0.45) : .clear)
                .overlay {
                    if selected || hovered {
                        Circle().stroke(.black.opacity(0.8), lineWidth: selected ? 2 : 1)
                    }
                }
                .frame(width: max(12, 30 * scale), height: max(12, 30 * scale))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hoveredStation = $0 ? station.code : nil }
        .help(station.name.text(model.language) + " · " + station.lines.joined(separator: " / "))
        .accessibilityLabel(station.name.text(model.language) + " (\(station.code))")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
