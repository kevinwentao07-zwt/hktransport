import MapKit
import SwiftUI

/// Real road lines for bus routes, from the Government's published route shapes.
@MainActor
final class RouteShapes: ObservableObject {
    static let shared = RouteShapes()
    @Published private var tracks: [String: RouteTrack] = [:]
    private var asked = Set<String>()

    private static func key(_ routeKey: String, _ op: Operator) -> String { "\(routeKey)|\(op.rawValue)" }

    func track(_ routeKey: String, _ op: Operator) -> RouteTrack? { tracks[Self.key(routeKey, op)] }

    /// Asks once per route. Rail has no published shape, so it keeps its lines between stations.
    func load(_ routeKey: String, route: Route, op: Operator, stopList: [String: Stop]) {
        let key = Self.key(routeKey, op)
        guard op != .mtr, op != .lightRail, let gtfsId = route.gtfsId, asked.insert(key).inserted,
              let url = URL(string: "https://hkbus.github.io/route-waypoints/\(gtfsId)-\((route.bound["kmb"] ?? route.bound[op.rawValue] ?? "O").prefix(1)).json")
        else { return }
        let stops = (route.stops[op.rawValue] ?? []).map { stopList[$0]?.location }
        Task {
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            let track = await Task.detached(priority: .userInitiated) { () -> RouteTrack? in
                RouteTrack(line: Self.line(in: data), stops: stops)
            }.value
            if let track { tracks[key] = track }
        }
    }

    /// GeoJSON, as LineStrings or MultiLineStrings of longitude and latitude.
    nonisolated static func line(in data: Data) -> [StopLocation] {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let features = object?["features"] as? [[String: Any]] ?? []
        let pairs = features.flatMap { feature -> [[Double]] in
            let geometry = feature["geometry"] as? [String: Any]
            if geometry?["type"] as? String == "LineString" { return geometry?["coordinates"] as? [[Double]] ?? [] }
            return (geometry?["coordinates"] as? [[[Double]]] ?? []).flatMap { $0 }
        }
        // Some lines have a point every metre or so, far more than a map needs.
        return pairs.enumerated().compactMap { index, pair in
            guard pair.count >= 2, pairs.count < 3_000 || index % 8 == 0 || index == pairs.count - 1 else { return nil }
            return StopLocation(lat: pair[1], lng: pair[0])
        }
    }
}

/// Walking lines from Apple Maps, which is free and belongs on this map.
@MainActor
final class WalkRoutes: ObservableObject {
    static let shared = WalkRoutes()
    private static let shortestWalk = 40.0
    private static let longestDetour = 2.5
    private static let detourAllowance = 150.0
    @Published private var lines: [String: [StopLocation]] = [:]
    private var asked = Set<String>()

    private static func key(_ from: StopLocation, _ to: StopLocation) -> String { "\(from.lat),\(from.lng),\(to.lat),\(to.lng)" }

    func line(_ from: StopLocation, _ to: StopLocation) -> [StopLocation]? { lines[Self.key(from, to)] }

    func load(_ from: StopLocation, _ to: StopLocation) {
        let key = Self.key(from, to)
        guard Geo.meters(from, to) >= Self.shortestWalk, asked.insert(key).inserted else { return }
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: from.coordinate2D))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: to.coordinate2D))
        request.transportType = .walking
        Task {
            guard let polyline = try? await MKDirections(request: request).calculate().routes.first?.polyline else { return }
            var points = [CLLocationCoordinate2D](repeating: CLLocationCoordinate2D(), count: polyline.pointCount)
            polyline.getCoordinates(&points, range: NSRange(location: 0, length: polyline.pointCount))
            // With no footpath on record, Apple sends walkers the long way round by road. A line
            // far longer than the walk planned would mislead, so that walk stays a straight line.
            guard polyline.distance(from: points) <= Geo.meters(from, to) * Self.longestDetour + Self.detourAllowance else { return }
            lines[key] = [from] + points.map { StopLocation(lat: $0.latitude, lng: $0.longitude) } + [to]
        }
    }
}

