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
}
