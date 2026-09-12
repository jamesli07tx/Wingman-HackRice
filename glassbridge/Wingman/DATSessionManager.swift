// DATSessionManager.swift — DESIGN.md §5.1: ONE DAT DeviceSession carrying BOTH the camera stream and the display.
// This combination is undocumented by Meta (docs/dat-0.9.0-api-notes.md §6 "Camera + Display on ONE session")
// and is exactly what the hour-zero hardware spike (BridgeController.runSpike) verifies. Display cannot be mocked
// (Mock Device Kit has no display model) — the display path is hardware-only.
//
// INTEGRATION: DATSessionManager
// IN:  connect()/startCamera()/stopCamera()/disconnect()/capturePhoto() from BridgeController; the Meta AI
//      registration callback URL from App.onOpenURL
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
import NetworkExtension
import MWDATCore
import MWDATCamera
import MWDATDisplay

/// File-scope so the off-main frame path can use it without touching MainActor state.
private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
/// Likewise: the stream is hvc1, so most frames arrive compressed and need VideoToolbox first.
private let hevcDecoder = HEVCFrameDecoder()

@MainActor
final class DATSessionManager: ObservableObject {
  @Published private(set) var registration: RegistrationState = .unavailable
  @Published private(set) var deviceName: String?
  @Published private(set) var sessionState: DeviceSessionState = .idle
  @Published private(set) var streamState: StreamState = .stopped
  @Published private(set) var displayState: DisplayState = .stopped
  @Published private(set) var lastError: String?
  /// The HARDWARE session is up (session .started + display attached). Survives every camera start/stop:
  /// the SDK re-joins the glasses' Wi-Fi hotspot on each camera stream start, and that hotspot is gone the
  /// instant the DeviceSession ends — so a session churned per Cortex session makes iOS pop
  /// "Unable to join the network Meta RB Display". Connect ONCE, stream many times.
  @Published private(set) var isConnected = false
  @Published private(set) var frameCount = 0
  /// Frames that ARRIVED from the glasses (before decoding) — proves the link even if decode fails.
  @Published private(set) var rawFrameCount = 0
  /// The Wi-Fi the PHONE is on. The camera transport makes the SDK join the glasses' own hotspot
  /// ("Meta RB Display …"), so this is the one visible sign that the join actually happened.
  @Published private(set) var wifiSSID: String?

  // The three callbacks are invoked OFF the main actor, straight from the DAT listener thread, so they are
  // `@Sendable` and are snapshotted into locals at startCamera() time — the listener closures never touch `self`.
  // CONSEQUENCE: assign them BEFORE calling startCamera(); assignments made after are not picked up until
  // the next startCamera(). (BridgeController assigns them in its init, so this is satisfied.)
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
  /// Session + display listeners — live as long as the connection, cleared only on disconnect().
  private let sessionBag = ListenerTokenBag()
  /// Camera/stream listeners only — cleared on every stopCamera(), so the session/display ones survive.
  private let cameraBag = ListenerTokenBag()
  /// Polls the SSID while connected — the join happens inside the SDK, with no callback of its own.
  private var wifiTimer: Timer?

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

  // MARK: Wi-Fi / hotspot
  //
  // NEHotspotNetwork.fetchCurrent is iOS 14+, callback-only, and needs the `wifi-info` entitlement (we ship it,
  // alongside HotspotConfiguration, for the Display camera transport). It answers nil when iOS withholds the
  // SSID (no Wi-Fi, or neither location permission nor an app-configured hotspot) — a blank pill, not an error.

  func refreshWiFi() async {
    wifiSSID = await withCheckedContinuation { cont in
      NEHotspotNetwork.fetchCurrent { cont.resume(returning: $0?.ssid) }
    }
  }

  private func startWiFiPolling() {
    wifiTimer?.invalidate()
    wifiTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      Task { @MainActor in await self?.refreshWiFi() }
    }
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
  //
  // Split in two on purpose: connect() owns the DeviceSession + Display and is meant to stay up for the whole
  // time the app is open; startCamera()/stopCamera() own the Camera capability and follow the Cortex session.
  // api-notes §4: "camera.stop() detaches the camera (cascades to stream); session stays up, addCamera() again
  // to restart" — exactly the shape that keeps the glasses' hotspot from being torn down under iOS.