private extension MKPolyline {
    func distance(from points: [CLLocationCoordinate2D]) -> Double {
        zip(points, points.dropFirst()).reduce(0) { total, pair in
            total + Geo.meters(StopLocation(lat: pair.0.latitude, lng: pair.0.longitude), StopLocation(lat: pair.1.latitude, lng: pair.1.longitude))
        }
    }
}

/// What gets drawn for a route: lines, and the stops along them.
struct RouteLine: Identifiable {
    let id: String
    let points: [StopLocation]
    let color: Color
    var width: CGFloat = 4
    var isDotted = false
    var isCasing = false
}

struct RouteDot: Identifiable {
    let id: String
    let name: String
    let location: StopLocation
    let color: Color
    let routeKey: String
    let op: Operator
    let position: Int
}

enum RouteDrawing {
    static let returnColor = Color(red: 0.49, green: 0.30, blue: 1)

    /// A stretch of a route between two stops, each way of a circular route in its own colour.
    @MainActor
    static func ride(id: String, routeKey: String, route: Route, op: Operator, positions: [Int], points: [StopLocation],
                     stopList: [String: Stop], shapes: RouteShapes) -> [RouteLine] {
        guard let first = positions.first, let last = positions.last else { return [] }
        let track = shapes.track(routeKey, op), out = op.lineColor(route.route)
        func road(_ from: Int, _ to: Int) -> [StopLocation] {
            track?.road(from: Double(from), to: Double(to))
                ?? zip(positions, points).filter { $0.0 >= from && $0.0 <= to }.map(\.1)
        }
        var lines = [RouteLine(id: "\(id)-casing", points: road(first, last), color: .white, width: 7, isCasing: true)]
        if let turn = route.circularTurn(op, stopList: stopList), first < turn, last > turn {
            // Most go back along some of the same road, so the way back runs inside the way out.
            lines.append(RouteLine(id: "\(id)-out", points: road(first, turn), color: out, width: 6))
            lines.append(RouteLine(id: "\(id)-back", points: road(turn, last), color: returnColor, width: 2.5))
        } else {
            let isBack = route.circularTurn(op, stopList: stopList).map { first >= $0 } ?? false
            lines.append(RouteLine(id: "\(id)-line", points: road(first, last), color: isBack ? returnColor : out))
        }
        return lines
    }

    @MainActor
    static func dots(id: String, routeKey: String, route: Route, op: Operator, positions: [Int], points: [StopLocation],
                     stopIDs: [String], stopList: [String: Stop], shapes: RouteShapes, language: Lang) -> [RouteDot] {
        let track = shapes.track(routeKey, op), turn = route.circularTurn(op, stopList: stopList)
        return positions.indices.map { index in
            let position = positions[index]
            return RouteDot(id: "\(id)-\(index)", name: RoutePlannerModel.stopName(stopIDs[index], db: nil, stopList: stopList, language: language),
                            location: track?.passes[position]?.location ?? points[index],
                            color: turn.map { position > $0 } == true ? returnColor : op.lineColor(route.route),
                            routeKey: routeKey, op: op, position: position)
        }
    }
}

/// Where the buses of one route are, kept moving smoothly between the once-a-second sums.
@MainActor
final class LiveVehicles: ObservableObject {
    struct Ride: Equatable {
        let routeKey: String
        let op: Operator
        /// Nil with no stop chosen: every bus is shown, with no time to wait for.
        var boardPosition: Int?
        /// The live time for the rider's own stop, when the plan already has one.
        var liveDeparture: Date?
        /// A stop picked on the map asks for its own arrivals.
        var asksStop: Bool
    }

    private static let refreshSeconds = 30.0
    private static let sameArrivalSeconds = 90.0
    private static let framesPerSecond = 15.0

