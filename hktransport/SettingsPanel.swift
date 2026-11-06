import AppKit
import ServiceManagement
import SwiftUI

struct SettingsPanel: View {
    @ObservedObject var model: AppModel
    var showsBackButton = true

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
                            Picker(model.t("語言", "Language"), selection: Binding(
                                get: { model.languageChoice },
                                set: { model.languageChoice = $0 }
                            )) {
                                Text("繁體中文").tag("hant")
                                Text("简体中文").tag("hans")
                                Text("English").tag("en")
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
