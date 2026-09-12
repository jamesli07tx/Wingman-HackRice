import XCTest
import Network
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

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

  /// The `session_end` path calls endSession(), which clears wantsSession WITHOUT sending a session_stop —
  /// so a later reconnect must NOT resurrect the ended session by replaying session_start.
  func testStopSessionPreventsSessionStartReplayOnReconnect() throws {
    let port = UInt16.random(in: 20000...40000)
    var server = TestWSServer(port: port); try server.start()
    let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "t")
    sock.maxBackoff = 2
    sock.connect(); sock.startSession()
    XCTAssertTrue(server.wait { self.types($0) == ["hello", "session_start"] }, "got \(server.received)")
    sock.endSession()
    server.stop()
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    XCTAssertTrue(server.wait(timeout: 15) { self.types($0).contains("hello") }, "no reconnect: \(server.received)")
    RunLoop.main.run(until: Date().addingTimeInterval(1))   // give a (wrong) session_start time to show up
    XCTAssertEqual(types(server.received), ["hello", "status"], "replayed session_start: \(server.received)")
    sock.disconnect()
  }

  /// disconnect() must invalidate the URLSession (which retains its delegate) so the socket can deallocate
  /// — a leaked one keeps shouldRun == true and reconnects forever as a zombie device.
  func testDisconnectInvalidatesSessionSoSocketDeallocates() throws {
    let port = UInt16.random(in: 20000...40000)
    let server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    weak var weakSock: CortexSocket?
    do {
      let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "t")
      weakSock = sock
      sock.connect()
      XCTAssertTrue(server.wait { self.types($0) == ["hello"] })
      sock.disconnect()
    }
    let deadline = Date().addingTimeInterval(3)
    while weakSock != nil && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    XCTAssertNil(weakSock, "CortexSocket leaked — URLSession still retains it")
    let connections = server.connectionCount
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    XCTAssertEqual(server.connectionCount, connections, "kept reconnecting after disconnect()")
  }

  func testHeartbeatSendsStatusWithBattery() throws {
    let port = UInt16.random(in: 20000...40000)
    let server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "t")
    sock.heartbeatInterval = 0.2
    sock.batteryProvider = { 0.61 }
    sock.connect()
    XCTAssertTrue(server.wait(timeout: 5) { msgs in
      msgs.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
        .filter { $0["type"] as? String == "status" && $0["battery"] as? Double == 0.61 }
        .count >= 2
    }, "got \(server.received)")
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