    @Published private(set) var shown: [RouteVehicle] = []
    /// Nil until they have arrived.
    @Published private(set) var stopArrivals: [ETA]?
    private var targets: [RouteVehicle] = []
    private var ride: Ride?
    private var arrivals: [RouteArrival] = []
    private var fetchedRoute = Date.distantPast, fetchedStop = Date.distantPast
    private var lastSum = Date.distantPast
    private var nextID = 0
    private var loop: Task<Void, Never>?
    private var isFetching = false
    private weak var model: AppModel?

    func follow(_ ride: Ride?, model: AppModel) {
        self.model = model
        if ride?.routeKey != self.ride?.routeKey || ride?.op != self.ride?.op {
            arrivals = []
            targets = []
            shown = []
            fetchedRoute = .distantPast
        }
        if ride?.boardPosition != self.ride?.boardPosition || ride?.routeKey != self.ride?.routeKey {
            stopArrivals = nil
            fetchedStop = .distantPast
        }
        self.ride = ride
        lastSum = .distantPast
        guard ride != nil else {
            loop?.cancel()
            loop = nil
            targets = []
            shown = []
            return
        }
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                self?.frame()
                try? await Task.sleep(for: .seconds(1 / Self.framesPerSecond))
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    private func frame() {
        let now = Date()
        if now.timeIntervalSince(lastSum) >= 1 {
            lastSum = now
            fetchIfDue(now)
            sum(now)
        }
        glide()
    }

    private func fetchIfDue(_ now: Date) {
        guard let ride, let model, let db = model.db, let route = db.routeList[ride.routeKey] else { return }
        let language = model.language, stopList = db.stopList
        if now.timeIntervalSince(fetchedRoute) >= Self.refreshSeconds, !isFetching {
            fetchedRoute = now
            isFetching = true
            Task {
                let found = (try? await ETAService.routeArrivals(route: route, op: ride.op, stopList: stopList, language: language)) ?? []
                isFetching = false
                if self.ride?.routeKey == ride.routeKey, self.ride?.op == ride.op { arrivals = found }
                lastSum = .distantPast
            }
        }
        if ride.asksStop, let seq = ride.boardPosition, now.timeIntervalSince(fetchedStop) >= Self.refreshSeconds {
            fetchedStop = now
            Task {
                let etas = (try? await ETAService.fetch(route: route, seq: seq, stopList: stopList, language: language)) ?? []
                if self.ride?.routeKey == ride.routeKey, self.ride?.boardPosition == ride.boardPosition { stopArrivals = etas }
                lastSum = .distantPast
            }
        }
    }

    /// The next time for the stop in view: the bus, the tag and the card all show this one.
    var nextArrival: Date? {
        stopArrivals?.compactMap(\.date).first { $0 > Date() }
    }

    private func sum(_ now: Date) {
        guard let ride, let db = model?.db, let route = db.routeList[ride.routeKey] else { return }
        let track = RouteShapes.shared.track(ride.routeKey, ride.op)
        let found = RouteVehicles.find(arrivals, route: route, op: ride.op, boardPosition: ride.boardPosition,
                                       stopList: db.stopList, now: now)
        let shownTime = ride.asksStop ? nextArrival : ride.liveDeparture
        var taken = Set<Int>()
        targets = found.map { candidate in
            var vehicle = candidate
            // The two answers can be up to a refresh apart; the stop, the card and the bus say the same.
            if vehicle.isNext, let shownTime, let arrival = vehicle.arrival, abs(shownTime.timeIntervalSince(arrival)) < Self.sameArrivalSeconds {
                vehicle.minutes = max(0, Int(shownTime.timeIntervalSince(now) / 60))
                vehicle.isLive = true
            }
            if let place = track?.place(at: vehicle.position) {
                vehicle.location = place.location
                vehicle.heading = place.heading
            }
            // A bus keeps its marker while it is the same bus, so a different one never jumps there.
            let same = targets.first { !taken.contains($0.id) && abs($0.position - vehicle.position) < RouteVehicles.sameBusStops }
            if let same { vehicle.id = same.id } else { nextID += 1; vehicle.id = nextID }
            taken.insert(vehicle.id)
            return vehicle
        }
    }

    private func glide() {
        guard let ride else { return }
        let track = RouteShapes.shared.track(ride.routeKey, ride.op)
        let stops = model?.db?.routeList[ride.routeKey]?.stops[ride.op.rawValue] ?? []
        let next = targets.map { target -> RouteVehicle in
            guard let current = shown.first(where: { $0.id == target.id }) else { return target }
            var vehicle = target
            vehicle.position = current.position + (target.position - current.position) * 0.12
            // Along the road rather than straight across it.
            if let place = track?.place(at: vehicle.position)
                ?? model?.db.flatMap({ RouteVehicles.place(stops, vehicle.position, stopList: $0.stopList) }) {
                vehicle.location = place.location
                let turn = (place.heading - current.heading + 540).truncatingRemainder(dividingBy: 360) - 180
                vehicle.heading = current.heading + turn * 0.2
            }
            return vehicle
        }
        if next != shown { shown = next }
    }
}

/// A small double-decker drawn in three dimensions, turned to the way it is going.
struct Bus3DView: View {
    /// Degrees clockwise from the top of the screen.
    let heading: Double
    let color: Color
    var isMinibus = false
    var isFaded = false

