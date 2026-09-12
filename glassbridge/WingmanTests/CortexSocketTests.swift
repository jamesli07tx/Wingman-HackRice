import XCTest
import Network
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

/// Tiny WS echo-less server: records text frames it receives, can push text frames, can be killed.
final class TestWSServer {
  let port: UInt16
  private var listener: NWListener?
  private var conns: [NWConnection] = []
  private let lock = NSLock()
  private var _received: [String] = []
  var received: [String] { lock.lock(); defer { lock.unlock() }; return _received }
  var connectionCount = 0

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
    lock.lock(); conns.append(c); connectionCount += 1; lock.unlock()
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

final class CortexSocketTests: XCTestCase {
  private func types(_ msgs: [String]) -> [String] {
    msgs.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])?["type"] as? String }
  }

  func testHandshakeSendsHelloThenSessionStartAndAppendsToken() throws {
    let port = UInt16.random(in: 20000...40000)
    let server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "tok123")
    sock.connect(); sock.startSession()
    XCTAssertTrue(server.wait { self.types($0) == ["hello", "session_start"] }, "got \(server.received)")
    let hello = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(server.received[0].utf8)) as? [String: Any])
    XCTAssertEqual(hello["deviceType"] as? String, "glasses_bridge")
    XCTAssertEqual((hello["caps"] as? [String: Any])?["video"] as? Bool, true)
    sock.disconnect()
  }

  func testDeliversDecodedMessagesOnMain() throws {
    let port = UInt16.random(in: 20000...40000)
    let server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "t")
    let exp = expectation(description: "armed")
    var got: CortexToDevice?
    sock.onMessage = { m in XCTAssertTrue(Thread.isMainThread); got = m; exp.fulfill() }
    sock.connect()
    XCTAssertTrue(server.wait { !$0.isEmpty })
    server.sendText(#"{ "type": "armed", "sessionId": "s_42" }"#)
    wait(for: [exp], timeout: 5)
    XCTAssertEqual(got, .armed(sessionId: "s_42", config: nil))
    sock.disconnect()
  }

  /// DESIGN_MAC.md §2.3: kill/restart the harness → socket reconnects and re-sends session_start.
  func testReconnectsAfterServerRestartAndResendsSessionStart() throws {
    let port = UInt16.random(in: 20000...40000)
    var server = TestWSServer(port: port); try server.start()
    let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "t")
    sock.maxBackoff = 2
    var states: [CortexSocket.State] = []
    sock.onState = { states.append($0) }
    sock.connect(); sock.startSession()
    XCTAssertTrue(server.wait { self.types($0) == ["hello", "session_start"] })
    server.stop()
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    XCTAssertTrue(server.wait(timeout: 15) { self.types($0).contains("session_start") }, "no reconnect: \(server.received)")
    let t = types(server.received)
    XCTAssertEqual(t.prefix(2), ["hello", "session_start"])
    XCTAssertTrue(t.contains("status"), "expected a status note=reconnected, got \(t)")
    XCTAssertTrue(server.received.contains { $0.contains("\"reconnected\"") })
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    XCTAssertTrue(states.contains(.disconnected), "states: \(states)")
    sock.disconnect()
  }

  func testSendWhileDisconnectedIsDroppedNotQueued() throws {
    let port = UInt16.random(in: 20000...40000)
    let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "t")
    sock.send(.frame(seq: 1, ts: 0, dataBase64: ""))     // no server, no connect → must not crash, must not queue
    let server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    sock.connect()
    XCTAssertTrue(server.wait { self.types($0) == ["hello"] })
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    XCTAssertEqual(types(server.received), ["hello"])
    sock.disconnect()
  }
}
