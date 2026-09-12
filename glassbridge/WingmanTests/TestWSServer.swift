// TestWSServer.swift — the local WebSocket server both socket test suites dial (CortexSocketTests,
// DashboardSocketTests). Lives on its own so neither suite owns it.
import XCTest
import Network

/// Tiny WS echo-less server: records text frames it receives, can push text frames, can be killed.
final class TestWSServer {
  let port: UInt16
  private var listener: NWListener?
  private var conns: [NWConnection] = []
  private let lock = NSLock()
  private var _received: [String] = []
  var received: [String] { lock.lock(); defer { lock.unlock() }; return _received }
  private var _connectionCount = 0
  var connectionCount: Int { lock.lock(); defer { lock.unlock() }; return _connectionCount }

  init(port: UInt16) { self.port = port }

  func start() throws {
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    let ws = NWProtocolWebSocket.Options()
    ws.autoReplyPing = true
    params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
    let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
    let ready = DispatchSemaphore(value: 0)
    l.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
    l.newConnectionHandler = { [weak self] c in self?.accept(c) }
    l.start(queue: .global())
    XCTAssertEqual(ready.wait(timeout: .now() + 5), .success)
    listener = l
  }

  private func accept(_ c: NWConnection) {
    lock.lock(); conns.append(c); _connectionCount += 1; lock.unlock()
    c.start(queue: .global())
    receive(c)
  }

  private func receive(_ c: NWConnection) {
    c.receiveMessage { [weak self] data, _, _, error in
      guard let self else { return }
      if let d = data, let s = String(data: d, encoding: .utf8) { self.lock.lock(); self._received.append(s); self.lock.unlock() }
      if error == nil { self.receive(c) }
    }
  }

  func sendText(_ s: String) {
    let md = NWProtocolWebSocket.Metadata(opcode: .text)
    let ctx = NWConnection.ContentContext(identifier: "text", metadata: [md])
    lock.lock(); let cs = conns; lock.unlock()
    for c in cs { c.send(content: s.data(using: .utf8), contentContext: ctx, isComplete: true, completion: .idempotent) }
  }

  func stop() {
    lock.lock(); let cs = conns; conns = []; lock.unlock()
    cs.forEach { $0.cancel() }
    listener?.cancel(); listener = nil
  }

  /// Poll until `received` satisfies the predicate.
  @discardableResult
  func wait(timeout: TimeInterval = 10, until pred: ([String]) -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if pred(received) { return true }
      RunLoop.main.run(until: Date().addingTimeInterval(0.05))   // pump so onState/onMessage (main queue) run
    }
    return pred(received)
  }
}

/// Pump the main run loop until `pred` holds — onState/onEvent land on the main queue, so a plain
/// sleep would never see them.
@discardableResult
func waitUntil(timeout: TimeInterval = 10, _ pred: () -> Bool) -> Bool {
  let end = Date().addingTimeInterval(timeout)
  while Date() < end {
    if pred() { return true }
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
  }
  return pred()
}