    var body: some View {
        Canvas { context, size in
            let turn = heading * .pi / 180, sine = sin(turn), cosine = cos(turn)
            let length = isMinibus ? 26.0 : 36.0, width = 13.0, height = isMinibus ? 11.0 : 18.0
            let centre = CGPoint(x: size.width / 2, y: size.height * 0.62)
            func point(_ along: Double, _ across: Double, _ up: Double) -> CGPoint {
                CGPoint(x: centre.x + along * sine + across * cosine, y: centre.y + (-along * cosine + across * sine) * 0.62 - up)
            }
            func fill(_ corners: [CGPoint], _ shade: Color) {
                var path = Path()
                path.addLines(corners)
                path.closeSubpath()
                context.fill(path, with: .color(shade))
            }
            let half = length / 2, side = width / 2
            /// A panel of a side: from one end to the other, between two heights.
            func panel(_ from: (Double, Double), _ to: (Double, Double), _ low: Double, _ high: Double, _ shade: Color) {
                fill([point(from.0, from.1, low), point(to.0, to.1, low), point(to.0, to.1, high), point(from.0, from.1, high)], shade)
            }
            fill([point(half + 2, side + 2, 0), point(half + 2, -side - 2, 0), point(-half - 2, -side - 2, 0), point(-half - 2, side + 2, 0)],
                 .black.opacity(0.28))
            let glass = Color(red: 0.08, green: 0.11, blue: 0.2)
            let decks: [(Double, Double)] = isMinibus ? [(0.45, 0.85)] : [(0.26, 0.46), (0.62, 0.88)]
            let faces: [(facing: Double, from: (Double, Double), to: (Double, Double), isEnd: Bool)] = [
                (cosine, (-half, side), (-half, -side), true),
                (-cosine, (half, side), (half, -side), true),
                (sine, (half, side), (-half, side), false),
                (-sine, (half, -side), (-half, -side), false),
            ]
            for face in faces where face.facing > 0 {
                panel(face.from, face.to, 0, height, color.opacity(1))
                panel(face.from, face.to, 0, height, .black.opacity(face.isEnd ? 0.1 : 0.2))
                for (low, high) in decks {
                    let inset = 0.08
                    let start = (face.from.0 + (face.to.0 - face.from.0) * inset, face.from.1 + (face.to.1 - face.from.1) * inset)
                    let end = (face.to.0 - (face.to.0 - face.from.0) * inset, face.to.1 - (face.to.1 - face.from.1) * inset)
                    panel(start, end, height * low, height * high, glass)
                }
                panel(face.from, face.to, height * 0.13, height * 0.19, .white.opacity(0.85))
            }
            fill([point(half, side, height), point(half, -side, height), point(-half, -side, height), point(-half, side, height)], color)
            fill([point(half * 0.8, side * 0.6, height), point(half * 0.8, -side * 0.6, height), point(-half * 0.8, -side * 0.6, height), point(-half * 0.8, side * 0.6, height)],
                 .white.opacity(0.22))
        }
        .frame(width: 58, height: 52)
        .opacity(isFaded ? 0.85 : 1)
        .allowsHitTesting(false)
    }
}

/// Everything a shown route puts on the map.
struct RouteLayers: MapContent {
    @MainActor let lines: [RouteLine]
    let dots: [RouteDot]
    let vehicles: [RouteVehicle]
    let busColor: Color
    let isMinibus: Bool
    let mapHeading: Double
    let chosenID: String?
    let tag: (location: StopLocation, text: String)?
    let language: (String, String) -> String
    let choose: (RouteDot) -> Void

