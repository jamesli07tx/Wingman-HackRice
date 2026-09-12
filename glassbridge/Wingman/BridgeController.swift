// BridgeController.swift — wires the dumb pipe together (DESIGN.md §5.1's four responsibilities) and owns all
// session state StatusView shows. No product logic: it forwards frames up and cards down.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex SessionOrchestrator (armed / capture_photo / render / session_end) + DeviceGateway (WS)
// CONTRACT: DESIGN.md §4.2 message handling; Appendix D via armed.config
// AT-INTEGRATION: on every `armed` this logs "armed.config: compiled=<defaults> received=<config>" — verify the received values win (DESIGN_MAC.md required site for FrameSampler/HudRenderer).
//
// INTEGRATION: BridgeController
// IN:  StatusView actions (link/unlink/start/stop/spike/toggles); CortexSocket.onMessage; DATSessionManager.onFrame/onPhoto
// OUT: FrameSampler.offer/handlePhoto, HudRenderer.render, AudioKeepalive.start/stop, published state for StatusView
// WIRE: one instance created by App.swift as a @StateObject

import Foundation
import Combine
import SwiftUI
import UIKit
#if canImport(MWDATDisplay)
import MWDATDisplay   // for `Display` in HudRendererBox; no DAT Text/Image is used in this file, so no SwiftUI clash
#endif

@MainActor
final class BridgeController: ObservableObject {
  enum LinkState: Equatable { case unlinked, linked(deviceId: String) }

  @Published private(set) var linkState: LinkState = .unlinked
  @Published private(set) var socketState: CortexSocket.State = .disconnected
  @Published private(set) var armed = false
  @Published private(set) var sessionId: String?
  @Published private(set) var lastError: String?
  @Published private(set) var lastCard: HudCard?
  @Published private(set) var framesSent = 0
  @Published private(set) var spikeResult: String?
  @Published var useDevHarness: Bool {
    didSet { UserDefaults.standard.set(useDevHarness, forKey: "useDevHarness"); reconnectIfLinked() }
  }

  #if canImport(MWDATCore)
  let dat = DATSessionManager()
  #endif
  private var socket: CortexSocket?
  private var sampler: FrameSampler!
  private var renderer: HudRendererBox?
  private let keepalive = AudioKeepalive()
  private var pendingPhotoReqId: String?
  private var simulatorFrameTimer: Timer?
  private var datChanges: AnyCancellable?

  init() {
    useDevHarness = UserDefaults.standard.object(forKey: "useDevHarness") as? Bool ?? !Config.isCortexConfigured
    if let id = Keychain.get(Keychain.deviceIdKey), Keychain.get(Keychain.deviceTokenKey) != nil { linkState = .linked(deviceId: id) }
    // FrameSampler invokes `send` on ITS OWN serial queue — hop to main before touching any state here.
    let s = FrameSampler { [weak self] msg in
      Task { @MainActor in
        guard let self else { return }
        self.socket?.send(msg)
        if case .frame = msg { self.framesSent += 1 }
      }
    }
    sampler = s
    #if canImport(MWDATCore)
    // Capture the sampler itself: onFrame fires off-main on the DAT thread and FrameSampler is thread-safe,
    // so there is no reason to bounce the hot frame path through main-isolated state.
    dat.onFrame = { [s] img in s.offer(img) }
    dat.onPhoto = { [weak self] data in Task { @MainActor in self?.photoArrived(data) } }
    dat.onPhotoError = { [weak self] reason in Task { @MainActor in self?.photoFailed(reason) } }
    // SwiftUI does not observe a nested ObservableObject — forward DAT's changes so StatusView's dots move.
    datChanges = dat.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    #endif
    reconnectIfLinked()
  }

  var restBaseURL: URL { useDevHarness ? Config.devHarnessHTTPURL : Config.cortexURL }
  var wsURL: URL { useDevHarness ? Config.devHarnessWSURL : Config.cortexWSURL }

