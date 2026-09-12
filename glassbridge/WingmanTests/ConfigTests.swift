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

  /// Integration day: whatever shape the URL arrives in, the same pair comes out.
  func testNormalizeOverrideAcceptsEveryPasteShape() {
    for paste in ["wingman-cortex.fly.dev",
                  "https://wingman-cortex.fly.dev",
                  "https://wingman-cortex.fly.dev/",
                  "wss://wingman-cortex.fly.dev/ws/device",
                  "  wingman-cortex.fly.dev  "] {
      let n = Config.normalizeOverride(paste)
      XCTAssertEqual(n?.rest.absoluteString, "https://wingman-cortex.fly.dev", paste)
      XCTAssertEqual(n?.ws.absoluteString, "wss://wingman-cortex.fly.dev/ws/device", paste)
    }
  }

  /// http:// / ws:// stay insecure, and the port survives — a Cortex on the laptop is still dialable.
  func testNormalizeOverrideKeepsInsecureSchemeAndPort() {
    let n = Config.normalizeOverride("http://192.168.1.5:8080")
    XCTAssertEqual(n?.rest.absoluteString, "http://192.168.1.5:8080")
    XCTAssertEqual(n?.ws.absoluteString, "ws://192.168.1.5:8080/ws/device")
    XCTAssertEqual(Config.normalizeOverride("ws://localhost:8787/ws/device")?.ws.absoluteString, "ws://localhost:8787/ws/device")
  }

  func testNormalizeOverrideRejectsGarbage() {
    for junk in ["", "   ", "not a url", "https://", "ftp://wingman-cortex.fly.dev", "cortex", "/ws/device"] {
      XCTAssertNil(Config.normalizeOverride(junk), junk)
    }
  }

  /// The whole point: the pasted URL beats the REPLACE-ME placeholder with no rebuild.
  func testOverrideWinsOverPlaceholder() {
    let saved = Config.cortexOverride
    addTeardownBlock { Config.cortexOverride = saved }

    Config.cortexOverride = nil
    XCTAssertTrue(Config.cortexURL.absoluteString.contains(Config.placeholderHost))
    XCTAssertFalse(Config.isCortexConfigured)

    Config.cortexOverride = "wingman-cortex.fly.dev"
    XCTAssertEqual(Config.cortexOverride, "wingman-cortex.fly.dev")
    XCTAssertEqual(Config.cortexURL.absoluteString, "https://wingman-cortex.fly.dev")
    XCTAssertEqual(Config.cortexWSURL.absoluteString, "wss://wingman-cortex.fly.dev/ws/device")
    XCTAssertTrue(Config.isCortexConfigured)

    Config.cortexOverride = ""            // empty clears it
    XCTAssertNil(Config.cortexOverride)
    XCTAssertTrue(Config.cortexURL.absoluteString.contains(Config.placeholderHost))
  }
}
