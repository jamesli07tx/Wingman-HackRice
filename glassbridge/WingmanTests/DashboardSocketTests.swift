import XCTest
import Network
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

final class DashboardSocketTests: XCTestCase {
  /// The token provider runs off the test thread (it is awaited in a Task), so the tally is locked.
  private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.lock(); n += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
  }

  func testDeliversGateEventsOnMain() throws {
    let port = UInt16.random(in: 20000...40000)
    let server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    let sock = DashboardSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/dashboard")!, tokenProvider: { "jwt" })
    let exp = expectation(description: "gate")
    var got: DashboardEvent?
    sock.onEvent = { e in XCTAssertTrue(Thread.isMainThread); got = e; exp.fulfill() }
    sock.connect()
    XCTAssertTrue(waitUntil { server.connectionCount >= 1 }, "never connected")
    // Read-only mirror: the hub pushes, the client never speaks.
    server.sendText(#"{ "type": "gate", "sessionId": "s_42", "frameSeq": 17, "class": "banner", "orgHint": "Anthropic" }"#)
    wait(for: [exp], timeout: 5)
    XCTAssertEqual(got, .gate(sessionId: "s_42", frameSeq: 17, gateClass: .banner, orgHint: "Anthropic"))
    XCTAssertTrue(server.received.isEmpty, "sent something to a read-only socket: \(server.received)")
    sock.disconnect()
  }

  /// Kill/restart Cortex → the socket comes back, with a FRESH Clerk JWT (they expire in about a minute).
  func testReconnectsAndAsksForAFreshTokenEveryTime() throws {
    let port = UInt16.random(in: 20000...40000)
    var server = TestWSServer(port: port); try server.start()
    let tokens = Counter()
    let sock = DashboardSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/dashboard")!,
                               tokenProvider: { tokens.bump(); return "jwt" })
    sock.maxBackoff = 2
    var states: [DashboardSocket.State] = []
    sock.onState = { states.append($0) }
    sock.connect()
    XCTAssertTrue(waitUntil { server.connectionCount >= 1 }, "never connected")
    server.stop()
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    XCTAssertTrue(waitUntil(timeout: 20) { server.connectionCount >= 1 }, "no reconnect")
    XCTAssertTrue(waitUntil(timeout: 5) { tokens.value >= 2 }, "reused a stale token: \(tokens.value) fetches")
    XCTAssertTrue(states.contains(.disconnected), "states: \(states)")
    XCTAssertTrue(waitUntil(timeout: 5) { sock.state == .connected }, "states: \(states)")
    sock.disconnect()
  }
}
