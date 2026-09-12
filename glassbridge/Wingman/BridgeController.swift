// BridgeController.swift — wires the dumb pipe together (DESIGN.md §5.1's four responsibilities) and owns all
// session state the UI shows. No product logic: it forwards frames up and cards down.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex SessionOrchestrator (armed / capture_photo / render / session_end) + DeviceGateway (WS)
// CONTRACT: DESIGN.md §4.2 message handling; Appendix D via armed.config
// AT-INTEGRATION: on every `armed` this logs "armed.config: compiled=<defaults> received=<config>" — verify the received values win (DESIGN_MAC.md required site for FrameSampler/HudRenderer).
//
// INTEGRATION: BridgeController
// IN:  RootView actions (sign in/resume/links/connect/disconnect/start/stop/spike/toggles); CortexSocket.onMessage; DATSessionManager.onFrame/onPhoto
// OUT: FrameSampler.offer/handlePhoto, HudRenderer.render, AudioKeepalive.start/stop, published state for RootView's screens
// WIRE: one instance created by App.swift as a @StateObject, AFTER DATSessionManager.configure()

import Foundation
import Combine
import UIKit
#if canImport(MWDATDisplay)
import MWDATDisplay   // for `Display` in HudRendererBox; no DAT Text/Image is used in this file, so no SwiftUI clash
#endif

@MainActor
final class BridgeController: ObservableObject {
  enum LinkState: Equatable { case unlinked, linked(deviceId: String) }

  /// Clerk. Owned here so one object drives the whole UI; its changes are forwarded below.
  let auth = AuthManager()
  /// The parsed resume Cortex holds for this user (nil until one is uploaded).
  @Published private(set) var profile: ProfileSummary?
  /// Edited in place by ProfileView's four fields; pushed with saveLinks().
  @Published var links = ProfileLinks()
  /// One line under the profile card: "Uploading resume…", "Links saved", or the failure.
  @Published private(set) var profileStatus: String?
  /// A profile/link/claim call is in flight — the buttons spin and disable.
  @Published private(set) var profileBusy = false

  @Published private(set) var linkState: LinkState = .unlinked
  @Published private(set) var socketState: CortexSocket.State = .disconnected
  @Published private(set) var armed = false
  @Published private(set) var sessionId: String?
  @Published private(set) var lastError: String?
  /// Not an error, just the next thing to do ("Set the Cortex URL first") — step 1 shows it in plain grey.
  @Published private(set) var cortexHint: String?
  @Published private(set) var lastCard: HudCard?
  @Published private(set) var framesSent = 0
  /// The last JPEG handed to Cortex, decoded for the phone screen ("what the glasses see").
  @Published private(set) var lastFrame: UIImage?
  @Published private(set) var spikeResult: String?
  @Published private(set) var spikeRunning = false
  /// connectGlasses() is in flight — GlassesView disables the button and spins.
  @Published private(set) var glassesConnecting = false
  @Published private(set) var testFramesRunning = false
  /// dat.streamState == .streaming, mirrored as one Bool for the UI. Derived in the DAT change forwarder below.
  @Published private(set) var cameraReady = false
  /// Force-reconnect state (GlassesView). An "episode" is one run of consecutive automatic recoveries: it
  /// ends after 30 s of healthy streaming, or when the user taps Force reconnect. At most 3 automatic tries.
  @Published private(set) var reconnectAttempt = 0
  @Published private(set) var reconnectStatus: String?
  @Published private(set) var reconnecting = false
  /// A render wakes a sleeping lens, and the lens sleeps ~25 s after the last one (api-notes §6) — so while a
  /// session is armed we re-send the current card every 20 s. Off = let the lens sleep between cards.
  @Published var keepLensAwake: Bool {
    didSet {
      UserDefaults.standard.set(keepLensAwake, forKey: "keepLensAwake")
      if armed { startKeepAwake() } else { awakeTimer?.invalidate(); awakeTimer = nil }
    }
  }
  /// The Cortex URL as typed in Session → Debug tools. Applied — not live-bound — so a half-typed host never
  /// becomes the dial target; `applyCortexURL()` is what commits it.
  @Published var cortexURLText: String = Config.cortexOverride ?? ""
  /// Debug-only escape hatch now: off unless the operator turns it on in Debug tools. It used to default to
  /// ON whenever Cortex was unconfigured, which quietly made the harness the demo's real endpoint.
  @Published var useDevHarness: Bool {
    didSet {
      UserDefaults.standard.set(useDevHarness, forKey: "useDevHarness")
      if armed { stop() }        // the other endpoint knows nothing about the session we were running
      reconnectIfLinked()
    }
  }

