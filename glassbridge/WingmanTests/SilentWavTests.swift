import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

final class SilentWavTests: XCTestCase {
  func testSilentWavIsValidPcmHeaderAndAllZeros() throws {
    let d = try Data(contentsOf: SilentWav.url())
    XCTAssertEqual(d.count, 44 + 16000)                                   // 1 s @ 8 kHz, mono, 16-bit
    XCTAssertEqual(String(decoding: d[0..<4], as: UTF8.self), "RIFF")
    XCTAssertEqual(String(decoding: d[8..<12], as: UTF8.self), "WAVE")
    XCTAssertEqual(String(decoding: d[36..<40], as: UTF8.self), "data")
    XCTAssertTrue(d[44...].allSatisfy { $0 == 0 })
  }
}
