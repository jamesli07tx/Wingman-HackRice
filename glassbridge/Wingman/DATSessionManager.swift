// DATSessionManager.swift — DESIGN.md §5.1: ONE DAT DeviceSession carrying BOTH the camera stream and the display.
// This combination is undocumented by Meta (docs/dat-0.9.0-api-notes.md §6 "Camera + Display on ONE session")
// and is exactly what the hour-zero hardware spike (BridgeController.runSpike) verifies. Display cannot be mocked
// (Mock Device Kit has no display model) — the display path is hardware-only.
//
// INTEGRATION: DATSessionManager
// IN:  start()/stop()/capturePhoto() from BridgeController; the Meta AI registration callback URL from App.onOpenURL
// OUT: onFrame(CGImage) off-main for every frame (FrameSampler.offer), onPhoto(Data) (FrameSampler.handlePhoto),
//      onPhotoError, `display` for HudRenderer, @Published states for StatusView
// WIRE: BridgeController owns one instance; App.swift calls Wearables.configure() before it is created.

#if canImport(MWDATCore)
import Foundation
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import UIKit
import MWDATCore
import MWDATCamera
import MWDATDisplay

/// File-scope so the off-main frame path can use it without touching MainActor state.
private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

@MainActor
final class DATSessionManager: ObservableObject {
  @Published private(set) var registration: RegistrationState = .unavailable
  @Published private(set) var deviceName: String?
  @Published private(set) var sessionState: DeviceSessionState = .idle
  @Published private(set) var streamState: StreamState = .stopped
  @Published private(set) var displayState: DisplayState = .stopped
  @Published private(set) var lastError: String?
  @Published private(set) var frameCount = 0

  var onFrame: ((CGImage) -> Void)?
  var onPhoto: ((Data) -> Void)?
  var onPhotoError: ((String) -> Void)?
  private(set) var display: Display?

  private let wearables = Wearables.shared
  private let selector: AutoDeviceSelector
  private var session: DeviceSession?
  private var camera: Camera?
  private let bag = ListenerTokenBag()

  static var isHardwareAvailable: Bool {
    #if targetEnvironment(simulator)
    return false
    #else
    return true
    #endif
  }

  init() {
    // Build the selector EARLY so devicesStream has populated it before Start (api-notes §3 gotcha).
    selector = AutoDeviceSelector(wearables: wearables, filter: { $0.supportsDisplay() })
    registration = wearables.registrationState
    wearables.addRegistrationStateListener { [weak self] s in Task { @MainActor in self?.registration = s } }.store(in: bag)
    wearables.addDevicesListener { [weak self] ids in
      Task { @MainActor in self?.deviceName = ids.first.flatMap { self?.wearables.deviceForIdentifier($0)?.nameOrId() } }
    }.store(in: bag)
  }

  // MARK: registration (Meta AI round-trip, api-notes §2)

  func register() async {
    do { try await wearables.startRegistration() } catch { lastError = "Registration failed: \(error)" }
  }

  func handleUrl(_ url: URL) async {
    guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
          c.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true else { return }
    do { _ = try await wearables.handleUrl(url) } catch { lastError = "handleUrl failed: \(error)" }
  }

  // MARK: session lifecycle — attach order per api-notes §6 "Correct attach order"

  func start() async throws {
    stop()
    lastError = nil
    let s = try wearables.createSession(deviceSelector: selector)
    session = s
    Task { for await st in s.stateStream() { await MainActor.run { self.sessionState = st } } }
    Task { for await e in s.errorStream() { await MainActor.run { self.lastError = "Session error: \(e)" } } }
    try s.start()
    for await st in s.stateStream() where st == .started || st == .stopped { if st == .stopped { throw DATError.sessionStopped }; break }

    // Camera permission is the only DAT permission (api-notes §3); it bounces through the Meta AI app.
    if try await wearables.checkPermissionStatus(.camera) != .granted {
      guard try await wearables.requestPermission(.camera) == .granted else { throw DATError.cameraDenied }
    }

    // Camera: raw frames (no HEVC decoding on our side), highest resolution, lowest legal fps — we sample every ~1.75 s anyway.
    let config = StreamConfiguration(videoCodec: .raw, resolution: .high, frameRate: 2)
    guard let cam = try s.addCamera(config: config) else { throw DATError.cameraUnavailable }
    camera = cam
    let stream = cam.stream
    stream.statePublisher.listen { [weak self] st in Task { @MainActor in self?.streamState = st } }.store(in: bag)
    stream.videoFramePublisher.listen { [weak self] frame in
      guard let self, let img = Self.cgImage(from: frame) else { return }
      Task { @MainActor in self.frameCount += 1 }
      self.onFrame?(img)                                   // off-main by design: never block the DAT thread
    }.store(in: bag)
    stream.photoDataPublisher.listen { [weak self] photo in self?.onPhoto?(photo.data) }.store(in: bag)
    stream.errorPublisher.listen { [weak self] e in
      Task { @MainActor in
        self?.lastError = "Stream error: \(e)"
        if case .photoCaptureFailed = e { self?.onPhotoError?("capture_failed") }
      }
    }.store(in: bag)
    stream.start()

    // Display on the SAME session — the spike question.
    let d = try s.addDisplay()
    display = d
    d.statePublisher.listen { [weak self] st in Task { @MainActor in self?.displayState = st } }.store(in: bag)
    d.start()
  }

  func stop() {
    display?.onPlaybackEvent = nil
    display?.stop(); display = nil
    camera?.stop(); camera = nil
    session?.stop(); session = nil
    bag.clear()
    // Re-subscribe the two Wearables-level listeners cleared with the bag.
    wearables.addRegistrationStateListener { [weak self] s in Task { @MainActor in self?.registration = s } }.store(in: bag)
    wearables.addDevicesListener { [weak self] ids in
      Task { @MainActor in self?.deviceName = ids.first.flatMap { self?.wearables.deviceForIdentifier($0)?.nameOrId() } }
    }.store(in: bag)
  }

  /// Fire-and-forget; the JPEG arrives on onPhoto, failure on onPhotoError (api-notes §5).
  func capturePhoto() -> Bool {
    guard let cam = camera, streamState == .streaming else { return false }
    return cam.stream.capturePhoto(format: .jpeg)
  }

  // MARK: frame conversion (off-main)

  nonisolated private static func cgImage(from frame: VideoFrame) -> CGImage? {
    if let pb = CMSampleBufferGetImageBuffer(frame.sampleBuffer) {
      let ci = CIImage(cvPixelBuffer: pb)
      return ciContext.createCGImage(ci, from: ci.extent)
    }
    return frame.makeUIImage()?.cgImage       // fallback if the buffer is not a pixel buffer
  }
}

enum DATError: Error, LocalizedError {
  case sessionStopped, cameraDenied, cameraUnavailable
  var errorDescription: String? {
    switch self {
    case .sessionStopped: return "DAT session stopped before it started (glasses off / hinges closed / Developer Mode off?)"
    case .cameraDenied: return "Camera permission denied in the Meta AI app"
    case .cameraUnavailable: return "addCamera returned nil — session not .started"
    }
  }
}
#endif
