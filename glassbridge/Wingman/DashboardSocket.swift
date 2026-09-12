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

final class DashboardSocket: NSObject, URLSessionWebSocketDelegate {
  enum State: Equatable { case disconnected, connecting, connected }

  var onEvent: ((DashboardEvent) -> Void)?
  var onState: ((State) -> Void)?
  var maxBackoff: TimeInterval = 15

  private(set) var state: State = .disconnected

  private let url: URL
  private let tokenProvider: () async throws -> String
  private let q = DispatchQueue(label: "wingman.dashboardsocket")
  /// URLSession retains its delegate (us) until invalidated — created lazily, invalidated in
  /// disconnect()/deinit, or every socket and its reconnect loop leaks forever (same as CortexSocket).
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var shouldRun = false
  /// A token fetch is in flight — without this a second open() would mint a second socket.
  private var opening = false
  private var attempts = 0

  init(url: URL, tokenProvider: @escaping () async throws -> String) {
    self.url = url
    self.tokenProvider = tokenProvider
  }

  deinit { session?.invalidateAndCancel() }

  // MARK: public (thread-safe)

  func connect() { q.async { self.shouldRun = true; self.open() } }

  func disconnect() {
    q.async {
      self.shouldRun = false
      self.attempts = 0
      self.teardown()
      self.session?.invalidateAndCancel()
      self.session = nil
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
        let token = try await self.tokenProvider()
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
    let s = session ?? URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    session = s
    let t = s.webSocketTask(with: dialed)
    task = t
    t.resume()
    receiveLoop(t)
  }

  private func receiveLoop(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] result in
      guard let self else { return }
      self.q.async {
        guard self.task === t else { return }
        switch result {
        case .success(let m):
          if case .string(let s) = m {
            if let event = try? Wire.decodeDashboard(s) { DispatchQueue.main.async { self.onEvent?(event) } }
            else { NSLog("DashboardSocket: undecodable event: \(s.prefix(120))") }
          }
          self.receiveLoop(t)
        case .failure:
          self.fail()
        }
      }
    }
  }

  /// `t`, when given, is the task the error came from: a stale task's late failure must never kill
  /// the healthy newer connection that replaced it.
  private func fail(_ t: URLSessionWebSocketTask? = nil) {
    guard let current = task else { return }
    if let t, t !== current { return }
    teardown()
    set(.disconnected)
    scheduleReconnect()
  }

  private func teardown() {
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
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

  // MARK: URLSessionWebSocketDelegate (called on URLSession's queue → hop to q)

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    q.async {
      guard webSocketTask === self.task else { return }
      self.attempts = 0
      self.set(.connected)
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                  didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    q.async { guard webSocketTask === self.task else { return }; self.fail() }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    q.async { guard task === self.task else { return }; self.fail() }
  }
}