  // MARK: link (DESIGN.md §5.1 responsibility 1)

  func link(code: String) async {
    lastError = nil
    do {
      let r = try await LinkClient.claim(baseURL: restBaseURL, code: code, name: UIDevice.current.name)
      Keychain.set(r.deviceToken, for: Keychain.deviceTokenKey)
      Keychain.set(r.deviceId, for: Keychain.deviceIdKey)
      linkState = .linked(deviceId: r.deviceId)
      reconnectIfLinked()
    } catch {
      lastError = error.localizedDescription     // 404 until Cortex is deployed: visible + recoverable by design
    }
  }

  func unlink() {
    stop()
    socket?.disconnect(); socket = nil
    Keychain.delete(Keychain.deviceTokenKey); Keychain.delete(Keychain.deviceIdKey)
    linkState = .unlinked
  }

  /// The socket stays open whenever we are linked so a dashboard-initiated Start (armed pushed by Cortex) works.
  private func reconnectIfLinked() {
    socket?.disconnect(); socket = nil
    guard case .linked = linkState, let token = Keychain.get(Keychain.deviceTokenKey) else { return }
    let s = CortexSocket(url: wsURL, token: token)
    s.onState = { [weak self] st in self?.socketState = st }
    s.onMessage = { [weak self] m in self?.handle(m) }
    s.batteryProvider = { let b = UIDevice.current.batteryLevel; return b < 0 ? nil : Double(b) }
    s.connect()
    socket = s
  }

  // MARK: session (DESIGN.md §5.1 responsibility 2)

  func start() {
    lastError = nil
    guard socket != nil else { lastError = "Link the device first"; return }
    socket?.startSession()          // Cortex answers with `armed` → arm() does the hardware work
  }

  func stop() {
    socket?.stopSession()
    disarm()
  }

  private func arm(sessionId: String, config: ArmedConfig?) {
    let cfg = config ?? .defaults
    NSLog("armed.config: compiled=\(ArmedConfig.defaults) received=\(String(describing: config)) → using \(cfg)")
    self.sessionId = sessionId
    armed = true
    sampler.apply(cfg)
    sampler.start()
    keepalive.start()
    #if canImport(MWDATCore)
    if DATSessionManager.isHardwareAvailable {
      Task {
        do {
          try await dat.start()
          if let d = dat.display { renderer = HudRendererBox(display: d, minGapMs: cfg.renderMinGapMs) }
        } catch {
          lastError = "Glasses: \(error.localizedDescription)"
          socket?.send(.status(battery: nil, note: "dat_failed: \(error.localizedDescription)"))
        }
      }
    }
    #endif
    renderer?.apply(renderMinGapMs: cfg.renderMinGapMs)
  }

  private func disarm() {
    armed = false
    sessionId = nil
    sampler.stop()
    keepalive.stop()
    simulatorFrameTimer?.invalidate(); simulatorFrameTimer = nil
    #if canImport(MWDATCore)
    dat.stop()
    #endif
    renderer = nil
  }

  // MARK: Cortex → device (DESIGN.md §5.1 responsibility 3)

  private func handle(_ msg: CortexToDevice) {
    switch msg {
    case let .armed(sessionId, config):
      arm(sessionId: sessionId, config: config)
    case let .capturePhoto(reqId, _):
      pendingPhotoReqId = reqId
      #if canImport(MWDATCore)
      if !dat.capturePhoto() { photoFailed("capture_failed") }
      #else
      photoFailed("capture_failed")
      #endif
    case let .render(card):
      lastCard = card
      renderer?.render(card)
    case let .sessionEnd(reason):
      NSLog("session_end: \(reason)")
      disarm()
    case let .error(code, message, recoverable):
      lastError = "\(code.rawValue): \(message)\(recoverable ? "" : " (fatal)")"
    case let .unknown(type):
      NSLog("ignoring unknown message type \(type)")
    }
  }

