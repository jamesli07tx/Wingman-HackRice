// DATSessionManager.swift — DESIGN.md §5.1: ONE DAT DeviceSession carrying BOTH the camera stream and the display.
// This combination is undocumented by Meta (docs/dat-0.9.0-api-notes.md §6 "Camera + Display on ONE session")
// and is exactly what the hour-zero hardware spike (BridgeController.runSpike) verifies. Display cannot be mocked
// (Mock Device Kit has no display model) — the display path is hardware-only.
//
// INTEGRATION: DATSessionManager
// IN:  start()/stop()/capturePhoto() from BridgeController; the Meta AI registration callback URL from App.onOpenURL
// OUT: onFrame(CGImage) off-main for every frame (FrameSampler.offer), onPhoto(Data) (FrameSampler.handlePhoto),
//      onPhotoError, `display` for HudRenderer, @Published states for StatusView
// WIRE: BridgeController owns one OPTIONAL instance (nil unless DATSessionManager.configure() succeeded);
//       App.swift calls DATSessionManager.configure() before BridgeController is created.

#if canImport(MWDATCore)
import Foundation
import Combine
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

  // The three callbacks are invoked OFF the main actor, straight from the DAT listener thread, so they are
  // `@Sendable` and are snapshotted into locals at start() time — the listener closures never touch `self`.
  // CONSEQUENCE: assign them BEFORE calling start(); assignments made after start() are not picked up until
  // the next start(). (BridgeController assigns them in its init, so this is satisfied.)
  var onFrame: (@Sendable (CGImage) -> Void)?
  var onPhoto: (@Sendable (Data) -> Void)?
  var onPhotoError: (@Sendable (String) -> Void)?
  private(set) var display: Display?

  private let wearables = Wearables.shared
  private let selector: AutoDeviceSelector
  private var session: DeviceSession?
  private var camera: Camera?
  /// Wearables-level listeners (registration, devices) — live as long as this object.
  private let lifetimeBag = ListenerTokenBag()
  /// Session/stream/display listeners — cleared on every stop().
  private let sessionBag = ListenerTokenBag()

  static var isHardwareAvailable: Bool {
    #if targetEnvironment(simulator)
    return false
    #else
    return true
    #endif
  }

  // MARK: configure gate (api-notes §2)
  //
  // `Wearables.shared` TRAPS ("Call configure() before attempting to access Wearables!") when configure()
  // failed, and this class touches it in init — so nobody may construct a DATSessionManager until configure()
  // has succeeded. On the Simulator (and on any phone without the Meta AI app) it throws .internalError, which
  // is a normal degraded state, not a crash: BridgeController simply runs with `dat == nil`.

  static private(set) var isConfigured = false
  static private(set) var configureError: String?

  /// Idempotent; App.swift calls this once, before BridgeController is created.
  static func configure() {
    guard !isConfigured else { return }
    do {
      try Wearables.configure()
      isConfigured = true
      configureError = nil
    } catch {
      switch error {
      case .alreadyConfigured:
        isConfigured = true                  // a second call in the same process is a success, not a failure
        configureError = nil
      case .internalError:
        configureError = "DAT internal error — Meta AI app missing, or running in the Simulator"
      case .configurationError:
        configureError = "DAT configuration invalid — check the MWDAT keys in Info.plist"
      }
      if !isConfigured { NSLog("DATSessionManager.configure failed: \(error)") }
    }
  }

  init() {
    // Build the selector EARLY so devicesStream has populated it before Start (api-notes §3 gotcha).
    selector = AutoDeviceSelector(wearables: wearables, filter: { $0.supportsDisplay() })
    registration = wearables.registrationState
    wearables.addRegistrationStateListener { [weak self] s in Task { @MainActor in self?.registration = s } }.store(in: lifetimeBag)
    wearables.addDevicesListener { [weak self] ids in
      Task { @MainActor in self?.deviceName = ids.first.flatMap { self?.wearables.deviceForIdentifier($0)?.nameOrId() } }
    }.store(in: lifetimeBag)
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

  /// All-or-nothing: any failure after the session is created tears the whole session back down before throwing.
  func start() async throws {
    stop()
    lastError = nil
    let s = try wearables.createSession(deviceSelector: selector)
    session = s
    // Mirror session state/errors through the multicast publishers, subscribed BEFORE start() (api-notes §6 step 3).
    s.statePublisher.listen { [weak self] st in Task { @MainActor in self?.sessionState = st } }.store(in: sessionBag)
    s.errorPublisher.listen { [weak self] e in Task { @MainActor in self?.lastError = "Session error: \(e)" } }.store(in: sessionBag)

    do {
      try s.start()

      // One-shot handshake on the only stateStream() we take. The stream FINISHES at .stopped (api-notes §3),
      // so an already-stopped session falls straight through the loop — `started` distinguishes that from a
      // real .started instead of silently continuing into the Meta AI permission bounce.
      var started = false
      for await st in s.stateStream() where st == .started || st == .stopped {
        started = (st == .started)
        break
      }
      guard started else { throw DATError.sessionStopped }

      // Camera permission is the only DAT permission (api-notes §3); it bounces through the Meta AI app.
      if try await wearables.checkPermissionStatus(.camera) != .granted {
        guard try await wearables.requestPermission(.camera) == .granted else { throw DATError.cameraDenied }
      }

      // Camera: raw frames (no HEVC decoding on our side), highest resolution, lowest legal fps — we sample every ~1.75 s anyway.
      let config = StreamConfiguration(videoCodec: .raw, resolution: .high, frameRate: 2)
      guard let cam = try s.addCamera(config: config) else { throw DATError.cameraUnavailable }
      camera = cam
      let stream = cam.stream

      // Snapshot the callbacks: the listener closures below run off-main and must never read MainActor state.
      let onFrame = self.onFrame
      let onPhoto = self.onPhoto
      let onPhotoError = self.onPhotoError

      stream.statePublisher.listen { [weak self] st in Task { @MainActor in self?.streamState = st } }.store(in: sessionBag)
      stream.videoFramePublisher.listen { [weak self] frame in
        guard let img = Self.cgImage(from: frame) else { return }
        Task { @MainActor in self?.frameCount += 1 }
        onFrame?(img)                                   // off-main by design: never block the DAT thread
      }.store(in: sessionBag)
      stream.photoDataPublisher.listen { photo in onPhoto?(photo.data) }.store(in: sessionBag)
      stream.errorPublisher.listen { [weak self] e in
        Task { @MainActor in self?.lastError = "Stream error: \(e)" }
        if case .photoCaptureFailed = e { onPhotoError?("capture_failed") }
      }.store(in: sessionBag)
      stream.start()

      // Display on the SAME session — the spike question.
      let d = try s.addDisplay()
      display = d
      d.statePublisher.listen { [weak self] st in Task { @MainActor in self?.displayState = st } }.store(in: sessionBag)
      d.start()
    } catch {
      // Only tear down if `s` is still the live session: a Stop→Start while this start() was suspended (the
      // handshake, or the Meta AI camera-permission bounce) means stop() here would kill the NEW session.
      if session === s { stop() }
      throw error
    }
  }

  func stop() {
    display?.onPlaybackEvent = nil
    display?.stop(); display = nil
    camera?.stop(); camera = nil
    session?.stop(); session = nil
    sessionBag.clear()      // lifetimeBag survives: the registration/devices listeners are not per-session
  }

  /// Fire-and-forget; the JPEG arrives on onPhoto, failure on onPhotoError (api-notes §5).
  func capturePhoto() -> Bool {
    // Gate on the live stream state, not the @Published mirror (which lags by one main-actor hop).
    guard let cam = camera, cam.stream.state == .streaming else { return false }
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