    var body: some MapContent {
        ForEach(lines) { line in
            MapPolyline(coordinates: line.points.map(\.coordinate2D))
                .stroke(line.color, style: line.isDotted
                    ? StrokeStyle(lineWidth: line.width, lineCap: .round, lineJoin: .round, dash: [0.1, 8])
                    : StrokeStyle(lineWidth: line.width, lineCap: .round, lineJoin: .round))
        }
        ForEach(dots) { dot in
            // MapKit hides names that would collide and brings them back on zooming in.
            Annotation(dot.name, coordinate: dot.location.coordinate2D, anchor: .center) {
                Circle().fill(.white)
                    .frame(width: dot.id == chosenID ? 12 : 8, height: dot.id == chosenID ? 12 : 8)
                    .overlay(Circle().stroke(dot.color, lineWidth: 2.5))
                    .frame(width: 18, height: 18)
                    .contentShape(Circle())
                    .onTapGesture { choose(dot) }
            }
            .annotationTitles(.automatic)
        }
        if let tag {
            Annotation("", coordinate: tag.location.coordinate2D, anchor: .bottom) {
                Text(tag.text)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(Color.red, in: Capsule())
                    .shadow(radius: 3)
                    .padding(.bottom, 12)
            }
            .annotationTitles(.hidden)
        }
        ForEach(vehicles) { vehicle in
            Annotation("", coordinate: vehicle.location.coordinate2D, anchor: .center) {
                VStack(spacing: 0) {
                    Bus3DView(heading: vehicle.heading - mapHeading, color: busColor, isMinibus: isMinibus, isFaded: !vehicle.isNext)
                    if let note = note(vehicle) {
                        Text(note)
                            .font(.system(size: 10, weight: .semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.regularMaterial, in: Capsule())
                    }
                }
            }
            .annotationTitles(.hidden)
        }
    }

    /// Buses past the stop, or with no stop chosen, are simply shown where they are.
    private func note(_ vehicle: RouteVehicle) -> String? {
        guard let minutes = vehicle.minutes else { return nil }
        guard minutes > 0 else { return language("即將到站", "Arriving") }
        return language("\(vehicle.isLive ? "" : "約 ")\(minutes) 分鐘到站", "\(minutes) min away")
    }
}

/// A whole route on the map, for its own page. Picking a stop comes right in on it.
struct LiveRouteMap: View {
    @ObservedObject var model: AppModel
    let routeKey: String
    let route: Route
    let op: Operator
    @Binding var chosen: Int?
    @ObservedObject private var shapes = RouteShapes.shared
    @StateObject private var live = LiveVehicles()
    @State private var position: MapCameraPosition = .automatic
    @State private var mapHeading = 0.0

    private static let aroundStop = 0.0032

    private var ids: [String] { route.stops[op.rawValue] ?? [] }

    private var located: [(position: Int, id: String, location: StopLocation)] {
        guard let db = model.db else { return [] }
        return ids.enumerated().compactMap { position, id in
            guard let location = db.stopList[id]?.location, location.isValid else { return nil }
            return (position, id, location)
        }
    }

    private var dots: [RouteDot] {
        guard let db = model.db else { return [] }
        return RouteDrawing.dots(id: routeKey, routeKey: routeKey, route: route, op: op, positions: located.map(\.position),
                                 points: located.map(\.location), stopIDs: located.map(\.id), stopList: db.stopList,
                                 shapes: shapes, language: model.language)
    }