  private func photoArrived(_ data: Data) {
    guard let reqId = pendingPhotoReqId else { return }
    pendingPhotoReqId = nil
    sampler.handlePhoto(reqId: reqId, data: data)
  }

  private func photoFailed(_ reason: String) {
    guard let reqId = pendingPhotoReqId else { return }
    pendingPhotoReqId = nil
    sampler.photoFailed(reqId: reqId, reason: reason)
  }

  func handleOpenURL(_ url: URL) async {
    #if canImport(MWDATCore)
    await dat.handleUrl(url)
    #endif
  }

  // MARK: debug helpers (Simulator-degraded path + hour-zero spike)

  /// Simulator: feed a synthetic frame once per second so FrameSampler/CortexSocket can be exercised without glasses.
  func startTestFrames() {
    simulatorFrameTimer?.invalidate()
    // Timer's block is @Sendable, so it captures nothing but `self` (a @MainActor class, hence Sendable)
    // and does all its work back on the main actor.
    simulatorFrameTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self else { return }
        let img = UIGraphicsImageRenderer(size: CGSize(width: 1280, height: 720)).image { ctx in
          UIColor(hue: CGFloat(Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 10)) / 10, saturation: 0.6, brightness: 0.9, alpha: 1).setFill()
          ctx.fill(CGRect(x: 0, y: 0, width: 1280, height: 720))
          ("TEST FRAME \(Date())" as NSString).draw(at: CGPoint(x: 40, y: 40), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 48), .foregroundColor: UIColor.black])
        }.cgImage
        if let img { self.sampler.offer(img) }
      }
    }
  }

  /// DESIGN.md §5.1 / DESIGN_MAC.md §2.1 hour-zero hardware spike: camera stream + display on ONE DeviceSession —
  /// wait for a real frame, then render a hello-world card. Independent of Cortex.
  func runSpike() async {
    spikeResult = "SPIKE running…"
    #if canImport(MWDATCore)
    guard DATSessionManager.isHardwareAvailable else { spikeResult = "SPIKE N/A in Simulator"; return }
    do {
      try await dat.start()
      let start = Date()
      while dat.frameCount == 0 && Date().timeIntervalSince(start) < 20 { try await Task.sleep(nanoseconds: 200_000_000) }
      guard dat.frameCount > 0 else { spikeResult = "SPIKE FAIL: no camera frame within 20 s (stream=\(dat.streamState)) \(dat.lastError ?? "")"; return }
      guard let d = dat.display else { spikeResult = "SPIKE FAIL: display not attached \(dat.lastError ?? "")"; return }
      let r = HudRendererBox(display: d, minGapMs: 500)
      r.render(HudCard(cardId: "spike", seq: 1, kind: .hint, title: "Wingman", subtitle: "hello, world",
                       lines: ["camera stream: OK (\(dat.frameCount) frames)", "display: sent"], footer: "hour-zero spike"))
      try await Task.sleep(nanoseconds: 3_000_000_000)
      spikeResult = "SPIKE OK: \(dat.frameCount) frames + card on lens? (check glasses) display=\(dat.displayState) \(dat.lastError ?? "")"
    } catch {
      spikeResult = "SPIKE FAIL: \(error.localizedDescription)"
    }
    #else
    spikeResult = "SPIKE N/A: DAT not linked"
    #endif
  }
}

/// Thin wrapper so BridgeController compiles when MWDATDisplay is absent (the iOS target always links it, but keep the seam explicit).
final class HudRendererBox {
  #if canImport(MWDATDisplay)
  private let inner: HudRenderer
  init(display: Display, minGapMs: Int) { inner = HudRenderer(display: display, minGapMs: minGapMs) }
  func render(_ card: HudCard) { inner.render(card) }
  func apply(renderMinGapMs: Int) { inner.apply(renderMinGapMs: renderMinGapMs) }
  #else
  func render(_ card: HudCard) {}
  func apply(renderMinGapMs: Int) {}
  #endif
}
