import XCTest

@testable import hktransport

final class SettingsTests: XCTestCase {
    @MainActor
    func testSettingsPersistWithoutChangingSavedStops() throws {
        let suite = "hktransport.settings-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let model = AppModel(defaults: defaults)
        XCTAssertEqual(model.language, .zh)
        XCTAssertEqual(model.refreshInterval, .thirtySeconds)
        let stop = SavedStop(routeKey: "test-route", seq: 2)
        model.toggleSaved(stop)
        model.language = .en
        model.refreshInterval = .sixtySeconds

        let restored = AppModel(defaults: defaults)
        XCTAssertEqual(restored.language, .en)
        XCTAssertEqual(restored.refreshInterval, .sixtySeconds)
        XCTAssertEqual(restored.savedStops, [stop])
    }

    @MainActor
    func testUnknownPreferencesFallBackToDefaults() throws {
        let suite = "hktransport.settings-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("unknown", forKey: "hktransport.language")
        defaults.set(-1, forKey: "hktransport.refreshInterval")

        let model = AppModel(defaults: defaults)
        XCTAssertEqual(model.language, .zh)
        XCTAssertEqual(model.refreshInterval, .thirtySeconds)
    }

    @MainActor
    func testSettingsNavigationCanInterruptPanelClosing() {
        let model = AppModel()
        model.showSettings()
        XCTAssertTrue(model.isExpanded)
        XCTAssertTrue(model.isShowingSettings)
        model.hideSettings()
        XCTAssertFalse(model.isShowingSettings)
        XCTAssertTrue(model.isExpanded)

        model.collapseExpanded()
        XCTAssertTrue(model.isPanelClosing)
        model.showSettings()
        XCTAssertFalse(model.isPanelClosing)
        XCTAssertTrue(model.isShowingSettings)
        model.stop()
    }
}
