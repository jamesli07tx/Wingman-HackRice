// DashboardSocket.swift — the read-only dashboard WebSocket (DESIGN.md §4.3), on the phone. Same
// mission-control stream the console's /feed drinks from: every render and status mirrored, plus the
// gate class per frame and the identifications the lens silenced. Nothing is ever sent up.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/dashboard/DashboardHub.ts — WS upgrade on /ws/dashboard + `?token=<Clerk JWT>`
// CONTRACT: DESIGN.md §4.3 — DashboardEvent (render / status / gate / silenced_identify / session)
// AT-INTEGRATION: sign in, open the Feed tab: the pill must read "live" and gate rows must tick once
//   per sent frame. Nothing here ever sends — the hub ignores inbound frames by design.
//
// INTEGRATION: DashboardSocket
// IN:  a Clerk JWT from tokenProvider (asked FRESH on every (re)connect — Clerk tokens are ~1 min)
// OUT: onEvent(DashboardEvent) and onState(State), both on the main queue
// WIRE: BridgeController.syncDashboard() — alive whenever signed in + Cortex configured, independent of Start/Stop

import Foundation

final class DashboardSocket {
  enum State: Equatable { case disconnected, connecting, connected }

  var onEvent: ((DashboardEvent) -> Void)?
  var onState: ((State) -> Void)?
  var maxBackoff: TimeInterval = 15

  private(set) var state: State = .disconnected

  private let url: URL
  private let tokenProvider: () async throws -> String
  private let q = DispatchQueue(label: "wingman.dashboardsocket")
  private let policy: WSTransport.Policy
  private var task: WSTransport?
  private var shouldRun = false
  /// A token fetch is in flight — without this a second open() would mint a second socket.
  private var opening = false
  private var attempts = 0

  init(url: URL, tokenProvider: @escaping () async throws -> String, policy: WSTransport.Policy = .any) {
    self.policy = policy
    self.url = url
    self.tokenProvider = tokenProvider
  }

  deinit { task?.cancel() }

  // MARK: public (thread-safe)

  func connect() { q.async { self.shouldRun = true; self.open() } }

  func disconnect() {
    q.async {
      self.shouldRun = false
      self.attempts = 0
      self.teardown()
      self.set(.disconnected)
    }
  }

  // MARK: internals — everything below runs on q, except the token fetch

  private func open() {
    guard shouldRun, task == nil, !opening else { return }
    opening = true
    set(.connecting)
    // A Clerk JWT lives ~1 minute, so it is fetched per (re)connect and never cached here.
    Task { [weak self] in
      guard let self else { return }
      do {
        // Clerk's token refresh can stall on a bad network and would leave us "connecting" forever — bound it.
        let token = try await withDeadline(seconds: 10) { try await self.tokenProvider() }
        self.q.async { self.opening = false; self.start(token: token) }
      } catch {
        NSLog("DashboardSocket: token failed: \(error.localizedDescription)")
        self.q.async {
          self.opening = false
          self.set(.disconnected)
          self.scheduleReconnect()
        }
      }
    }
  }

  private func start(token: String) {
    guard shouldRun, task == nil else { return }
    var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    comps.queryItems = [URLQueryItem(name: "token", value: token)]
    guard let dialed = comps.url else { return }
    // WSTransport bounds the handshake itself (a hotspot/CloudFront hiccup can leave an upgrade pending).
    let t = WSTransport(url: dialed, queue: q, policy: policy, attempt: attempts)
    task = t
    t.onOpen = { [weak self] in
      guard let self, self.task === t else { return }
      self.attempts = 0
      self.set(.connected)
      self.startKeepalive()
    }
    t.onText = { [weak self] text in
      guard let self, self.task === t else { return }
      if let event = try? Wire.decodeDashboard(text) { DispatchQueue.main.async { self.onEvent?(event) } }
      else { NSLog("DashboardSocket: undecodable event: \(text.prefix(120))") }
    }
    t.onClose = { [weak self] err in
      guard let self, self.task === t else { return }
      if let err { NSLog("DashboardSocket: closed (cellularOnly=\(t.cellularOnly)): \(err)") }
      self.fail(t)
    }
    t.start()
  }

  /// `t`, when given, is the task the error came from: a stale task's late failure must never kill
  /// the healthy newer connection that replaced it.
  private func fail(_ t: WSTransport? = nil) {
    guard let current = task else { return }
    if let t, t !== current { return }
    teardown()
    set(.disconnected)
    scheduleReconnect()
  }

  private func teardown() {
    keepalive?.cancel(); keepalive = nil
    task?.cancel()
    task = nil
  }

  /// CloudFront closes idle WebSockets after 60 s and this socket only receives, so ping every 20 s.
  private var keepalive: DispatchSourceTimer?
  private func startKeepalive() {
    keepalive?.cancel()
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + 20, repeating: 20)
    t.setEventHandler { [weak self] in
      guard let self, let task = self.task else { return }
      task.ping { [weak self] err in if err != nil { self?.fail(task) } }
    }
    t.resume()
    keepalive = t
  }

  private func scheduleReconnect() {
    guard shouldRun else { return }
    let delay = min(maxBackoff, pow(2.0, Double(attempts))) + Double.random(in: 0...0.5)   // 1, 2, 4, 8, 15, 15…
    attempts += 1
    q.asyncAfter(deadline: .now() + delay) { self.open() }
  }

  private func set(_ s: State) {
    guard s != state else { return }
    state = s
    DispatchQueue.main.async { self.onState?(s) }
  }

}

/// Race an async operation against a deadline; throws `DeadlineError` when the deadline wins.
struct DeadlineError: Error {}
func withDeadline<T: Sendable>(seconds: Double, _ op: @escaping @Sendable () async throws -> T) async throws -> T {
  try await withThrowingTaskGroup(of: T.self) { group in
    group.addTask { try await op() }
    group.addTask { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)); throw DeadlineError() }
    let first = try await group.next()!
    group.cancelAll()
    return first
  }
}
