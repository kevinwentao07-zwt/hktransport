import MapKit
import SwiftUI

/// "Plan trip" page: one natural-language box, then ranked options with
/// live departures beside a map that draws the option being viewed.
struct RoutePlanPanel: View {
    @ObservedObject var model: AppModel
    @ObservedObject var planner: RoutePlannerModel
    @ObservedObject var location: BusLocationModel
    @ObservedObject private var navigation = NavigationTracker.shared
    @StateObject private var speech = SpeechInputModel()
    @AppStorage("hktransport.speechLanguage") private var speechChoice = ""
    @FocusState private var focus: Field?
    @State private var expanded: String?

    private enum Field { case origin, destination, chat }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            searchBar
            placeHistory
            statusRow
            if let origin = planner.origin, let destination = planner.destination {
                HStack(spacing: 6) {
                    Text(origin.name).lineLimit(1)
                    Image(systemName: "arrow.right").foregroundStyle(.secondary)
                    Text(destination.name).lineLimit(1)
                    Spacer()
                    preferencePicker
                }
                .font(.system(size: 12, weight: .medium))
            }
            HStack(alignment: .top, spacing: 12) {
                ScrollView {
                    LazyVStack(spacing: 6) {
                        if let suggestions = planner.visibleSuggestions {
                            suggestionList(suggestions)
                        } else if planner.journeys.isEmpty && planner.phase == .idle {
                            intro
                        }
                        if case .choosing = planner.discovery, planner.visibleSuggestions == nil {
                            Button {
                                expanded = nil
                                planner.backToSuggestions()
                            } label: {
                                Label(model.t("返回推薦地點", "Back to recommendations"), systemImage: "chevron.left")
                                    .font(.system(size: 12))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                        }
                        ForEach(planner.journeys) { journey in
                            JourneyCard(model: model, journey: journey, isExpanded: expanded == journey.id,
                                        isNavigating: navigation.journeyID == journey.id,
                                        toggleNavigation: { toggleNavigation(journey) }) {
                                expanded = expanded == journey.id ? nil : journey.id
                            }
                        }
                    }
                }
                .scrollIndicators(.never)
                .frame(width: 400)
                .frame(maxHeight: .infinity)

                JourneyMap(model: model, navigation: navigation, location: location, origin: planner.origin,
                           destination: planner.destination, path: navigation.path ?? selectedPath,
                           suggestions: planner.visibleSuggestions ?? [])
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            aiReply
            areaQuestion
            chatBar
        }
        .onAppear {
            // The search bar starts from here, so ask for a position straight away.
            location.requestOnce()
            if expanded == nil { expanded = navigation.journeyID }
            if let db = model.db { planner.prepare(db: db) }
        }
        .onDisappear {
            location.pause()
            speech.cancel()
        }
        .onChange(of: planner.journeys) {
            // A new search or a cleared page ends the trip being followed.
            if let id = navigation.journeyID, !planner.journeys.contains(where: { $0.id == id }) {
                navigation.stop()
            }
        }
        .onChange(of: speech.transcript) {
            if speech.isListening { planner.chatText = speech.transcript }
        }
        .task {
            // The panel becomes key on the expanding click; focus once it is mounted.
            try? await Task.sleep(for: .milliseconds(60))
            focus = .destination
        }
    }

    /// Live re-timing replaces journeys but keeps their ids, so the map stays put.
    private var selectedPath: JourneyMapPath? {
        planner.journeys.first { $0.id == expanded }.flatMap(path)
    }

    private func path(for journey: Journey) -> JourneyMapPath? {
        guard let db = model.db, let origin = planner.origin, let destination = planner.destination else { return nil }
        return JourneyMapPath(journey: journey, origin: origin.location, destination: destination.location, db: db)
    }

    private func toggleNavigation(_ journey: Journey) {
        if navigation.journeyID == journey.id {
            navigation.stop()
        } else if let path = path(for: journey) {
            navigation.start(journeyID: journey.id, path: path)
        }
    }

    // MARK: Search bar