  #if canImport(MWDATCore)
  /// nil when DATSessionManager.configure() failed — its init touches `Wearables.shared`, which TRAPS when
  /// configuration failed, so on the Simulator (or a phone without the Meta AI app) there is simply no manager.
  let dat: DATSessionManager? = DATSessionManager.isConfigured ? DATSessionManager() : nil
  #endif
  private var socket: CortexSocket?
  private var sampler: FrameSampler!
  private var renderer: HudRendererBox?
  private let keepalive = AudioKeepalive()
  private let battery = BatteryMonitor()
  /// FIFO: Cortex may have more than one capture_photo outstanding, and DAT's photo callback carries no reqId.
  private var foregroundObserver: NSObjectProtocol?
  private var pendingPhotoReqIds: [String] = []
  /// The in-flight arm (connect + startCamera); cancelled and awaited so two arms can never race inside DAT.
  private var armTask: Task<Void, Never>?
  private var simulatorFrameTimer: Timer?
  /// True while the arm sequence (connect + startCamera) runs — the stream watchdog must not fight it.
  private var arming = false
  private var watchdogTask: Task<Void, Never>?
  /// When the current unbroken run of .streaming began — 30 s of it ends a recovery episode.
  private var streamingSince: Date?
  /// One forceReconnect per `dat.lostConnection` edge, not one per DAT publish.
  private var lostHandled = false
  private var awakeTimer: Timer?
  private var datChanges: AnyCancellable?
  private var authChanges: AnyCancellable?
  /// Edge detector: the sign-in side effects (fetch profile, auto-link) run once per transition.
  private var wasSignedIn = false
  private var batteryObserver: NSObjectProtocol?

