import AppKit
import CoreLocation
import Combine

/// Requests a single location fix while the nearby-bus page is visible.
/// Coordinates stay in memory and are never included in ETA requests.
@MainActor
final class BusLocationModel: NSObject, ObservableObject, CLLocationManagerDelegate {
    enum Issue { case denied, unavailable }

    @Published private(set) var location: CLLocation?
    @Published private(set) var authorization = CLAuthorizationStatus.notDetermined
    @Published private(set) var isLocating = false
    @Published private(set) var issue: Issue?
    private let manager = CLLocationManager()
    private var isActive = false
    private var timeout: Task<Void, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        authorization = manager.authorizationStatus
    }

    func resume() {
        isActive = true
        authorization = manager.authorizationStatus
        if authorization == .authorizedAlways {
            locate()
        } else if authorization == .denied || authorization == .restricted {
            location = nil
            issue = .denied
        }
    }

    func pause() {
        isActive = false
        timeout?.cancel()
        manager.stopUpdatingLocation()
        isLocating = false
    }

    func locate() {
        guard !isLocating else { return }
        isActive = true
        authorization = manager.authorizationStatus
        issue = nil
        switch authorization {
        case .notDetermined:
            // A user click brings the app forward before the system prompt.
            NSApp.activate(ignoringOtherApps: true)
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

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor [weak self] in self?.authorizationChanged() }
    }

    private func authorizationChanged() {
        authorization = manager.authorizationStatus
        if authorization == .denied || authorization == .restricted {
            pause()
            location = nil
            issue = .denied
        } else if isActive && authorization == .authorizedAlways {
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
        location = latest
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
