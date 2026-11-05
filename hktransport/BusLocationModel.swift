import AppKit
import CoreLocation
import Combine

/// Gets one location fix per launch and reuses it on the nearby-bus and trip
/// pages; only the rider's own location buttons ask for a new one, and only
/// navigation keeps the location on. Shared
/// because the panel is rebuilt every time the notch opens.
/// Coordinates stay in memory and are never included in ETA requests.
@MainActor
final class BusLocationModel: NSObject, ObservableObject, CLLocationManagerDelegate {
    enum Issue { case denied, unavailable }

    static let shared = BusLocationModel()

    @Published private(set) var location: CLLocation?
    @Published private(set) var authorization = CLAuthorizationStatus.notDetermined
    @Published private(set) var isLocating = false
    @Published private(set) var issue: Issue?
    /// Updates while navigating; kept apart so the nearby page doesn't re-search.
    @Published private(set) var trackedLocation: CLLocation?
    private let manager: CLLocationManager
    private var isActive = false
    private var hasRequested = false
    private var isTracking = false
    private var timeout: Task<Void, Never>?

    init(manager: CLLocationManager = CLLocationManager()) {
        self.manager = manager
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        authorization = manager.authorizationStatus
    }

    func resume() {
        isActive = true
        authorization = manager.authorizationStatus
        if authorization == .authorizedAlways {
            requestOnce()
        } else if authorization == .denied || authorization == .restricted {
            location = nil
            issue = .denied
        }
    }

    /// Asks for a position unless this launch already has one or has already asked.
    func requestOnce() {
        isActive = true
        guard location == nil, !isLocating, !hasRequested else { return }
        locate()
    }

    /// Continuous updates for navigation, until `stopTracking()`.
    func startTracking() {
        timeout?.cancel()
        isLocating = false
        isTracking = true
        isActive = true
        hasRequested = true
        issue = nil
        trackedLocation = nil
        authorization = manager.authorizationStatus
        switch authorization {
        case .notDetermined:
            NSApplication.shared.activate(ignoringOtherApps: true)
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways:
            manager.distanceFilter = 15
            manager.startUpdatingLocation()
        default:
            issue = .denied
        }
    }

    func stopTracking() {
        guard isTracking else { return }
        isTracking = false
        manager.stopUpdatingLocation()
        manager.distanceFilter = kCLDistanceFilterNone
        // Navigation just found out where the rider is, so keep that.
        if let trackedLocation { location = trackedLocation }
        trackedLocation = nil
    }

    func pause() {
        // Navigation carries on after the page or the notch closes.
        guard !isTracking else { return }
        isActive = false
        // Leaving the page cancels a request in flight, so that one never counted.
        if isLocating, location == nil { hasRequested = false }
        timeout?.cancel()
        manager.stopUpdatingLocation()
        isLocating = false
    }

    /// Always asks again; call `requestOnce()` unless the rider pressed a button.
    func locate() {
        guard !isLocating, !isTracking else { return }
        isActive = true
        hasRequested = true
        authorization = manager.authorizationStatus
        issue = nil
        switch authorization {
        case .notDetermined:
            // A user click brings the app forward before the system prompt.
            NSApplication.shared.activate(ignoringOtherApps: true)
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways:
            isLocating = true
            manager.requestLocation()
            timeout?.cancel()
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                guard let self, !Task.isCancelled else { return }
                self.manager.stopUpdatingLocation()
                self.isLocating = false
                self.issue = .unavailable
            }
        default:
            issue = .denied
        }
    }

    /// The position for trip planning: this launch's fix, waiting briefly for the
    /// first one. A trip can't start from here without it, so a failed attempt is retried.
    func currentFix(timeout: Duration = .seconds(12)) async -> CLLocation? {
        if let location { return location }
        authorization = manager.authorizationStatus
        if authorization != .notDetermined || !hasRequested { locate() }
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline, !Task.isCancelled, issue == nil, location == nil {
            try? await Task.sleep(for: .milliseconds(200))
        }
        return location
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor [weak self] in self?.authorizationChanged() }
    }

    private func authorizationChanged() {
        authorization = manager.authorizationStatus
        if authorization == .denied || authorization == .restricted {
            pause()
            location = nil
            issue = .denied
        } else if isTracking && authorization == .authorizedAlways {
            manager.distanceFilter = 15
            manager.startUpdatingLocation()
        } else if isActive && authorization == .authorizedAlways && location == nil {
            locate()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor [weak self] in self?.received(locations) }
    }

    private func received(_ locations: [CLLocation]) {
        guard isActive, let latest = locations.last(where: {
            $0.horizontalAccuracy >= 0 && abs($0.timestamp.timeIntervalSinceNow) < 120
        }) else { return }
        timeout?.cancel()
        if isTracking {
            trackedLocation = latest
        } else {
            location = latest
        }
        isLocating = false
        issue = nil
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        Task { @MainActor [weak self] in self?.failed(denied: denied) }
    }

    private func failed(denied: Bool) {
        guard isActive else { return }
        timeout?.cancel()
        isLocating = false
        if denied { location = nil }
        issue = denied ? .denied : .unavailable
    }

    func openSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices") else { return }
        NSWorkspace.shared.open(url)
    }
}
