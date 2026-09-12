// TestImports.swift — every test file starts with this same #if block (copy it; Swift has no
// re-export). Under `swift test` the module is WingmanCore; under Xcode it is the app, Wingman.
import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

final class SmokeTests: XCTestCase {
  func testConfigPlaceholderIsDefault() {
    // No Info.plist under swift test → defaults → not configured → harness is the default.
    XCTAssertFalse(Config.isCortexConfigured)
  }

  func testIsConfiguredRejectsHostlessAndPlaceholderURLs() throws {
    // `wss:` is what the plist gets when a human writes "wss://host/..." in the xcconfig without
    // the /$()/ trick — xcconfig eats everything after "//" as a comment. URL(string:) accepts it.
    XCTAssertFalse(Config.isConfigured(try XCTUnwrap(URL(string: "wss:"))))
    XCTAssertFalse(Config.isConfigured(try XCTUnwrap(URL(string: "wss://REPLACE-ME.fly.dev/ws/device"))))
    XCTAssertTrue(Config.isConfigured(try XCTUnwrap(URL(string: "wss://x.fly.dev/ws/device"))))
  }
}