  /// Session + display only, no camera. Idempotent. All-or-nothing: any failure after the session is created
  /// tears the whole session back down before throwing.
  func connect() async throws {
    guard !isConnected else { return }
    disconnect()                 // a half-built session from a previous failed connect() must not leak
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

      // Display on the SAME session — the spike question. Attached here, at connect time, so a camera
      // stop/start never touches it.
      let d = try s.addDisplay()
      display = d
      d.statePublisher.listen { [weak self] st in Task { @MainActor in self?.displayState = st } }.store(in: sessionBag)
      d.start()
      isConnected = true
      startWiFiPolling()
      await refreshWiFi()
    } catch {
      // Only tear down if `s` is still the live session: a disconnect→connect while this connect() was
      // suspended (the handshake) means disconnect() here would kill the NEW session.
      if session === s { disconnect() }
      throw error
    }
  }

  /// Camera capability on the already-connected session. Idempotent while a camera is attached.
  func startCamera() async throws {
    guard let s = session, isConnected else { throw DATError.notConnected }
    guard camera == nil else { return }

    // Camera permission is the only DAT permission (api-notes §3); it bounces through the Meta AI app.
    if try await wearables.checkPermissionStatus(.camera) != .granted {
      guard try await wearables.requestPermission(.camera) == .granted else { throw DATError.cameraDenied }
    }
    // The Meta AI bounce suspends us: a disconnect in the meantime must not attach a camera to a dead session.
    guard session === s else { throw DATError.notConnected }

    // Mirrors Meta's CameraAccess sample (hvc1/low/24): HEVC over Bluetooth Classic. `.raw` at .high made the SDK
    // reach for the Wi-Fi hotspot transport, which a free Personal Team cannot sign (HotspotConfiguration entitlement).
    // .high (720×1280) now that the transport is the glasses' Wi-Fi hotspot (verified on hardware): gives the
    // 768 px frames DESIGN.md wants for banner text. 15 fps keeps HEVC keyframes frequent for the decoder.
    let config = StreamConfiguration(videoCodec: .hvc1, resolution: .high, frameRate: 15)
    guard let cam = try s.addCamera(config: config) else { throw DATError.cameraUnavailable }
    camera = cam
    let stream = cam.stream

    // Snapshot the callbacks: the listener closures below run off-main and must never read MainActor state.
    let onFrame = self.onFrame
    let onPhoto = self.onPhoto
    let onPhotoError = self.onPhotoError

    // Every state change is a candidate hotspot join/leave — the SDK re-joins on each stream start.
    stream.statePublisher.listen { [weak self] st in
      Task { @MainActor in self?.streamState = st; await self?.refreshWiFi() }
    }.store(in: cameraBag)
    stream.videoFramePublisher.listen { [weak self] frame in
      Task { @MainActor in self?.rawFrameCount += 1 }
      guard let img = Self.cgImage(from: frame) else { return }
      Task { @MainActor in self?.frameCount += 1 }
      onFrame?(img)                                   // off-main by design: never block the DAT thread
    }.store(in: cameraBag)
    stream.photoDataPublisher.listen { photo in onPhoto?(photo.data) }.store(in: cameraBag)
    stream.errorPublisher.listen { [weak self] e in
      Task { @MainActor in self?.lastError = "Stream error: \(e)" }
      if case .photoCaptureFailed = e { onPhotoError?("capture_failed") }
    }.store(in: cameraBag)
    stream.start()
    await refreshWiFi()
  }

  /// Detaches the camera (api-notes §4: cascades to the stream) and leaves the session + display up.
  func stopCamera() {
    camera?.stop(); camera = nil
    streamState = .stopped
    cameraBag.clear()       // sessionBag survives: the session/display listeners are not per-camera
  }

  /// Full teardown — this is what makes iOS drop the glasses' hotspot, so call it only on an explicit Disconnect.
  func disconnect() {
    stopCamera()
    display?.onPlaybackEvent = nil
    display?.stop(); display = nil
    session?.stop(); session = nil
    sessionBag.clear()      // lifetimeBag survives: the registration/devices listeners are not per-session
    wifiTimer?.invalidate(); wifiTimer = nil
    wifiSSID = nil
    isConnected = false
    sessionState = .idle
    displayState = .stopped
  }

  /// Compatibility wrappers for the old one-shot lifecycle.
  func start() async throws { try await connect(); try await startCamera() }
  func stop() { disconnect() }

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
    // hvc1: compressed, so there is no image buffer — VideoToolbox has to decode it first.
    if let fd = CMSampleBufferGetFormatDescription(frame.sampleBuffer),
       CMFormatDescriptionGetMediaSubType(fd) == kCMVideoCodecType_HEVC {
      return hevcDecoder.decode(frame.sampleBuffer)
    }
    return frame.makeUIImage()?.cgImage       // fallback if the buffer is neither a pixel buffer nor HEVC
  }
}

enum DATError: Error, LocalizedError {
  case sessionStopped, notConnected, cameraDenied, cameraUnavailable
  var errorDescription: String? {
    switch self {
    case .sessionStopped: return "DAT session stopped before it started (glasses off / hinges closed / Developer Mode off?)"
    case .notConnected: return "Glasses not connected — connect first"
    case .cameraDenied: return "Camera permission denied in the Meta AI app"
    case .cameraUnavailable: return "addCamera returned nil — session not .started"
    }
  }
}
#endif