    /// Past places for whichever box has the cursor.
    @ViewBuilder
    private var placeHistory: some View {
        if focus == .origin {
            SearchHistoryBar(model: model, box: SearchHistory.Box.origin) { text in
                planner.originText = text
                search()
            }
        } else if focus == .destination {
            SearchHistoryBar(model: model, box: SearchHistory.Box.destination) { text in
                planner.destinationText = text
                search()
            }
        }
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            placeField(icon: "circle.fill", tint: .green, text: $planner.originText, field: .origin,
                       prompt: originPrompt) {
                Button {
                    planner.originText = ""
                    location.locate()
                } label: {
                    Image(systemName: location.location == nil ? "location" : "location.fill")
                        .foregroundStyle(planner.originText.isEmpty ? Color.blue : .secondary)
                }
                .buttonStyle(.plain)
                .disabled(location.isLocating)
                .help(model.t("由我的位置出發", "Start from my location"))
            }
            Button {
                planner.swapEnds(language: model.language)
            } label: {
                Image(systemName: "arrow.left.arrow.right").frame(width: 24, height: 28)
            }
            .buttonStyle(.plain)
            .help(model.t("對調起點及目的地", "Swap start and destination"))
            placeField(icon: "flag.fill", tint: .red, text: $planner.destinationText, field: .destination,
                       prompt: model.t("要去哪裡？", "Where to?")) {
                if !planner.destinationText.isEmpty {
                    Button {
                        planner.reset()
                        expanded = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(model.t("清除", "Clear"))
                }
            }
            Button(model.t("搜尋", "Search"), action: search)
                .disabled(!canSearch)
        }
    }

    private var originPrompt: String {
        if location.issue != nil { return model.t("未能定位，請輸入起點", "No location, type a start") }
        return location.location == nil ? model.t("我的位置（定位中…）", "My location (locating…)")
                                        : model.t("我的位置", "My location")
    }

