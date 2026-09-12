// CortexSocket.swift — device WebSocket to Cortex (DESIGN.md §4.2, §5.1 responsibility 2): hello on open,
// session_start/stop, frames/photos up, cards down, auto-reconnect with backoff, status heartbeat.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/gateway/DeviceGateway.ts — WS upgrade on /ws/device + `?token=<deviceToken>` auth
// CONTRACT: DESIGN.md §4.2 — up: hello, session_start, session_stop, frame, photo, photo_error, status; down: armed, capture_photo, render, session_end, error
// AT-INTEGRATION: INTEGRATION-DAY: swap DEV_HARNESS_URL for CORTEX_WS_URL — BridgeController does this when Config.local.xcconfig holds a real URL and the StatusView "Use DevHarness" toggle is off. Then verify a `hello` with deviceType "glasses_bridge" arrives in Cortex logs after link.
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
  private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
  private var task: URLSessionWebSocketTask?
  private var shouldRun = false
  private var attempts = 0
  private var everConnected = false
  private var heartbeat: DispatchSourceTimer?

  init(url: URL, token: String, deviceType: DeviceType = .glassesBridge,
       caps: DeviceCaps = DeviceCaps(video: true, photoHiRes: true)) {
    var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "token", value: token)]
    self.url = comps.url!
    self.deviceType = deviceType
    self.caps = caps
  }

  // MARK: public (thread-safe)

  func connect() { q.async { self.shouldRun = true; self.open() } }

  func disconnect() {
    q.async { self.shouldRun = false; self.wantsSession = false; self.teardown(); self.set(.disconnected) }
  }

  func startSession() { q.async { self.wantsSession = true; self.sendLocked(.sessionStart) } }
  func stopSession() { q.async { self.wantsSession = false; self.sendLocked(.sessionStop) } }
  func send(_ msg: DeviceToCortex) { q.async { self.sendLocked(msg) } }

  // MARK: internals — everything below runs on q

  private func open() {
    guard shouldRun, task == nil else { return }
    set(.connecting)
    let t = session.webSocketTask(with: url)
    task = t
    t.resume()
    receiveLoop(t)
  }

  /// Frames are ephemeral (DESIGN.md §8): when the socket is down they are dropped, never queued.
  private func sendLocked(_ msg: DeviceToCortex) {
    guard state == .connected, let t = task else { return }
    t.send(.string(Wire.encode(msg))) { [weak self] err in
      if err != nil { self?.q.async { self?.fail() } }
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

  private func fail() {
    guard task != nil else { return }
    teardown()
    set(.disconnected)
    scheduleReconnect()
  }

  private func teardown() {
    heartbeat?.cancel(); heartbeat = nil
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

  private func startHeartbeat() {
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + heartbeatInterval, repeating: heartbeatInterval)
    t.setEventHandler { [weak self] in
      guard let self else { return }
      self.sendLocked(.status(battery: self.batteryProvider?(), note: nil))
      self.task?.sendPing { err in if err != nil { self.q.async { self.fail() } } }
    }
    t.resume()
    heartbeat = t
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
