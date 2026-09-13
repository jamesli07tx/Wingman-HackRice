// CortexSocket.swift — device WebSocket to Cortex (DESIGN.md §4.2, §5.1 responsibility 2): hello on open,
// session_start/stop, frames/photos up, cards down, auto-reconnect with backoff, status heartbeat.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/gateway/DeviceGateway.ts — WS upgrade on /ws/device + `?token=<deviceToken>` auth
// CONTRACT: DESIGN.md §4.2 — up: hello, session_start, session_stop, frame, photo, photo_error, status; down: armed, capture_photo, render, session_end, error
// AT-INTEGRATION: INTEGRATION-DAY: swap DEV_HARNESS_URL for CORTEX_WS_URL — BridgeController does this when Config.local.xcconfig holds a real URL and the Debug tools "Use DevHarness" toggle is off. Then verify a `hello` with deviceType "glasses_bridge" arrives in Cortex logs after link.
//
// INTEGRATION: CortexSocket
// IN:  send(_:) from FrameSampler (frame/photo/photo_error) and BridgeController (session start/stop); batteryProvider for heartbeats
// OUT: onMessage(CortexToDevice) and onState(State), both on the main queue
// WIRE: CortexSocket(url: <ws url>, token: Keychain.get(Keychain.deviceTokenKey)!); connect() once linked; startSession() on Start

import Foundation

final class CortexSocket: NSObject, URLSessionWebSocketDelegate {
  enum State: Equatable { case disconnected, connecting, connected }

  var onMessage: ((CortexToDevice) -> Void)?
  var onState: ((State) -> Void)?
  var batteryProvider: (() -> Double?)?
  var heartbeatInterval: TimeInterval = 30
  var maxBackoff: TimeInterval = 15

  private(set) var state: State = .disconnected
  /// True between startSession() and stopSession(): session_start is re-sent after every (re)connect.
  private(set) var wantsSession = false

  private let url: URL
  private let deviceType: DeviceType
  private let caps: DeviceCaps
  private let q = DispatchQueue(label: "wingman.cortexsocket")
  /// URLSession retains its delegate (us) until invalidated — so it is created lazily in open() and
  /// invalidated in disconnect()/deinit, otherwise every socket (and its reconnect loop) leaks forever.
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var shouldRun = false
  private var attempts = 0
  private var everConnected = false
  private var heartbeat: DispatchSourceTimer?
  private var frameInFlight = false
  /// Frames skipped because the previous one was still uploading (diagnostic; read from any thread, approximate).
  private(set) var framesDropped = 0

  init(url: URL, token: String, deviceType: DeviceType = .glassesBridge,
       caps: DeviceCaps = DeviceCaps(video: true, photoHiRes: true)) {
    var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "token", value: token)]
    self.url = comps.url!
    self.deviceType = deviceType
    self.caps = caps
  }

  deinit { session?.invalidateAndCancel() }

  // MARK: public (thread-safe)

  func connect() { q.async { self.shouldRun = true; self.open() } }

  /// Full stop: no reconnect, no heartbeat, URLSession invalidated so it stops retaining us.
  /// Backoff and the "reconnected" flag reset too — a later connect() is a fresh first connect.
  func disconnect() {
    q.async {
      self.shouldRun = false
      self.wantsSession = false
      self.attempts = 0
      self.everConnected = false
      self.teardown()
      self.session?.invalidateAndCancel()
      self.session = nil
      self.set(.disconnected)
    }
  }

  func startSession() { q.async { self.wantsSession = true; self.sendLocked(.sessionStart) } }
  func stopSession() { q.async { self.wantsSession = false; self.sendLocked(.sessionStop) } }
  /// Cortex already ended the session: stop replaying session_start on reconnect, but send nothing.
  func endSession() { q.async { self.wantsSession = false } }
  func send(_ msg: DeviceToCortex) { q.async { self.sendLocked(msg) } }

  // MARK: internals — everything below runs on q

  private func open() {
    guard shouldRun, task == nil else { return }
    set(.connecting)
    let s = session ?? URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    session = s
    let t = s.webSocketTask(with: url)
    task = t
    t.resume()
    receiveLoop(t)
  }

  /// Frames are ephemeral (DESIGN.md §8): when the socket is down they are dropped, never queued.
  /// Frames are also latest-wins: while one is still uploading (slow hotspot/cellular leg) a newer frame is
  /// dropped, not queued — a queued frame reaches the gate seconds late, after the wearer has moved on.
  private func sendLocked(_ msg: DeviceToCortex) {
    guard state == .connected, let t = task else { return }
    var isFrame = false
    if case .frame = msg { isFrame = true }
    if isFrame {
      if frameInFlight { framesDropped += 1; return }
      frameInFlight = true
    }
    t.send(.string(Wire.encode(msg))) { [weak self] err in
      guard let self else { return }
      self.q.async {
        if isFrame { self.frameInFlight = false }
        if err != nil { self.fail(t) }
      }
    }
  }

  private func receiveLoop(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] result in
      guard let self else { return }
      self.q.async {
        guard self.task === t else { return }
        switch result {
        case .success(let m):
          if case .string(let s) = m {
            if let msg = try? Wire.decode(s) { DispatchQueue.main.async { self.onMessage?(msg) } }
            else { NSLog("CortexSocket: undecodable message: \(s.prefix(120))") }
          }
          self.receiveLoop(t)
        case .failure:
          self.fail()
        }
      }
    }
  }

  /// Tear down and retry. `t`, when given, is the task the error came from: a stale task's late failure
  /// must never kill the healthy newer connection that replaced it.
  private func fail(_ t: URLSessionWebSocketTask? = nil) {
    guard let current = task else { return }
    if let t, t !== current { return }
    teardown()
    set(.disconnected)
    scheduleReconnect()
  }

  private func teardown() {
    heartbeat?.cancel(); heartbeat = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    frameInFlight = false
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

  private func startHeartbeat() {
    heartbeat?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: q)
    timer.schedule(deadline: .now() + heartbeatInterval, repeating: heartbeatInterval)
    timer.setEventHandler { [weak self] in
      guard let self, let t = self.task else { return }
      self.sendLocked(.status(battery: self.batteryProvider?(), note: nil))
      t.sendPing { [weak self] err in
        guard err != nil, let self else { return }
        self.q.async { self.fail(t) }
      }
    }
    timer.resume()
    heartbeat = timer
  }

  // MARK: URLSessionWebSocketDelegate (called on URLSession's queue → hop to q)

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    q.async {
      guard webSocketTask === self.task else { return }
      let reconnected = self.everConnected
      self.everConnected = true
      self.attempts = 0
      self.set(.connected)
      self.sendLocked(.hello(deviceType: self.deviceType, caps: self.caps))
      if self.wantsSession { self.sendLocked(.sessionStart) }
      if reconnected { self.sendLocked(.status(battery: self.batteryProvider?(), note: "reconnected")) }
      self.startHeartbeat()
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
