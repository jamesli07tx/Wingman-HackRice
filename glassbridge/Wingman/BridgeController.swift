// BridgeController.swift — wires the dumb pipe together (DESIGN.md §5.1's four responsibilities) and owns all
// session state the UI shows. No product logic: it forwards frames up and cards down.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex SessionOrchestrator (armed / capture_photo / render / session_end) + DeviceGateway (WS)
// CONTRACT: DESIGN.md §4.2 message handling; Appendix D via armed.config
// AT-INTEGRATION: on every `armed` this logs "armed.config: compiled=<defaults> received=<config>" — verify the received values win (DESIGN_MAC.md required site for FrameSampler/HudRenderer).
//
// INTEGRATION: BridgeController
// IN:  RootView actions (sign in/resume/links/connect/disconnect/start/stop/spike/toggles); CortexSocket.onMessage; DashboardSocket.onEvent; DATSessionManager.onFrame/onPhoto
// OUT: FrameSampler.offer/handlePhoto, HudRenderer.render, AudioKeepalive.start/stop, published state (including the §4.3 `feed`) for RootView's screens
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
  /// The Cortex-side telemetry timeline (DESIGN.md §4.3), newest first, capped at 200 — the Feed tab.
  @Published private(set) var feed: [FeedItem] = []
  /// This session's tally: what went up, and what Cortex said about it.
  @Published private(set) var gateStats = GateStats()
  @Published private(set) var lastGate: (gateClass: GateClass?, orgHint: String?, at: Date)?
  /// What the DEPLOYED Cortex is prompting the gate with — last `gate_debug` wins, so the Feed's panel
  /// always shows the live prompt rather than whatever this build remembers about it.
  @Published private(set) var gateConfig: (model: String, systemPrompt: String, userText: String)?
  @Published private(set) var dashboardState: DashboardSocket.State = .disconnected
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
  private var dashboard: DashboardSocket?
  /// The last 60 frames we sent, by seq, so a gate event can show the frame it judged and its latency.
  private var sentFrames: [Int: (image: UIImage, at: Date)] = [:]
  private var sentOrder: [Int] = []
  /// The latest gate call per frame seq, capped at 200 (seq only ever grows, so the smallest key is oldest).
  private var gateDebugs: [Int: GateDebug] = [:]
  /// When this armed session's first frame went up — the "no gate results" diagnostic dates from it.
  private var firstFrameAt: Date?
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
    // FrameSampler invokes `send` on ITS OWN serial queue. The socket send happens RIGHT HERE, off-main:
    // CortexSocket is thread-safe, and a main-actor hop would queue every frame behind SwiftUI work
    // (Feed items, lens renders, gate_debug text) — that was the visible "fps stall" after each card.
    // Only the published counters/preview hop to main.
    let s = FrameSampler { [weak self] msg in
      guard let self else { return }
      self.socket?.send(msg)   // `socket` is only replaced on main; a torn read here at worst drops one frame
      // Decode the preview off-main (sampler queue), publish on main.
      var preview: UIImage?
      if case let .frame(_, _, b64) = msg, let d = Data(base64Encoded: b64) { preview = UIImage(data: d) }
      Task { @MainActor in
        switch msg {
        case let .frame(seq, _, _):
          self.framesSent += 1
          self.gateStats.frames += 1
          if self.firstFrameAt == nil { self.firstFrameAt = Date() }
          if let preview { self.lastFrame = preview; self.remember(preview, seq: seq) }
        case let .photo(reqId, b64):
          self.push(.init(kind: .info, title: "capture_photo \(reqId) → photo sent",
                          detail: "\(max(1, b64.count * 3 / 4 / 1024)) KB", tint: .accent))
        case let .photoError(reqId, reason):
          self.push(.init(kind: .info, title: "photo_error \(reqId)", detail: reason, tint: .danger))
        default:
          break
        }
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
    syncDashboard()      // Clerk may already be signed in here, in which case no auth change ever fires
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
    dashboard?.disconnect()
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
    syncDashboard()              // the dashboard always follows the REAL Cortex, never the harness
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
    syncDashboard()              // up on sign-in, down on sign-out
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
      if !isCancellation(error) { profileStatus = error.localizedDescription }
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

  // MARK: fair list import (pre-fair: research every listed company into the corpus)

  @Published private(set) var fairImport: FairImport?
  @Published private(set) var fairBusy = false
  @Published var fairStatus: String?

  func startFairImport(link: String, fairName: String) async {
    await runFairImport(fairName: fairName) { cortex in
      try await cortex.startFairImport(url: link, fairName: fairName)
    }
  }

  func startFairImport(image: Data, filename: String, contentType: String, fairName: String) async {
    await runFairImport(fairName: fairName) { cortex in
      try await cortex.startFairImport(image: image, filename: filename, contentType: contentType, fairName: fairName)
    }
  }

  private func runFairImport(fairName: String, _ start: (CortexClient) async throws -> FairImport) async {
    guard accountReady else { fairStatus = "Sign in first"; return }
    fairBusy = true
    defer { fairBusy = false }
    fairStatus = "Reading the list…"
    do {
      var imp = try await start(cortex)
      fairImport = imp
      // ponytail: poll every 2 s until done; the route has no push channel and imports take ~30 s.
      while !imp.finished {
        try await Task.sleep(nanoseconds: 2_000_000_000)
        imp = try await cortex.fairImport(id: imp.importId)
        fairImport = imp
        fairStatus = "Researching \(imp.done)/\(imp.total)…"
      }
      fairStatus = imp.status == "done"
        ? "Done: \(imp.companies.filter { $0.status == "enriched" }.count) researched, \(imp.companies.filter { $0.status == "matched" }.count) already on file\(imp.reloaded ? " · glasses updated" : "")"
        : "Import failed: \(imp.error ?? "unknown")"
    } catch {
      fairStatus = error.localizedDescription
    }
  }

  /// Pull-to-refresh: every server-backed list, in parallel. Session state is live over the socket already.
  func refreshAll() async {
    guard accountReady else { return }
    // Unstructured on purpose: SwiftUI cancels the `.refreshable` task as soon as a published change re-renders the
    // ScrollView, which aborted the remaining requests with "cancelled". A child Task does not inherit that.
    let work = Task { @MainActor in
      async let p: () = self.refreshProfile()
      async let c: () = self.loadMyCompanies()
      async let f: () = self.refreshFairImport()
      _ = await (p, c, f)
    }
    await work.value
  }

  /// A cancelled request is not an error worth a red banner.
  private func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if case let CortexError.transport(inner) = error, (inner as? URLError)?.code == .cancelled { return true }
    return (error as? URLError)?.code == .cancelled
  }

  // MARK: my company briefs (per user; the shared corpus is never edited from the app)

  @Published private(set) var myCompanies: [MyCompany] = []
  @Published private(set) var briefBusy = false
  @Published var briefStatus: String?

  func loadMyCompanies() async {
    guard accountReady else { return }
    do { myCompanies = try await cortex.myCompanies() } catch { if !isCancellation(error) { briefStatus = error.localizedDescription } }
  }

  /// Returns true on success so the editor can dismiss.
  func saveBrief(companyId: String?, name: String, card: BriefCard) async -> Bool {
    guard accountReady else { briefStatus = "Sign in first"; return false }
    briefBusy = true
    defer { briefBusy = false }
    do {
      let saved = try await cortex.saveCompanyCard(companyId: companyId, name: name, card: card)
      if let i = myCompanies.firstIndex(where: { $0.companyId == saved.companyId }) { myCompanies[i] = saved }
      else { myCompanies.append(saved); myCompanies.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending } }
      briefStatus = "Saved your brief for \(saved.name)"
      return true
    } catch {
      briefStatus = error.localizedDescription
      return false
    }
  }

  func resetBrief(companyId: String) async -> Bool {
    briefBusy = true
    defer { briefBusy = false }
    do {
      try await cortex.resetCompanyCard(companyId: companyId)
      await loadMyCompanies()
      briefStatus = "Back to the shared brief"
      return true
    } catch {
      briefStatus = error.localizedDescription
      return false
    }
  }

  /// Latest import on the server (another phone or the console may have started one).
  func refreshFairImport() async {
    guard accountReady, !fairBusy else { return }
    if let latest = try? await cortex.fairImports().first { fairImport = latest }
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
    let s = CortexSocket(url: wsURL, token: token, policy: .cellularFirst)   // the hotspot Wi-Fi has no internet
    s.onState = { [weak self] st in self?.socketState = st }
    s.onMessage = { [weak self] m in self?.handle(m) }
    s.batteryProvider = { [battery] in battery.read() }   // heartbeat runs on the socket's queue, never on main
    s.connect()
    socket = s
  }

  // MARK: feed (DESIGN.md §4.3) — one timeline of what we sent and what Cortex made of it

  private func push(_ item: FeedItem) {
    feed.insert(item, at: 0)
    if feed.count > 200 { feed.removeLast(feed.count - 200) }
  }

  /// Ring buffer, 60 frames ≈ 105 s at the default cadence — long enough for any gate round trip.
  private func remember(_ image: UIImage, seq: Int) {
    sentFrames[seq] = (image, Date())
    sentOrder.append(seq)
    while sentOrder.count > 60 { sentFrames.removeValue(forKey: sentOrder.removeFirst()) }
  }

  /// One Feed row per judged frame: `gate` and `gate_debug` arrive in either order, and the second one
  /// must land on the row the first one made instead of pushing a twin.
  private func gateRow(_ frameSeq: Int, _ apply: (inout FeedItem) -> Void) {
    if let i = feed.firstIndex(where: { $0.kind == .gate && $0.frameSeq == frameSeq }) { return apply(&feed[i]) }
    let sent = sentFrames[frameSeq]
    var item = FeedItem(kind: .gate, frameSeq: frameSeq, thumbnail: sent?.image, title: "gate",
                        detail: sent.map { String(format: "%.1f s", -$0.at.timeIntervalSinceNow) }, tint: .muted)
    apply(&item)
    push(item)
  }

  /// Mean gate latency over the last 20 calls — the panel's one number for "is the gate keeping up?".
  var gateLatencyAvgMs: Int? {
    let recent = gateDebugs.keys.sorted().suffix(20).compactMap { gateDebugs[$0]?.latencyMs }
    return recent.isEmpty ? nil : recent.reduce(0, +) / recent.count
  }

  func clearFeed() {
    feed.removeAll()
    gateStats = GateStats()
    lastGate = nil
    gateDebugs.removeAll()
  }

  /// Frames are going up and nothing is coming back — the one diagnosis the Feed exists to make.
  /// Recomputed on every publish (a frame ticks ~every 1.75 s), so it needs no timer of its own.
  var gateSilent: Bool {
    guard armed, gateStats.frames >= 5, gateStats.gated == 0, let since = firstFrameAt else { return false }
    return -since.timeIntervalSinceNow > 10
  }

  // MARK: dashboard socket (DESIGN.md §4.3) — read-only, and independent of Start/Stop
  //
  // Alive for as long as the sign-in is: gate telemetry is how you learn Cortex is NOT seeing what you
  // send, and that is exactly the moment nobody has pressed Start yet. Always the REAL Cortex — the
  // DevHarness serves no /ws/dashboard.

  /// The device socket URL with its path swapped: wss://host/ws/device → wss://host/ws/dashboard.
  static var dashboardURL: URL? {
    var c = URLComponents(url: Config.cortexWSURL, resolvingAgainstBaseURL: false)
    c?.path = "/ws/dashboard"
    c?.query = nil
    return c?.url
  }

  private func syncDashboard() {
    dashboard?.disconnect(); dashboard = nil
    dashboardState = .disconnected
    guard auth.isSignedIn, Config.isCortexConfigured, let url = Self.dashboardURL else { return }
    let d = DashboardSocket(url: url, tokenProvider: { [auth] in try await auth.token() }, policy: .cellularFirst)
    d.onState = { [weak self] s in self?.dashboardState = s }
    d.onEvent = { [weak self] e in self?.handleDashboard(e) }
    d.connect()
    dashboard = d
  }

  private func handleDashboard(_ event: DashboardEvent) {
    switch event {
    case let .gate(_, frameSeq, gateClass, orgHint):
      gateStats.gated += 1
      switch gateClass {
      case .banner: gateStats.banner += 1
      case .document: gateStats.document += 1
      case .nothing, nil: gateStats.nothing += 1
      }
      lastGate = (gateClass, orgHint, Date())
      gateRow(frameSeq) {
        $0.title = [gateClass?.rawValue ?? "unknown", orgHint].compactMap { $0 }.joined(separator: " · ")
        $0.tint = FeedTint(gateClass)
      }
    case let .gateDebug(debug):
      gateDebugs[debug.frameSeq] = debug
      if gateDebugs.count > 200, let oldest = gateDebugs.keys.min() { gateDebugs.removeValue(forKey: oldest) }
      gateConfig = (debug.model, debug.systemPrompt, debug.userText)
      if debug.rawResponse == nil { gateStats.empty += 1 }
      if debug.error != nil { gateStats.errors += 1 }
      gateRow(debug.frameSeq) { row in
        row.gateDebug = debug
        // A verdict only ever reaches us once, so this either fills a row `gate` has not reached yet or repeats it.
        if let gateClass = debug.result?.gateClass {
          row.title = [gateClass.rawValue, debug.result?.orgHint].compactMap { $0 }.joined(separator: " · ")
          row.tint = FeedTint(gateClass)
        }
      }
    case let .silencedIdentify(_, nameGuess, confidence):
      push(FeedItem(kind: .identify,
                    title: "Guess: \(nameGuess ?? "unknown") · \(percent(confidence)) · silenced (< \(percent(DashboardEvent.confThreshold)))",
                    detail: "below threshold — nothing reached the lens", tint: .warn))
    case let .render(_, card):
      push(FeedItem(kind: .render, title: "→ lens: \(card.kind.rawValue) · \(card.title) (#\(card.seq))",
                    detail: card.subtitle, tint: .accent))
    case let .session(_, state, reason):
      push(FeedItem(kind: .session, title: "session \(state)", detail: reason?.rawValue,
                    tint: state == "started" ? .ok : .muted))
    case let .status(_, battery, note):
      let parts = [battery.map { "battery \(percent($0))" }, note].compactMap { $0 }
      push(FeedItem(kind: .status, title: "status", detail: parts.isEmpty ? nil : parts.joined(separator: " · "),
                    tint: .muted))
    case let .unknown(type):
      push(FeedItem(kind: .info, title: "unknown event: \(type)", tint: .muted))
    }
  }

  private func percent(_ v: Double) -> String { "\(Int((v * 100).rounded()))%" }

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

  /// Always allowed: stops an armed session first and cancels any connect/reconnect in flight (a hanging
  /// hotspot join otherwise greys the button out for up to 3 × 30 s).
  func disconnectGlasses() {
    if armed { stop() }
    armTask?.cancel(); armTask = nil
    glassesConnecting = false
    reconnecting = false
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
    push(FeedItem(kind: .info, title: "session_start sent", tint: .ok))
  }

  func stop() {
    socket?.stopSession()
    push(FeedItem(kind: .info, title: "session_stop sent", tint: .muted))
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
    gateStats = GateStats()
    firstFrameAt = nil
    push(FeedItem(kind: .info, title: "armed \(newSessionId)",
                  detail: "every \(cfg.frameIntervalMs) ms · \(cfg.frameMaxEdgePx) px · render gap \(cfg.renderMinGapMs) ms",
                  tint: .ok))
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
    firstFrameAt = nil
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
      push(FeedItem(kind: .info, title: code.rawValue, detail: message, tint: .danger))
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

/// One row of the Feed tab: a local event we caused, or a DashboardEvent Cortex published about it.
struct FeedItem: Identifiable {
  enum Kind { case gate, identify, render, session, status, info }

  let id = UUID()
  var time = Date()
  var kind: Kind
  /// Set on gate rows — the frame Cortex judged, which is also how the thumbnail was found.
  var frameSeq: Int?
  var thumbnail: UIImage?
  var title: String
  var detail: String?
  var tint: FeedTint
  /// Gate rows only: the prompt/response behind the verdict, once `gate_debug` arrives. Drives the expansion.
  var gateDebug: GateDebug?
}

/// Row accent, resolved to a Theme colour by FeedView (this file knows nothing about SwiftUI).
enum FeedTint { case accent, warn, muted, ok, danger

  init(_ gateClass: GateClass?) {
    switch gateClass {
    case .banner: self = .accent
    case .document: self = .warn
    default: self = .muted
    }
  }
}

/// What went up this session, and what Cortex made of it.
struct GateStats: Equatable {
  var frames = 0
  var gated = 0
  var banner = 0
  var document = 0
  var nothing = 0
  /// gate_debug with no rawResponse — the model burned its budget and said nothing.
  var empty = 0
  var errors = 0
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