  init() {
    // The harness is a per-launch dev opt-in: never restore a stale `true` when a real Cortex URL is configured
    // (a persisted toggle from a harness session would silently dial the dead tunnel and show "disconnected").
    useDevHarness = Config.isCortexConfigured ? false : (UserDefaults.standard.object(forKey: "useDevHarness") as? Bool ?? false)
    keepLensAwake = UserDefaults.standard.object(forKey: "keepLensAwake") as? Bool ?? true
    if let id = Keychain.get(Keychain.deviceIdKey), Keychain.get(Keychain.deviceTokenKey) != nil { linkState = .linked(deviceId: id) }
    // FrameSampler invokes `send` on ITS OWN serial queue — hop to main before touching any state here.
    let s = FrameSampler { [weak self] msg in
      // Decode the preview off-main (sampler queue), publish on main.
      var preview: UIImage?
      if case let .frame(_, _, b64) = msg, let d = Data(base64Encoded: b64) { preview = UIImage(data: d) }
      Task { @MainActor in
        guard let self else { return }
        self.socket?.send(msg)
        if case .frame = msg { self.framesSent += 1; if let preview { self.lastFrame = preview } }
      }
    }
    sampler = s
    #if canImport(MWDATCore)
    // Assigned before any start(), as DATSessionManager requires. The frame path stays off-main: FrameSampler
    // is queue-confined and Sendable, so the DAT listener thread hands frames to it without a main-actor hop.
    dat?.onFrame = { [s] img in s.offer(img) }
    dat?.onPhoto = { [weak self] data in Task { @MainActor in self?.photoArrived(data) } }
    dat?.onPhotoError = { [weak self] reason in Task { @MainActor in self?.photoFailed(reason) } }
    // SwiftUI does not observe a nested ObservableObject — forward DAT's changes so the glasses pills move.
    // objectWillChange fires BEFORE the new value lands, hence the hop to read the settled streamState.
    datChanges = dat?.objectWillChange.sink { [weak self] _ in
      self?.objectWillChange.send()
      Task { @MainActor in self?.refreshCameraReady() }
    }
    #endif
    // Same reason as the DAT forwarder: SwiftUI does not observe a nested ObservableObject.
    authChanges = auth.objectWillChange.sink { [weak self] _ in
      self?.objectWillChange.send()
      Task { @MainActor in self?.authDidChange() }
    }
    refreshBattery()
    batteryObserver = NotificationCenter.default.addObserver(
      forName: UIDevice.batteryLevelDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
        Task { @MainActor in self?.refreshBattery() }
      }
    reconnectIfLinked()
    // Registered last (all stored properties initialized). Cuts the reconnect backoff short after an unlock.
    foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor in
        guard let self, case .linked = self.linkState else { return }
        self.socket?.connect()   // idempotent: no-op while a task is open
      }
    }
  }

  deinit {
    socket?.disconnect()
    if let o = batteryObserver { NotificationCenter.default.removeObserver(o) }
  }

  // Computed, never cached: both re-read Config on every access, so an applied override takes effect at once.
  var restBaseURL: URL { useDevHarness ? Config.devHarnessHTTPURL : Config.cortexURL }
  var wsURL: URL { useDevHarness ? Config.devHarnessWSURL : Config.cortexWSURL }

  /// Integration day without a rebuild: paste the Fly host, tap Apply. Empty clears the override and falls
  /// back to the build-time xcconfig value.
  func applyCortexURL() {
    let raw = cortexURLText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else {
      Config.cortexOverride = nil
      cortexURLText = ""
      lastError = nil
      reconnectIfLinked()          // re-raises the hint if that leaves us with no URL at all
      return
    }
    guard Config.normalizeOverride(raw) != nil else { lastError = "Cortex URL not understood"; return }
    Config.cortexOverride = raw
    lastError = nil
    // The harness token means nothing to Cortex — sending it would fail authentication with no visible cause.
    let droppedHarnessLink = linkedToHarness
    if droppedHarnessLink { unlink() }
    // A real Cortex URL means we are not talking to the harness. Assigning useDevHarness unconditionally would
    // re-run its didSet (which stops an armed session), so only touch it when it actually changes.
    if useDevHarness { useDevHarness = false } else { reconnectIfLinked() }
    if droppedHarnessLink { cortexHint = "Harness link cleared — link with the dashboard code" }
  }

  /// A URL to dial: either the Debug harness toggle is on, or Cortex has one (xcconfig or pasted override).
  var cortexConfigured: Bool { useDevHarness || Config.isCortexConfigured }

  private var linkedToHarness: Bool {
    if case let .linked(id) = linkState { return id == "dev_harness" }
    return false
  }

  private func refreshBattery() {
    let b = UIDevice.current.batteryLevel
    battery.update(b < 0 ? nil : Double(b))
  }

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

  // MARK: account (DESIGN.md §4.1 — the whole reason the app stopped needing a dashboard)
  //
  // Everything here talks to the REAL Cortex, never the DevHarness: a profile belongs to the Clerk user,
  // not to whatever socket the Debug toggle happens to be dialing.

  private var cortex: CortexClient {
    CortexClient(baseURL: Config.cortexURL, tokenProvider: { [auth] in try await auth.token() })
  }

  /// Signed in AND we know where Cortex is — the precondition for every call below.
  var accountReady: Bool { auth.isSignedIn && Config.isCortexConfigured }

  /// Signing in is the only step the user takes: the profile comes down and the glasses link themselves.
  private func authDidChange() {
    let signedIn = auth.isSignedIn
    guard signedIn != wasSignedIn else { return }
    wasSignedIn = signedIn
    guard signedIn else { return }
    Task {
      await refreshProfile()
      if case .unlinked = linkState { await linkGlassesViaAccount() }
    }
  }

  func refreshProfile() async {
    guard accountReady else { return }
    do {
      let envelope = try await cortex.getProfile()
      profile = envelope.profile
      if let fetched = envelope.links { links = fetched }
      else if let fromProfile = envelope.profile?.links { links = fromProfile }
      profileStatus = nil
    } catch {
      profileStatus = error.localizedDescription
    }
  }

  func uploadResume(_ data: Data) async {
    guard accountReady else { profileStatus = "Sign in first"; return }
    profileBusy = true
    defer { profileBusy = false }
    profileStatus = "Uploading resume…"
    do {
      profile = try await cortex.uploadResume(pdf: data)
      if let fromProfile = profile?.links, !fromProfile.isEmpty { links = fromProfile }
      profileStatus = "Resume parsed"
    } catch {
      profileStatus = error.localizedDescription
    }
  }

  func saveLinks() async {
    guard accountReady else { profileStatus = "Sign in first"; return }
    profileBusy = true
    defer { profileBusy = false }
    profileStatus = "Saving links…"
    do {
      try await cortex.setLinks(links)
      profileStatus = "Links saved"
    } catch {
      profileStatus = error.localizedDescription
    }
  }

  /// Mint a link code as the signed-in user and immediately spend it as this device — the 6-digit
  /// dance of D9, with nobody typing anything. Runs automatically right after sign-in.
  func linkGlassesViaAccount() async {
    guard accountReady else { lastError = "Sign in first"; return }
    profileBusy = true
    defer { profileBusy = false }
    lastError = nil
    do {
      let claimed = try await cortex.linkGlasses(name: UIDevice.current.name)
      Keychain.set(claimed.deviceToken, for: Keychain.deviceTokenKey)
      Keychain.set(claimed.deviceId, for: Keychain.deviceIdKey)
      linkState = .linked(deviceId: claimed.deviceId)
      reconnectIfLinked()
    } catch {
      lastError = error.localizedDescription
    }
  }

  /// The device token belongs to the account that minted it, so signing out drops it too.
  func signOut() async {
    await auth.signOut()
    unlink()
    profile = nil
    links = ProfileLinks()
    profileStatus = nil
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
    cortexHint = nil
    guard cortexConfigured else { cortexHint = "Set the Cortex URL first"; return }
    guard case .linked = linkState, let token = Keychain.get(Keychain.deviceTokenKey) else { return }
    let s = CortexSocket(url: wsURL, token: token)
    s.onState = { [weak self] st in self?.socketState = st }
    s.onMessage = { [weak self] m in self?.handle(m) }
    s.batteryProvider = { [battery] in battery.read() }   // heartbeat runs on the socket's queue, never on main
    s.connect()
    socket = s
  }

  // MARK: glasses connection (hardware session — independent of any Cortex session)
  //
  // WHY THIS IS SEPARATE: the SDK joins the glasses' Wi-Fi hotspot when the camera stream starts, and the
  // hotspot disappears the moment the DeviceSession ends. Tearing the session down per Cortex session therefore
  // made iOS pop "Unable to join the network Meta RB Display" on every Start. So the CONNECTION owns the whole
  // hardware bring-up — session, display, renderer AND the camera stream — and stays up until Disconnect.
  // Start/Stop then only decide whether sampled frames are sent to Cortex (FrameSampler drops them otherwise).

  /// Connect, and if the bring-up failed, recover once: a failed hotspot join leaves state that makes EVERY
  /// later Connect fail until the hotspot entry is dropped, so retrying the same way is pointless.
  func connectGlasses() async {
    #if canImport(MWDATCore)
    await connectGlassesOnce()
    guard let dat, DATSessionManager.isHardwareAvailable, !dat.isConnected, !reconnecting else { return }
    await forceReconnect(reason: "connect failed")
    #endif
  }

  private func connectGlassesOnce() async {
    #if canImport(MWDATCore)
    guard let dat, DATSessionManager.isHardwareAvailable, !glassesConnecting else { return }
    guard !dat.isConnected else { return }
    glassesConnecting = true
    defer { glassesConnecting = false }
    lastError = nil
    do {
      // Neither dat.connect() nor startCamera() has a deadline of its own (the handshake may never reach
      // .started, the camera bounces through Meta AI): if they hang they would hang arm / spike / playground
      // forever. Race the WHOLE bring-up against 30 s — every caller must end in connected or an error.
      let ok = try await withThrowingTaskGroup(of: Bool.self) { group in
        group.addTask { try await self.bringUpGlasses(dat); return true }
        group.addTask { try await Task.sleep(nanoseconds: 30_000_000_000); return false }
        let first = try await group.next()!
        group.cancelAll()
        return first
      }
      guard ok else {
        dat.disconnect()
        lastError = "Glasses: connect timed out (session=\(dat.sessionState))"
        return
      }
      startWatchdog()      // watches the stream for as long as the connection lives; fresh attempt counter
      keepalive.start()    // Spotify-style background lifetime follows the glasses connection, not just the session
    } catch {
      lastError = "Glasses: \(error.localizedDescription)"
    }
    #endif
  }

  #if canImport(MWDATCore)
  /// Session → display → renderer → camera stream. The camera is part of the connection: starting the stream is
  /// what makes the SDK join the glasses' hotspot, and the user expects Connect to be what does that. A camera
  /// failure is reported but leaves the connection (and the display) up.
  private func bringUpGlasses(_ dat: DATSessionManager) async throws {
    try await dat.connect()
    guard let d = dat.display else { lastError = "Glasses: display not attached"; return }
    // ONE renderer for the life of the connection: cards, spike and playground all draw through it.
    if renderer == nil { renderer = HudRendererBox(display: d, minGapMs: ArmedConfig.defaults.renderMinGapMs) }
    do { try await dat.startCamera() } catch { lastError = "Glasses: camera \(error.localizedDescription)" }
    refreshCameraReady()
  }

  private func refreshCameraReady() {
    guard let dat else { return }
    if case .streaming = dat.streamState {
      cameraReady = true
      streamingSince = streamingSince ?? Date()
    } else {
      cameraReady = false
      streamingSince = nil
    }
    // DAT dropped the session under us: isConnected is now a lie, and every later Connect would fail on it.
    if dat.lostConnection, !lostHandled, !reconnecting, !glassesConnecting {
      lostHandled = true
      Task { await self.forceReconnect(reason: "session stopped") }
    }
    if !dat.lostConnection { lostHandled = false }
  }
  #endif

  /// The escape hatch from "every Connect fails until force-quit": drop the session AND the glasses' hotspot
  /// entry (dat.hardReset), then bring the whole thing up again. Capped at 3 per episode so a dead pair of
  /// glasses cannot loop forever; the user's own Force reconnect always starts a fresh episode.
  func forceReconnect(reason: String) async {
    #if canImport(MWDATCore)
    // Never while a bring-up is in flight: hardReset() would disconnect the session it is still building.
    guard let dat, DATSessionManager.isHardwareAvailable, !reconnecting, !glassesConnecting else { return }
    guard reconnectAttempt < 3 else {
      reconnectStatus = "Reconnect gave up after 3 tries (\(reason)) — tap Force reconnect"
      return
    }
    reconnecting = true
    defer { reconnecting = false }
    reconnectAttempt += 1
    reconnectStatus = "Reconnecting (\(reconnectAttempt)/3): \(reason)"
    watchdogTask?.cancel(); watchdogTask = nil
    await dat.hardReset()
    await connectGlassesOnce()          // starts the camera, and a fresh watchdog with a fresh grace window
    reconnectStatus = dat.isConnected ? nil : "Reconnect \(reconnectAttempt)/3 failed: \(lastError ?? "unknown")"
    #endif
  }

  /// The user tapped Force reconnect: a new episode, so the cap starts over.
  func userForceReconnect() async {
    reconnectAttempt = 0
    reconnectStatus = nil
    await forceReconnect(reason: "manual")
  }

  func disconnectGlasses() {
    guard !armed else { lastError = "Stop the session first"; return }
    watchdogTask?.cancel(); watchdogTask = nil
    reconnectAttempt = 0
    reconnectStatus = nil
    renderer = nil
    keepalive.stop()
    #if canImport(MWDATDisplay)
    playgroundShown = false
    #endif
    #if canImport(MWDATCore)
    dat?.disconnect()
    #endif
  }

  // MARK: session (DESIGN.md §5.1 responsibility 2)

  func start() {
    lastError = nil
    guard cortexConfigured else { cortexHint = "Set the Cortex URL first"; return }
    guard socket != nil else { lastError = "Link the device first"; return }
    socket?.startSession()          // Cortex answers with `armed` → arm() does the hardware work
  }

  func stop() {
    socket?.stopSession()
    disarm()
  }

  private func arm(sessionId newSessionId: String, config: ArmedConfig?) {
    // The spike owns the DAT session for its duration (runSpike refuses to start while armed; this is the
    // other half of that deal).
    guard !spikeRunning else {
      NSLog("ignoring armed \(newSessionId): the hour-zero spike is running")
      socket?.send(.status(battery: nil, note: "spike_running"))   // tell Cortex why nothing is coming up
      return
    }
    let cfg = config ?? .defaults
    NSLog("armed.config: compiled=\(ArmedConfig.defaults) received=\(String(describing: config)) → using \(cfg)")

    // ANY `armed` while we are already armed is a sessionId + config update, never a restart: a WS blip makes
    // Cortex mint a NEW sessionId, and re-entering the hardware path would re-attach a camera that is already
    // streaming. (The stream belongs to the CONNECTION now — arm only re-asserts it, idempotently.)
    if armed {
      sessionId = newSessionId
      sampler.apply(cfg)
      renderer?.apply(renderMinGapMs: cfg.renderMinGapMs)
      return
    }

    sessionId = newSessionId
    armed = true
    sampler.apply(cfg)
    sampler.start()
    keepalive.start()

    #if canImport(MWDATCore)
    guard let dat, DATSessionManager.isHardwareAvailable else { return }
    let previous = armTask
    previous?.cancel()
    armTask = Task {
      _ = await previous?.value     // serialize: never two overlapping DAT attach sequences
      guard !Task.isCancelled else { return }
      arming = true
      defer { arming = false }
      if !dat.isConnected { await connectGlasses() }          // first Start of the app also brings the link up
      guard !Task.isCancelled, dat.isConnected else { return }  // connectGlasses already reported the failure
      renderer?.apply(renderMinGapMs: cfg.renderMinGapMs)     // never rebuilt: the display outlives the session
      do {
        try await dat.startCamera()     // idempotent: a no-op unless the connection's own camera start failed
      } catch {
        guard !Task.isCancelled else { return }
        lastError = "Glasses: \(error.localizedDescription)"
        socket?.send(.status(battery: nil, note: "dat_failed: \(error.localizedDescription)"))
      }
    }
    startKeepAwake()
    #endif
  }

  // MARK: stream watchdog (lives with the connection) + lens keepalive (lives with an armed session)

  /// The camera stream dies quietly: the glasses' hotspot drops and DAT sits in .waitingForDevice with no error.
  ///
  /// The join itself is SLOW, though — well past 10 s after startCamera() — so the watchdog only arms once the
  /// stream has actually reached .streaming since the last (re)start. Until then it just waits out a 45 s grace:
  /// restarting the camera mid-join is what knocked the phone off the hotspot and burned every retry at once.
  /// Armed, a 10 s outage buys a stopCamera()/startCamera() cycle (which re-enters the grace wait), at most
  /// twice per episode — after that only a full hardReset + reconnect is worth trying. Everything it says goes
  /// to `reconnectStatus`: the red banner is for errors the operator has to act on.
  private func startWatchdog() {
    #if canImport(MWDATCore)
    guard let dat, DATSessionManager.isHardwareAvailable else { return }
    watchdogTask?.cancel()
    watchdogTask = Task { [weak self] in
      var restarts = 0
      var seenStreaming = false          // armed only after the stream has proved it can run
      var graceStart = Date()
      var downSince: Date?
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        guard let self, !Task.isCancelled, dat.isConnected else { return }

        if case .streaming = dat.streamState {
          seenStreaming = true
          downSince = nil
          // A healthy stretch ends the recovery episode: fresh caps for whatever goes wrong next.
          if let since = self.streamingSince, -since.timeIntervalSinceNow >= 30, self.reconnectAttempt > 0 || restarts > 0 {
            restarts = 0
            self.reconnectAttempt = 0
            self.reconnectStatus = nil
          }
          continue
        }
        guard !self.arming, !self.glassesConnecting, !self.reconnecting else { downSince = nil; continue }

        guard seenStreaming else {
          // Still joining the glasses' Wi-Fi. Only a no-show past 45 s is a real fault — and the cure for it is
          // the hotspot entry, not another camera cycle.
          guard -graceStart.timeIntervalSinceNow >= 45 else { continue }
          self.reconnectStatus = "Camera never started — reconnecting"
          Task { await self.forceReconnect(reason: "camera stream stuck") }
          return
        }

        let since = downSince ?? Date()
        downSince = since
        guard -since.timeIntervalSinceNow >= 10 else { continue }
        guard restarts < 2 else {
          self.reconnectStatus = "Camera stream stuck — reconnecting"
          Task { await self.forceReconnect(reason: "camera stream stuck") }
          return
        }
        restarts += 1
        self.reconnectStatus = "Camera stream dropped — restarting (\(restarts)/2)"
        dat.stopCamera()
        do { try await dat.startCamera() }
        catch { self.reconnectStatus = "Camera restart failed: \(error.localizedDescription)" }
        seenStreaming = false; downSince = nil; graceStart = Date()   // a restart re-joins the hotspot: grace again
      }
    }
    #endif
  }

  /// Re-renders the card already on the lens, same cardId/seq — a full replace, which is all a DAT send ever is.
  private func startKeepAwake() {
    awakeTimer?.invalidate(); awakeTimer = nil
    guard keepLensAwake else { return }
    awakeTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, self.armed, self.keepLensAwake, let card = self.lastCard else { return }
        self.renderer?.render(card)
      }
    }
  }

  private func disarm() {
    // Released, not retained: awaiting a hung attach would wedge every later Start. A stale attach that fails
    // later cannot hurt the newer session — DATSessionManager guards both connect() and startCamera() on
    // `session === s`, i.e. it only acts while the session it started on is still the live one.
    armTask?.cancel(); armTask = nil
    awakeTimer?.invalidate(); awakeTimer = nil
    armed = false
    sessionId = nil
    pendingPhotoReqIds.removeAll()
    sampler.stop()
    #if canImport(MWDATCore)
    if dat?.isConnected != true { keepalive.stop() }   // stays on while the glasses are connected
    #else
    keepalive.stop()
    #endif
    stopTestFrames()
    // The camera stream is NOT stopped: it belongs to the connection (see connectGlasses), and sampler.stop()
    // above already drops every frame before it is encoded. Stopping it here would drop the hotspot.
  }

  // MARK: Cortex → device (DESIGN.md §5.1 responsibility 3)

  private func handle(_ msg: CortexToDevice) {
    switch msg {
    case let .armed(sessionId, config):
      arm(sessionId: sessionId, config: config)
    case let .capturePhoto(reqId, _):
      #if canImport(MWDATCore)
      if dat?.capturePhoto() == true { pendingPhotoReqIds.append(reqId) }
      else { sampler.photoFailed(reqId: reqId, reason: "capture_failed") }
      #else
      sampler.photoFailed(reqId: reqId, reason: "capture_failed")
      #endif
    case let .render(card):
      lastCard = card
      renderer?.render(card)
    case let .sessionEnd(reason):
      NSLog("session_end: \(reason)")
      // Clears CortexSocket.wantsSession so a later reconnect does not resurrect the ended session by
      // re-sending session_start — WITHOUT emitting a session_stop nobody asked for (a dumb pipe doesn't, and
      // it would race a dashboard re-Start landing within one RTT).
      socket?.endSession()
      disarm()
    case let .error(code, message, recoverable):
      lastError = "\(code.rawValue): \(message)\(recoverable ? "" : " (fatal)")"
    case let .unknown(type):
      NSLog("ignoring unknown message type \(type)")
    }
  }

  private func photoArrived(_ data: Data) {
    guard !pendingPhotoReqIds.isEmpty else { return }
    sampler.handlePhoto(reqId: pendingPhotoReqIds.removeFirst(), data: data)
  }

  private func photoFailed(_ reason: String) {
    guard !pendingPhotoReqIds.isEmpty else { return }
    sampler.photoFailed(reqId: pendingPhotoReqIds.removeFirst(), reason: reason)
  }

  func handleOpenURL(_ url: URL) async {
    #if canImport(MWDATCore)
    await dat?.handleUrl(url)
    #endif
  }

  // MARK: debug helpers (Simulator-degraded path + hour-zero spike)

  /// Simulator: feed a synthetic frame once per second so FrameSampler/CortexSocket can be exercised without
  /// glasses. Only meaningful while armed (the sampler drops everything otherwise); pressing again stops it.
  func startTestFrames() {
    if testFramesRunning { stopTestFrames(); return }
    guard armed else { lastError = "Start the session first"; return }
    testFramesRunning = true
    // Timer's block is @Sendable, so it captures nothing but `self` (a @MainActor class, hence Sendable)
    // and does all its work back on the main actor.
    simulatorFrameTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self else { return }
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1                     // else the renderer draws at screen scale: 3× → 3840×2160, not 1280×720
        let img = UIGraphicsImageRenderer(size: CGSize(width: 1280, height: 720), format: fmt).image { ctx in
          UIColor(hue: CGFloat(Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 10)) / 10, saturation: 0.6, brightness: 0.9, alpha: 1).setFill()
          ctx.fill(CGRect(x: 0, y: 0, width: 1280, height: 720))
          ("TEST FRAME \(Date())" as NSString).draw(at: CGPoint(x: 40, y: 40), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 48), .foregroundColor: UIColor.black])
        }.cgImage
        if let img { self.sampler.offer(img) }
      }
    }
  }

  private func stopTestFrames() {
    simulatorFrameTimer?.invalidate(); simulatorFrameTimer = nil
    testFramesRunning = false
  }

  /// DESIGN.md §5.1 / DESIGN_MAC.md §2.1 hour-zero hardware spike: camera stream + display on ONE DeviceSession —
  /// wait for a real frame, then render a hello-world card. Independent of Cortex, and it owns the DAT session
  /// for its duration, so it refuses to run while a real session is armed.
  func runSpike() async {
    guard !armed, !spikeRunning else { spikeResult = "Stop the session first"; return }
    spikeRunning = true                 // blocks Start and a dashboard-pushed `armed` for the spike's duration
    defer { spikeRunning = false }
    spikeResult = "SPIKE running…"
    #if canImport(MWDATCore)
    guard let dat else { spikeResult = "SPIKE N/A: \(DATSessionManager.configureError ?? "DAT not configured")"; return }
    guard DATSessionManager.isHardwareAvailable else { spikeResult = "SPIKE N/A in Simulator"; return }
    await connectGlasses()              // brings up session + display + camera stream, all of which stay up              // carries the 30 s deadline, so this can never hang the gate
    guard dat.isConnected else {
      spikeResult = "SPIKE FAIL: \(lastError ?? "connect failed") (session=\(dat.sessionState))"
      return
    }
    do { try await dat.startCamera() }
    catch { spikeResult = "SPIKE FAIL: \(error.localizedDescription)"; return }

    let start = Date()
    while dat.rawFrameCount == 0 && Date().timeIntervalSince(start) < 20 { try? await Task.sleep(nanoseconds: 200_000_000) }
    guard dat.rawFrameCount > 0 else { spikeResult = "SPIKE FAIL: no camera frame within 20 s (stream=\(dat.streamState)) \(dat.lastError ?? "")"; return }
    guard let r = renderer else { spikeResult = "SPIKE FAIL: display not attached \(dat.lastError ?? "")"; return }
    r.render(HudCard(cardId: "spike", seq: 1, kind: .hint, title: "Wingman", subtitle: "hello, world",
                     lines: ["camera stream: OK (\(dat.rawFrameCount) frames)", "decoded: \(dat.frameCount)", "display: sent"], footer: "hour-zero spike"))
    try? await Task.sleep(nanoseconds: 3_000_000_000)
    spikeResult = "SPIKE OK: \(dat.rawFrameCount) frames arrived, \(dat.frameCount) decoded + card on lens? (check glasses) display=\(dat.displayState) \(dat.lastError ?? "")"
    #else
    spikeResult = "SPIKE N/A: DAT not linked"
    #endif
  }

  // MARK: display playground (Debug) — DisplayPlayground.swift
  //
  // Flip real cards onto the lens with no Cortex, no session and no network, to judge legibility and pick a
  // HudStyle on hardware. It shares the ONE connection and the ONE renderer with everything else, so a page
  // flip is just a send(); it refuses to run while armed only because it would fight the Cortex cards.

  #if canImport(MWDATDisplay)
  @Published private(set) var playgroundIndex = 0
  @Published var playgroundStyle: HudStyle = .plain
  @Published private(set) var playgroundStatus: String?
  /// So the first press after a Stop shows the CURRENT page rather than skipping one.
  private var playgroundShown = false

  /// delta = +1 / −1.
  func playgroundShow(_ delta: Int) async {
    guard !armed, !spikeRunning else { playgroundStatus = "Stop the session first"; return }
    guard let r = await playgroundRendererReady() else { return }
    r.style = playgroundStyle
    r.clip = false   // fit probes must reach the lens unclipped
    let pages = DisplayPlayground.pages
    if playgroundShown { playgroundIndex = (((playgroundIndex + delta) % pages.count) + pages.count) % pages.count }
    playgroundShown = true
    let page = pages[playgroundIndex]
    r.render(page.card)
    playgroundStatus = "\(playgroundIndex + 1)/\(pages.count) \(page.name) [\(playgroundStyle.rawValue)]"
  }

  /// Page (a), then page (b) 35 s later — past the documented 20 s dim / 25 s sleep (api-notes §6): does a send
  /// wake the lens by itself, or does the wearer have to? Unanswerable without hardware, hence this button.
  func playgroundSleepTest() async {
    guard !armed, !spikeRunning else { playgroundStatus = "Stop the session first"; return }
    guard let r = await playgroundRendererReady() else { return }
    r.style = playgroundStyle
    r.clip = false   // fit probes must reach the lens unclipped
    let pages = DisplayPlayground.pages
    r.render(pages[0].card)
    playgroundStatus = "sleep test: 1st card sent, waiting 35 s…"
    try? await Task.sleep(nanoseconds: 35_000_000_000)
    var next = pages[1].card
    next.seq += 1
    r.render(next)
    playgroundStatus = "sleep test: sent 2nd card after 35 s — did the lens wake?"
  }

  func playgroundClear() async {
    do { try await dat?.display?.clearDisplay(); playgroundStatus = "cleared" }
    catch { playgroundStatus = "clear failed: \(error.localizedDescription)" }
  }

  /// Leaves the lens blank and the renderer back on production settings — the CONNECTION stays up
  /// (disconnecting is what makes iOS re-prompt for the glasses' Wi-Fi network).
  func playgroundStop() async {
    await playgroundClear()
    if let r = renderer?.inner { r.style = .card; r.clip = true }
    playgroundIndex = 0
    playgroundShown = false
    playgroundStatus = "stopped"
  }

  /// Connects on first use (30 s deadline lives in connectGlasses) and hands back the shared renderer.
  private func playgroundRendererReady() async -> HudRenderer? {
    guard let dat else { playgroundStatus = "playground N/A: \(DATSessionManager.configureError ?? "DAT not configured")"; return nil }
    guard DATSessionManager.isHardwareAvailable else { playgroundStatus = "playground N/A in Simulator"; return nil }
    if !dat.isConnected {
      playgroundStatus = "playground: connecting…"
      await connectGlasses()
    }
    guard let r = renderer?.inner else {
      playgroundStatus = "playground: \(lastError ?? "display not attached")"
      return nil
    }
    return r
  }
  #endif
}

/// Thin wrapper so BridgeController compiles when MWDATDisplay is absent (the iOS target always links it, but keep the seam explicit).
final class HudRendererBox {
  #if canImport(MWDATDisplay)
  /// Not private: the Debug playground reaches through to flip `style`/`clip` on the shared renderer.
  let inner: HudRenderer
  init(display: Display, minGapMs: Int) { inner = HudRenderer(display: display, minGapMs: minGapMs) }
  func render(_ card: HudCard) { inner.render(card) }
  func apply(renderMinGapMs: Int) { inner.apply(renderMinGapMs: renderMinGapMs) }
  #else
  func render(_ card: HudCard) {}
  func apply(renderMinGapMs: Int) {}
  #endif
}

/// CortexSocket's heartbeat asks for the battery from its own queue, so the value lives behind a lock rather
/// than on the main actor. BridgeController refreshes it on main from UIDevice's notification.
final class BatteryMonitor: @unchecked Sendable {
  private let lock = NSLock()
  private var level: Double?

  func read() -> Double? { lock.lock(); defer { lock.unlock() }; return level }
  func update(_ value: Double?) { lock.lock(); level = value; lock.unlock() }
}
