import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

final class ConfigTests: XCTestCase {
  func testHttpOriginFromWsURL() {
    XCTAssertEqual(Config.httpOrigin(of: URL(string: "ws://192.168.1.23:8787/ws/device")!).absoluteString, "http://192.168.1.23:8787")
    XCTAssertEqual(Config.httpOrigin(of: URL(string: "wss://wingman-cortex.fly.dev/ws/device")!).absoluteString, "https://wingman-cortex.fly.dev")
  }
}
