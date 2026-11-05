import AppKit
import AVFoundation
import Speech

enum SpeechLanguage: String, CaseIterable, Sendable {
    case cantonese, mandarin, english

    var localeID: String {
        switch self {
        case .cantonese: return "zh-HK"
        case .mandarin: return "zh-CN"
        case .english: return "en-US"
        }
    }

    static func defaultChoice(for language: Lang) -> SpeechLanguage {
        language == .zh ? .cantonese : .english
    }
}

/// Dictation for the AI box: listens until the rider stops talking, then hands
/// over the text. Audio is never stored; recognition stays on this Mac when the
/// language's on-device model is installed, and otherwise goes to Apple.
@MainActor
final class SpeechInputModel: ObservableObject {
    enum Issue: Equatable { case denied, unavailable, noMicrophone, noSpeech }

    private static let pauseAfterSpeech: Duration = .seconds(2)
    private static let waitForFirstWord: Duration = .seconds(8)
    private static let waitForFinalResult: Duration = .seconds(2)

    @Published private(set) var isListening = false
    @Published private(set) var transcript = ""
    @Published private(set) var issue: Issue?

    private var recognizer: SFSpeechRecognizer?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var timer: Task<Void, Never>?
    private var isPreparing = false
    private var onFinish: ((String) -> Void)?

    /// Starts listening, or finishes early when already listening.
    func toggle(language: SpeechLanguage, onFinish: @escaping (String) -> Void) {
        if isListening {
            stop()
        } else if !isPreparing {
            isPreparing = true
            issue = nil
            Task {
                defer { isPreparing = false }
                // Permission prompts need an active app; this one has no Dock icon.
                NSApp.activate(ignoringOtherApps: true)
                guard await Self.isAuthorized() else {
                    issue = .denied
                    return
                }
                begin(language: language, onFinish: onFinish)
            }
        }
    }

    /// Drops whatever was heard without sending it.
    func cancel() {
        onFinish = nil
        tearDown()
    }

    func openSettings() {
        let page = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        if let url = URL(string: page) { NSWorkspace.shared.open(url) }
    }

    private static func isAuthorized() async -> Bool {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        guard speech else { return false }
        return await AVCaptureDevice.requestAccess(for: .audio)
    }

    private func begin(language: SpeechLanguage, onFinish: @escaping (String) -> Void) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language.localeID)),
              recognizer.isAvailable else {
            issue = .unavailable
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .search
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition

        let engine = AVAudioEngine()
        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            issue = .noMicrophone
            return
        }
        Self.installTap(on: engine, format: format, feeding: request)
        engine.prepare()
        do {
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            issue = .noMicrophone
            return
        }

        self.recognizer = recognizer
        self.engine = engine
        self.request = request
        self.onFinish = onFinish
        transcript = ""
        isListening = true
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isDone = error != nil || result?.isFinal == true
            Task { @MainActor [weak self] in self?.received(text, isDone: isDone) }
        }
        finish(after: Self.waitForFirstWord)
    }

    /// Runs on the audio thread, so it must stay outside the main actor.
    private nonisolated static func installTap(on engine: AVAudioEngine, format: AVAudioFormat,
                                               feeding request: SFSpeechAudioBufferRecognitionRequest) {
        engine.inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            request.append(buffer)
        }
    }

    private func received(_ text: String?, isDone: Bool) {
        guard isListening else { return }
        if let text, !text.isEmpty, text != transcript {
            transcript = text
            finish(after: Self.pauseAfterSpeech)
        }
        if isDone { complete() }
    }

    private func finish(after delay: Duration) {
        timer?.cancel()
        timer = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            self?.stop()
        }
    }

    /// Stops the microphone and gives the recogniser a moment for its final text.
    private func stop() {
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine = nil
        request?.endAudio()
        timer?.cancel()
        timer = Task { [weak self] in
            do { try await Task.sleep(for: Self.waitForFinalResult) } catch { return }
            self?.complete()
        }
    }

    private func complete() {
        guard isListening else { return }
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let handler = onFinish
        onFinish = nil
        tearDown()
        if text.isEmpty {
            issue = .noSpeech
        } else {
            handler?(text)
        }
    }

    private func tearDown() {
        timer?.cancel()
        timer = nil
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine = nil
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        recognizer = nil
        isListening = false
    }
}
