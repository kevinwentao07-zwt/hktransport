import AppKit
import ServiceManagement
import SwiftUI

struct SettingsPanel: View {
    @ObservedObject var model: AppModel
    var showsBackButton = true
    @State private var apiKeyDraft = ""
    @State private var apiKeyStatus: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                if showsBackButton {
                    Button {
                        model.hideSettings()
                    } label: {
                        Image(systemName: "chevron.left")
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(model.t("返回路線", "Back to routes"))
                    .accessibilityLabel(model.t("返回路線", "Back to routes"))
                }
                Text(model.t("設定", "Settings"))
                    .font(.system(size: 19, weight: .semibold))
                Spacer()
                if showsBackButton {
                    PanelCloseButton(model: model)
                }
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(spacing: 0) {
                        HStack {
                            Label(model.t("語言", "Language"), systemImage: "globe")
                            Spacer()
                            Picker(model.t("語言", "Language"), selection: $model.language) {
                                Text("繁體中文").tag(Lang.zh)
                                Text("English").tag(Lang.en)
                            }
                            .labelsHidden()
                            .frame(width: 155)
                        }
                        .padding(14)

                        Divider().padding(.horizontal, 14)

                        HStack {
                            Label(model.t("到站時間更新", "Arrival refresh"), systemImage: "arrow.clockwise")
                            Spacer()
                            Picker(model.t("到站時間更新", "Arrival refresh"), selection: $model.refreshInterval) {
                                ForEach(ArrivalRefreshInterval.allCases, id: \.self) { interval in
                                    Text(model.t("每 \(interval.rawValue) 秒", interval == .oneSecond ? "Every second" : "Every \(interval.rawValue) seconds"))
                                        .tag(interval)
                                }
                            }
                            .labelsHidden()
                            .frame(width: 155)
                        }
                        .padding(14)

                        Divider().padding(.horizontal, 14)

                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Label(model.t("靈動島（劉海顯示）", "Dynamic Island (notch)"), systemImage: "capsule.fill")
                                Spacer()
                                Toggle(model.t("靈動島", "Dynamic Island"), isOn: $model.showsNotch)
                                    .labelsHidden()
                                    .toggleStyle(.switch)
                            }
                            Text(model.t("在螢幕頂部劉海顯示下一班車，懸停預覽，點擊打開主視窗。開啟後，關閉主視窗時 app 會留在劉海。",
                                         "Shows your next arrival at the notch, with a hover preview. Click it to open the main window. While on, closing the main window keeps the app in the notch."))
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(14)

                        Divider().padding(.horizontal, 14)

                        HStack {
                            Label(model.t("登入時啟動", "Launch at login"), systemImage: "power")
                            Spacer()
                            Toggle(model.t("登入時啟動", "Launch at login"), isOn: Binding(
                                get: { model.launchAtLogin },
                                set: { model.setLaunchAtLogin($0) }
                            ))
                            .labelsHidden()
                            .toggleStyle(.switch)
                        }
                        .padding(14)
                    }
                    .font(.system(size: 13))
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: NotchDesign.Radius.row))

                    aiSection

                    if model.loginItemStatus == .requiresApproval {
                        Text(model.t("請在系統設定中允許 hktransport 登入時啟動。", "Allow hktransport in System Settings to launch at login."))
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                        Button(model.t("開啟登入項目設定", "Open Login Items Settings")) {
                            model.openLoginItemsSettings()
                        }
                    }

                    if let error = model.loginItemError {
                        Text(model.t("無法更改登入項目：", "Couldn't update login item: ") + error)
                            .font(.system(size: 12))
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Text(model.t("設定會自動儲存。", "Changes are saved automatically."))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
            .scrollIndicators(.never)

            HStack {
                Text("hktransport")
                    .fontWeight(.medium)
                Spacer()
                Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0")
                Button {
                    model.quitApplication()
                } label: {
                    Label(model.t("結束", "Quit"), systemImage: "power")
                }
                .help(model.t("結束 hktransport（⌘Q）", "Quit hktransport (⌘Q)"))
                .accessibilityLabel(model.t("結束 hktransport", "Quit hktransport"))
            }
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
        }
        .onAppear { model.refreshLoginItemStatus() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            model.refreshLoginItemStatus()
        }
    }
}

extension SettingsPanel {
    /// DeepSeek key for the trip planner. The key is kept in the keychain.
    var aiSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label(model.t("AI 路線助手（DeepSeek）", "AI trip assistant (DeepSeek)"), systemImage: "sparkles")
                Spacer()
                Text(model.hasDeepSeekKey ? model.t("已設定", "On") : model.t("未設定", "Off"))
                    .foregroundStyle(model.hasDeepSeekKey ? Color.green : .secondary)
            }
            .padding(14)

            Divider().padding(.horizontal, 14)

            HStack(spacing: 8) {
                SecureField(model.hasDeepSeekKey ? model.t("輸入新 key 以取代", "Enter a new key to replace")
                                                 : "sk-…", text: $apiKeyDraft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(saveKey)
                Button(model.t("儲存", "Save"), action: saveKey)
                    .disabled(apiKeyDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                if model.hasDeepSeekKey {
                    Button(model.t("移除", "Remove")) {
                        model.removeDeepSeekKey()
                        apiKeyStatus = model.t("已移除。", "Removed.")
                    }
                }
            }
            .padding(14)

            Divider().padding(.horizontal, 14)

            HStack {
                Text(model.t("模型", "Model"))
                Spacer()
                TextField(DeepSeekClient.defaultModel, text: $model.deepSeekModel)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 155)
            }
            .padding(14)

            Text(apiKeyStatus ?? model.t(
                "AI 只負責理解你的輸入及解釋結果；路線及時間在本機計算。只會傳送你輸入的文字、車站名稱及路線號碼，不會傳送你的位置座標。",
                "AI only reads your request and explains results; routes and times are computed on this Mac. Only your text, stop names and route numbers are sent, never your coordinates."
            ))
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding([.horizontal, .bottom], 14)
        }
        .font(.system(size: 13))
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: NotchDesign.Radius.row))
    }

    func saveKey() {
        guard !apiKeyDraft.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        apiKeyStatus = model.setDeepSeekKey(apiKeyDraft)
            ? model.t("已儲存到鑰匙圈。", "Saved to the keychain.")
            : model.t("無法儲存到鑰匙圈。", "Couldn't save to the keychain.")
        apiKeyDraft = ""
    }
}