    private func placeField<Accessory: View>(icon: String, tint: Color, text: Binding<String>, field: Field, prompt: String,
                                             @ViewBuilder accessory: () -> Accessory) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: field == .origin ? 9 : 12))
                .foregroundStyle(tint)
                .frame(width: 16)
            TextField(prompt, text: text)
                .textFieldStyle(.plain)
                .font(.system(size: 14, weight: .medium))
                .focused($focus, equals: field)
                .onSubmit(search)
            accessory()
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: NotchDesign.Radius.row, style: .continuous))
    }

    // MARK: AI box

    /// "Where should I look?" with one button per area.
    @ViewBuilder
    private var areaQuestion: some View {
        if case .asking(let request) = planner.discovery {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label(model.t("想找\(request.want)，要在哪裡找？", "Where should I look for \(request.want)?"),
                          systemImage: "sparkles")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.yellow)
                    Spacer()
                    Button {
                        planner.cancelDiscovery()
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(model.t("取消", "Cancel"))
                }
                HStack(spacing: 6) {
                    ForEach(request.areaChoices, id: \.self) { area in
                        Button(area == DiscoveryRequest.nearby ? model.t("附近（本區）", "Nearby (this district)") : area) { chooseArea(area) }
                            .disabled(planner.isBusy)
                    }
                    Spacer(minLength: 0)
                }
                Text(model.t("或在下方輸入更精確的範圍，例如：朗豪坊附近、要平啲",
                             "Or type a more exact area below, e.g. near Langham Place"))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func suggestionList(_ suggestions: [PlaceSuggestion]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if case .choosing(let request, let area, _) = planner.discovery {
                HStack {
                    Text(model.t("\(area)的\(request.want)：選一個地點", "\(request.want) around \(area): pick one"))
                        .font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Button(model.t("換範圍", "Change area")) { planner.askAreaAgain() }
                        .buttonStyle(.link)
                        .font(.system(size: 11))
                }
                Text(suggestions.first?.isNamedByAI == true
                     ? model.t("由 AI 推薦，並已在 Apple 地圖核實地點。AI 的資料可能過時，出發前請確認仍在營業。",
                               "Recommended by AI and found on Apple Maps. AI knowledge can be out of date, so check before you go.")
                     : model.t("地點來自 Apple 地圖，沒有菜單資料，未必有售，出發前請先確認。",
                               "Places come from Apple Maps, which has no menus. Check before you go."))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(suggestions.enumerated()), id: \.element.id) { index, suggestion in
                Button {
                    choose(suggestion)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Text("\(index + 1)")
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .frame(width: 22, height: 22)
                            .background(Color.orange, in: Circle())
                            .foregroundStyle(.white)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(suggestion.place.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                                Spacer()
                                Text(distance(suggestion.place)).font(.system(size: 11)).foregroundStyle(.secondary)
                            }
                            if !suggestion.place.address.isEmpty {
                                Text(suggestion.place.address).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                            }
                            if let reason = suggestion.reason {
                                Text(reason)
                                    .font(.system(size: 12))
                                    .foregroundStyle(.yellow)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: NotchDesign.Radius.row, style: .continuous))
            }
        }
    }

    private func distance(_ place: PlaceCandidate) -> String {
        place.meters < 1_000 ? "\(Int(place.meters)) m" : String(format: "%.1f km", place.meters / 1_000)
    }

    @ViewBuilder
    private var aiReply: some View {
        if planner.lastChat != nil || planner.explanation != nil || planner.isExplaining {
            VStack(alignment: .leading, spacing: 3) {
                if let message = planner.lastChat {
                    Text(message).foregroundStyle(.secondary).lineLimit(1)
                }
                if let explanation = planner.explanation {
                    Label(explanation, systemImage: "sparkles")
                        .foregroundStyle(.yellow)
                        .fixedSize(horizontal: false, vertical: true)
                } else if planner.isExplaining {
                    Label(model.t("AI 整理建議中…", "AI is summarising…"), systemImage: "sparkles")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.system(size: 12))
        }
    }

    private var chatBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            if focus == .chat {
                SearchHistoryBar(model: model, box: SearchHistory.Box.chat) { text in
                    planner.chatText = text
                    sendChat()
                }
            }
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .foregroundStyle(model.hasDeepSeekKey ? Color.yellow : .secondary)
                TextField(chatPrompt, text: $planner.chatText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused($focus, equals: .chat)
                    .disabled(speech.isListening)
                    .onSubmit(sendChat)
                speechLanguageMenu
                Button(action: toggleSpeech) {
                    Image(systemName: speech.isListening ? "stop.circle.fill" : "mic.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(speech.isListening ? Color.red : .primary)
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .disabled(model.db == nil)
                .accessibilityLabel(speech.isListening ? model.t("停止語音輸入", "Stop voice input")
                                                       : model.t("語音輸入", "Voice input"))
                .help(model.t("語音輸入，說完後自動送出", "Voice input; sends when you stop talking"))
                Button(action: sendChat) {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 20))
                }
                .buttonStyle(.plain)
                .disabled(!canChat)
                .accessibilityLabel(model.t("傳送", "Send"))
            }
            .padding(.horizontal, 12)
            .frame(height: 38)
            .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: NotchDesign.Radius.row, style: .continuous))
            if let notice = speechNotice {
                HStack(spacing: 6) {
                    Text(notice)
                    if speech.issue == .denied {
                        Button(model.t("開啟設定", "Open Settings"), action: speech.openSettings)
                            .buttonStyle(.link)
                    }
                }
                .font(.system(size: 11))
                .foregroundStyle(.orange)
            } else if !model.hasDeepSeekKey {
                Text(model.t("未連接 AI：現時使用基本解析。在設定加入 DeepSeek API key 後，搜尋及對話都會由 AI 分析。",
                             "AI not connected: using basic parsing. Add a DeepSeek API key in Settings to have AI analyse search and chat."))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var chatPrompt: String {
        if speech.isListening { return model.t("正在聆聽…", "Listening…") }
        if case .asking = planner.discovery {
            return model.t("輸入更精確的範圍，例如：朗豪坊附近", "Type a more exact area, e.g. near Langham Place")
        }
        return model.t("告訴 AI，例如：我想吃螺螄粉、去機場不想轉車", "Ask AI, e.g. I want rice noodles, or airport with no transfers")
    }

    private var speechLanguage: SpeechLanguage {
        SpeechLanguage(rawValue: speechChoice) ?? .defaultChoice(for: model.language)
    }

    private var speechLanguageMenu: some View {
        Menu {
            ForEach(SpeechLanguage.allCases, id: \.self) { language in
                Button {
                    speechChoice = language.rawValue
                } label: {
                    if language == speechLanguage {
                        Label(label(language), systemImage: "checkmark")
                    } else {
                        Text(label(language))
                    }
                }
            }
        } label: {
            Text(label(speechLanguage)).font(.system(size: 11))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(speech.isListening)
        .help(model.t("語音輸入的語言", "Voice input language"))
    }

    private func label(_ language: SpeechLanguage) -> String {
        switch language {
        case .cantonese: return model.t("粵語", "Cantonese")
        case .mandarin: return model.t("普通話", "Mandarin")
        case .english: return "English"
        }
    }

    private var speechNotice: String? {
        switch speech.issue {
        case .denied:
            return model.t("語音輸入需要麥克風及語音辨識權限。", "Voice input needs Microphone and Speech Recognition access.")
        case .unavailable:
            return model.t("此語言的語音辨識暫時無法使用，請換一種語言或改用打字。",
                           "Speech recognition for this language isn't available right now. Try another language or type instead.")
        case .noMicrophone:
            return model.t("找不到可用的麥克風。", "No microphone is available.")
        case .noSpeech:
            return model.t("聽不到內容，請再試一次。", "Didn't catch that. Please try again.")
        case nil:
            return nil
        }
    }

    private func toggleSpeech() {
        speech.toggle(language: speechLanguage) { text in
            planner.chatText = text
            sendChat()
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        if model.db == nil {
            status(model.t("正在載入路線資料…", "Loading route data…"), busy: true)
        } else {
            switch planner.phase {
            case .idle, .done:
                EmptyView()
            case .understanding:
                status(model.hasDeepSeekKey ? model.t("AI 正在分析你的要求…", "AI is analysing your request…")
                                            : model.t("理解要求…", "Reading your request…"), busy: true)
            case .locating:
                status(model.t("正在尋找起點及目的地…", "Finding places…"), busy: true)
            case .findingPlaces:
                status(model.t("AI 正在搜尋，並在地圖上核實地點…", "AI is searching and checking places on the map…"), busy: true)
            case .planning:
                status(model.t("正在計算路線…", "Planning routes…"), busy: true)
            case .checkingLive:
                status(model.t("正在核對實時到站時間…", "Checking live arrivals…"), busy: true)
            case .failed(let message):
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 12))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        if let notice = planner.aiNotice {
            Text(notice)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func status(_ text: String, busy: Bool) -> some View {
        HStack(spacing: 8) {
            if busy { ProgressView().controlSize(.small) }
            Text(text).font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }

    private var preferencePicker: some View {
        Picker(model.t("偏好", "Preference"), selection: Binding(
            get: { planner.preference },
            set: { planner.setPreference($0) }
        )) {
            Text(model.t("最快", "Fastest")).tag(TripPreference.fastest)
            Text(model.t("少轉車", "Fewer changes")).tag(TripPreference.fewerTransfers)
            Text(model.t("少行路", "Less walking")).tag(TripPreference.lessWalking)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 230)
    }

    private var intro: some View {
        Text(model.t(
            "在上方輸入目的地；起點留空時由你目前的位置出發。也可以在下方用文字或語音告訴 AI。路線在本機計算，每程車都會盡量使用實時到站時間。",
            "Type a destination above; with no start, your current location is used. You can also tell the AI below by text or voice. Routes are computed on this Mac and use live arrivals wherever possible."
        ))
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
    }

    private var canSearch: Bool {
        !planner.destinationText.trimmingCharacters(in: .whitespaces).isEmpty && model.db != nil && !planner.isBusy
    }

    private var canChat: Bool {
        !planner.chatText.trimmingCharacters(in: .whitespaces).isEmpty && model.db != nil
            && !planner.isBusy && !speech.isListening
    }

    private func search() {
        guard let db = model.db, canSearch else { return }
        expanded = nil
        if let origin = TripIntentParser.normalizedOrigin(planner.originText) {
            SearchHistory.shared.add(origin, to: SearchHistory.Box.origin)
        }
        if !TripIntentParser.isCurrentLocation(planner.destinationText) {
            SearchHistory.shared.add(planner.destinationText, to: SearchHistory.Box.destination)
        }
        let location = location
        planner.search(db: db, language: model.language, currentLocation: { await location.currentFix() },
                       ai: model.deepSeekClient())
    }

    private func chooseArea(_ area: String) {
        guard let db = model.db else { return }
        let location = location
        planner.chooseArea(area, db: db, language: model.language, currentLocation: { await location.currentFix() },
                           ai: model.deepSeekClient())
    }

    private func choose(_ suggestion: PlaceSuggestion) {
        guard let db = model.db else { return }
        expanded = nil
        let location = location
        planner.choosePlace(suggestion, db: db, language: model.language,
                            currentLocation: { await location.currentFix() }, ai: model.deepSeekClient())
    }

    private func sendChat() {
        guard let db = model.db, !planner.isBusy, !planner.chatText.isEmpty else { return }
        expanded = nil
        SearchHistory.shared.add(planner.chatText, to: SearchHistory.Box.chat)
        let location = location
        planner.sendChat(db: db, language: model.language, currentLocation: { await location.currentFix() },
                         ai: model.deepSeekClient())
    }
}

/// Always on the page: Hong Kong at first, both ends once planned, and the
/// whole trip once an option is opened.
private struct JourneyMap: View {
    @ObservedObject var model: AppModel
    @ObservedObject var navigation: NavigationTracker
    @ObservedObject var location: BusLocationModel
    let origin: ResolvedPlace?
    let destination: ResolvedPlace?
    let path: JourneyMapPath?
    let suggestions: [PlaceSuggestion]

    private static let hongKong = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 22.3400, longitude: 114.1500),
        span: MKCoordinateSpan(latitudeDelta: 0.42, longitudeDelta: 0.52)
    )

    @State private var position: MapCameraPosition = .region(JourneyMap.hongKong)

    private struct RideStop: Identifiable {
        let id: String
        let name: String
        let location: StopLocation
        let color: Color
    }

    private struct Boarding: Identifiable {
        let id: Int
        let route: String
        let op: Operator
        let location: StopLocation
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            map
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .top) {
                    if navigation.journeyID != nil { navigationBanner }
                }
            Text(caption)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
        .onAppear { fit(animated: false) }
        .onChange(of: fitPoints) { fit(animated: true) }
        .onChange(of: navigation.fix) { fit(animated: true) }
    }

    private var navigationBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: navigation.progress?.hasArrived == true ? "checkmark.circle.fill" : "location.north.line.fill")
                .foregroundStyle(navigation.progress?.isOffRoute == true ? Color.orange : .blue)
            Text(navigationText)
                .font(.system(size: 13, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(navigation.progress?.hasArrived == true ? model.t("完成", "Done") : model.t("結束", "End"),
                   action: navigation.stop)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(8)
    }

    private var navigationText: String {
        if location.issue == .denied {
            return model.t("導航需要定位權限，請在系統設定開啟。", "Navigation needs Location access. Turn it on in System Settings.")
        }
        guard let path = navigation.path, let progress = navigation.progress else {
            return location.issue == nil ? model.t("正在取得你的位置…", "Finding your location…")
                                         : model.t("暫時未能定位，稍後會再試。", "Can't find you right now. Still trying.")
        }
        return path.instruction(for: progress, language: model.language) {
            RoutePlannerModel.stopName($0, db: model.db, language: model.language)
        }
    }

    private var map: some View {
        Map(position: $position, interactionModes: .all) {
            if let fix = navigation.fix {
                Annotation(model.t("我的位置", "My location"), coordinate: fix.coordinate) {
                    Circle().fill(.blue)
                        .frame(width: 16, height: 16)
                        .overlay(Circle().stroke(.white, lineWidth: 3))
                        .shadow(radius: 3)
                }
                .annotationTitles(.hidden)
            }
            ForEach(path?.segments ?? []) { segment in
                // A white casing keeps every line readable on light and dark maps.
                MapPolyline(coordinates: segment.points.map(\.coordinate))
                    .stroke(.white, style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: segment.points.map(\.coordinate))
                    .stroke(color(segment.mode), style: stroke(segment.mode))
            }
            ForEach(rideStops) { stop in
                // MapKit hides names that would collide and brings them back on zooming in.
                Annotation(stop.name, coordinate: stop.location.coordinate, anchor: .center) {
                    Circle().fill(.white)
                        .frame(width: 7, height: 7)
                        .overlay(Circle().stroke(stop.color, lineWidth: 2))
                }
                .annotationTitles(.automatic)
            }
            ForEach(boardings) { boarding in
                let name = boarding.op.lineName(boarding.route).text(model.language)
                Annotation(name, coordinate: boarding.location.coordinate, anchor: .bottom) {
                    Text(name)
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .lineLimit(1)
                        .padding(.horizontal, 5)
                        .frame(minHeight: 18)
                        .foregroundStyle(boarding.op == .ctb ? Color.black : Color.white)
                        .background(boarding.op.lineColor(boarding.route), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(.white, lineWidth: 1))
                }
                .annotationTitles(.hidden)
            }
            ForEach(Array(suggestions.enumerated()), id: \.element.id) { index, suggestion in
                Marker(suggestion.place.name, monogram: Text("\(index + 1)"), coordinate: suggestion.place.location.coordinate)
                    .tint(.orange)
            }
            if let origin {
                Marker(origin.name, systemImage: "figure.walk", coordinate: origin.location.coordinate)
                    .tint(.green)
            }
            if let destination {
                Marker(destination.name, systemImage: "flag.fill", coordinate: destination.location.coordinate)
                    .tint(.red)
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .mapControls { MapCompass(); MapScaleView(); MapZoomStepper() }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel(model.t("路線規劃 Apple 地圖", "Apple Map of the planned trip"))
    }

    private var caption: String {
        if !suggestions.isEmpty { return model.t("地圖上的數字對應左方的地點", "Numbers on the map match the list") }
        return path == nil
            ? model.t("點開路線方案，即可在地圖查看全程", "Open an option to see the whole trip on the map")
            : model.t("路線按站點連線顯示，並非實際行車路徑 · 虛線為步行",
                      "Lines join the stops and don't follow the exact road · Dotted lines are walks")
    }

    private var fitPoints: [StopLocation] {
        if !suggestions.isEmpty { return suggestions.map(\.place.location) }
        return path?.allPoints ?? [origin?.location, destination?.location].compactMap { $0 }
    }

    private func fit(animated: Bool) {
        var region = MKCoordinateRegion(fitting: fitPoints) ?? Self.hongKong
        if let fix = navigation.fix {
            region = MKCoordinateRegion(center: fix.coordinate,
                                        span: MKCoordinateSpan(latitudeDelta: 0.014, longitudeDelta: 0.014))
        }
        if animated {
            withAnimation(.easeInOut(duration: 0.35)) { position = .region(region) }
        } else {
            position = .region(region)
        }
    }

    private func color(_ mode: JourneyMapPath.Mode) -> Color {
        if case .ride(let route, let op) = mode { return op.lineColor(route) }
        return .blue
    }

    private func stroke(_ mode: JourneyMapPath.Mode) -> StrokeStyle {
        mode == .walk
            ? StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round, dash: [0.1, 8])
            : StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round)
    }

    private var rideStops: [RideStop] {
        (path?.segments ?? []).flatMap { segment -> [RideStop] in
            guard segment.mode != .walk else { return [] }
            return zip(segment.stopIDs, segment.points).enumerated().map { index, stop in
                RideStop(id: "\(segment.id)-\(index)",
                         name: RoutePlannerModel.stopName(stop.0, db: model.db, language: model.language),
                         location: stop.1, color: color(segment.mode))
            }
        }
    }

    private var boardings: [Boarding] {
        (path?.segments ?? []).compactMap { segment -> Boarding? in
            guard case .ride(let route, let op) = segment.mode, let first = segment.points.first else { return nil }
            return Boarding(id: segment.id, route: route, op: op, location: first)
        }
    }
}

private extension StopLocation {
    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

private struct JourneyCard: View {
    @ObservedObject var model: AppModel
    let journey: Journey
    let isExpanded: Bool
    let isNavigating: Bool
    let toggleNavigation: () -> Void
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: toggle) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(Int(journey.totalMinutes.rounded()))")
                            .font(.system(size: 22, weight: .bold, design: .rounded))
                        Text(model.t("分鐘", "min")).font(.system(size: 12)).foregroundStyle(.secondary)
                        Text(model.t("到達 ", "Arrive ") + journey.arrival.formatted(date: .omitted, time: .shortened))
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                        Spacer()
                        if journey.liveRideCount > 0 {
                            Label(model.t("實時", "Live"), systemImage: "dot.radiowaves.left.and.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.green)
                        }
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    legChips
                    Text(details)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Divider()
                ForEach(Array(journey.legs.enumerated()), id: \.offset) { _, leg in
                    legDetail(leg)
                }
                Button(action: toggleNavigation) {
                    Label(isNavigating ? model.t("結束導航", "End navigation") : model.t("開始導航", "Start navigation"),
                          systemImage: isNavigating ? "stop.fill" : "location.north.line.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(isNavigating ? Color.red : .blue)
            }
        }
        .padding(12)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: NotchDesign.Radius.row, style: .continuous))
    }

    private var details: String {
        let transfers = journey.transfers == 0 ? model.t("直達", "Direct")
            : model.t("轉 \(journey.transfers) 次", "\(journey.transfers) change\(journey.transfers == 1 ? "" : "s")")
        return "\(transfers) · " + model.t("步行 \(Int(journey.walkingMeters)) 米", "walk \(Int(journey.walkingMeters)) m")
    }

    private var legChips: some View {
        HStack(spacing: 4) {
            ForEach(Array(visibleLegs.enumerated()), id: \.offset) { index, leg in
                if index > 0 {
                    Image(systemName: "chevron.right").font(.system(size: 9)).foregroundStyle(.secondary)
                }
                switch leg {
                case .walk(_, let minutes, _):
                    Label("\(max(1, Int(minutes.rounded())))", systemImage: "figure.walk")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                case .ride(let ride):
                    Text(ride.op.lineName(ride.route).text(model.language))
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 34, minHeight: 20)
                        .foregroundStyle(ride.op == .ctb ? Color.black : Color.white)
                        .background(ride.op.lineColor(ride.route).opacity(0.9), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                }
            }
            Spacer(minLength: 0)
        }
    }

    /// Hides walks that round to zero minutes in the summary row.
    private var visibleLegs: [JourneyLeg] {
        journey.legs.filter { leg in
            if case .walk(_, let minutes, _) = leg { return minutes >= 0.5 }
            return true
        }
    }

    @ViewBuilder
    private func legDetail(_ leg: JourneyLeg) -> some View {
        switch leg {
        case .walk(let meters, let minutes, let to):
            HStack(spacing: 8) {
                Image(systemName: "figure.walk").frame(width: 20)
                Text(model.t("步行約 \(max(1, Int(minutes.rounded()))) 分鐘（\(Int(meters)) 米）到 ",
                             "Walk about \(max(1, Int(minutes.rounded()))) min (\(Int(meters)) m) to ")
                     + (to.map { name($0) } ?? model.t("目的地", "destination")))
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
        case .ride(let ride):
            HStack(alignment: .top, spacing: 8) {
                Text(ride.op.lineName(ride.route).text(model.language))
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, 5)
                    .frame(minWidth: 40, minHeight: 20)
                    .foregroundStyle(ride.op == .ctb ? Color.black : Color.white)
                    .background(ride.op.lineColor(ride.route).opacity(0.9), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.t("\(name(ride.boardStopID)) 上車 · 往 \(ride.dest.zh)",
                                 "Board at \(name(ride.boardStopID)) · to \(ride.dest.en)"))
                        .font(.system(size: 12, weight: .medium))
                    Text(departureText(ride))
                        .font(.system(size: 11))
                        .foregroundStyle(ride.liveDeparture == nil ? Color.secondary : Color.green)
                    Text(model.t("\(name(ride.alightStopID)) 落車 · \(ride.stopCount) 個站 · 約 \(Int(ride.rideMinutes.rounded())) 分鐘",
                                 "Alight at \(name(ride.alightStopID)) · \(ride.stopCount) stops · about \(Int(ride.rideMinutes.rounded())) min"))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func departureText(_ ride: PlannedRide) -> String {
        let wait = Int(ride.waitMinutes.rounded())
        guard let live = ride.liveDeparture else {
            return model.t("估算：等候約 \(wait) 分鐘（暫無實時資料）", "Estimate: about \(wait) min wait (no live data)")
        }
        let time = live.formatted(date: .omitted, time: .shortened)
        let platform = ride.livePlatform.map { " · " + $0.text(model.language) } ?? ""
        return ride.isProjected
            ? model.t("實時推算：約 \(time) 開出（等候約 \(wait) 分鐘）", "Projected from live: about \(time) (about \(wait) min wait)") + platform
            : model.t("實時：\(time) 開出（等候約 \(wait) 分鐘）", "Live: departs \(time) (about \(wait) min wait)") + platform
    }

    private func name(_ id: String) -> String {
        RoutePlannerModel.stopName(id, db: model.db, language: model.language)
    }
}