    private var lines: [RouteLine] {
        guard let db = model.db else { return [] }
        return RouteDrawing.ride(id: routeKey, routeKey: routeKey, route: route, op: op, positions: located.map(\.position),
                                 points: located.map(\.location), stopList: db.stopList, shapes: shapes)
    }

    private var tag: (location: StopLocation, text: String)? {
        guard let chosen, let dot = dots.first(where: { $0.position == chosen }) else { return nil }
        guard let arrivals = live.stopArrivals else { return (dot.location, model.t("查詢中…", "Checking…")) }
        guard let next = arrivals.compactMap(\.date).first(where: { $0 > model.now }) else {
            return (dot.location, model.t("暫無到站資料", "No arrivals"))
        }
        let minutes = Int(next.timeIntervalSince(model.now) / 60)
        return (dot.location, minutes == 0 ? model.t("即將到站", "Arriving") : model.t("還有 \(minutes) 分鐘", "\(minutes) min"))
    }

    private var ride: LiveVehicles.Ride {
        LiveVehicles.Ride(routeKey: routeKey, op: op, boardPosition: chosen, liveDeparture: nil, asksStop: chosen != nil)
    }

    var body: some View {
        Map(position: $position, interactionModes: .all) {
            RouteLayers(lines: lines, dots: dots, vehicles: op == .mtr || op == .lightRail ? [] : live.shown, busColor: op.color,
                        isMinibus: op == .gmb, mapHeading: mapHeading, chosenID: dots.first { $0.position == chosen }?.id, tag: tag,
                        language: model.t) { dot in
                chosen = chosen == dot.position ? nil : dot.position
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .mapControls { MapCompass(); MapScaleView(); MapZoomStepper() }
        .onMapCameraChange(frequency: .continuous) { mapHeading = $0.camera.heading }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .bottomLeading) { legend }
        .onAppear {
            if let db = model.db { shapes.load(routeKey, route: route, op: op, stopList: db.stopList) }
            live.follow(ride, model: model)
            fit(animated: false)
        }
        .onDisappear { live.follow(nil, model: model) }
        .onChange(of: chosen) {
            live.follow(ride, model: model)
            fit(animated: true)
        }
        .onChange(of: routeKey) {
            if let db = model.db { shapes.load(routeKey, route: route, op: op, stopList: db.stopList) }
            live.follow(ride, model: model)
            fit(animated: true)
        }
        .accessibilityLabel(model.t("路線 Apple 地圖", "Apple Map of the route"))
    }

    @ViewBuilder
    private var legend: some View {
        if let db = model.db, let turn = route.circularTurn(op, stopList: db.stopList), ids.indices.contains(turn) {
            HStack(spacing: 12) {
                Label {
                    Text(model.t("去程：往\(RoutePlannerModel.stopName(ids[turn], db: db, language: model.language))",
                                 "Out: to \(RoutePlannerModel.stopName(ids[turn], db: db, language: model.language))"))
                } icon: { Circle().fill(op.lineColor(route.route)).frame(width: 9, height: 9) }
                Label {
                    Text(model.t("回程：返回起點", "Back: to the start"))
                } icon: { Circle().fill(RouteDrawing.returnColor).frame(width: 9, height: 9) }
            }
            .font(.system(size: 11, weight: .medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
            .padding(10)
        }
    }

    /// The whole route, or right in on a chosen stop.
    private func fit(animated: Bool) {
        let target: MKCoordinateRegion?
        if let chosen, let dot = dots.first(where: { $0.position == chosen }) {
            target = MKCoordinateRegion(center: dot.location.coordinate2D,
                                        span: MKCoordinateSpan(latitudeDelta: Self.aroundStop, longitudeDelta: Self.aroundStop))
        } else {
            target = MKCoordinateRegion(fitting: located.map(\.location))
        }
        guard let target else { return }
        if animated {
            withAnimation(.easeInOut(duration: 0.5)) { position = .region(target) }
        } else {
            position = .region(target)
        }
    }
}
