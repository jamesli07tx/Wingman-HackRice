import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

/// Every literal below is the shape shared/src/protocol.ts declares for DESIGN.md §4.3.
final class DashboardEventTests: XCTestCase {

  func testDecodesGate() throws {
    let s = #"{ "type": "gate", "sessionId": "s_42", "frameSeq": 17, "class": "banner", "orgHint": "Anthropic" }"#
    XCTAssertEqual(try Wire.decodeDashboard(s),
                   .gate(sessionId: "s_42", frameSeq: 17, gateClass: .banner, orgHint: "Anthropic"))
  }

  func testDecodesGateWithNullOrgHintAndEveryClass() throws {
    XCTAssertEqual(try Wire.decodeDashboard(#"{ "type": "gate", "sessionId": "s", "frameSeq": 1, "class": "document", "orgHint": null }"#),
                   .gate(sessionId: "s", frameSeq: 1, gateClass: .document, orgHint: nil))
    XCTAssertEqual(try Wire.decodeDashboard(#"{ "type": "gate", "sessionId": "s", "frameSeq": 2, "class": "nothing", "orgHint": null }"#),
                   .gate(sessionId: "s", frameSeq: 2, gateClass: .nothing, orgHint: nil))
  }

  /// A class this build does not know must cost one row's colour, not the whole timeline.
  func testUnknownGateClassDecodesAsNilNotAnError() throws {
    XCTAssertEqual(try Wire.decodeDashboard(#"{ "type": "gate", "sessionId": "s", "frameSeq": 3, "class": "whiteboard", "orgHint": "x" }"#),
                   .gate(sessionId: "s", frameSeq: 3, gateClass: nil, orgHint: "x"))
  }

  func testDecodesSilencedIdentify() throws {
    let s = #"{ "type": "silenced_identify", "sessionId": "s_42", "nameGuess": "Ada Lovelace", "confidence": 0.42 }"#
    XCTAssertEqual(try Wire.decodeDashboard(s),
                   .silencedIdentify(sessionId: "s_42", nameGuess: "Ada Lovelace", confidence: 0.42))
    XCTAssertEqual(try Wire.decodeDashboard(#"{ "type": "silenced_identify", "sessionId": "s", "nameGuess": null, "confidence": 0.1 }"#),
                   .silencedIdentify(sessionId: "s", nameGuess: nil, confidence: 0.1))
    XCTAssertEqual(DashboardEvent.confThreshold, 0.6)   // shared/src/constants.ts CONF_THRESHOLD
  }

  func testDecodesRenderMirroringTheHudCard() throws {
    let s = #"""
    { "type": "render", "sessionId": "s_42", "card": {
      "cardId": "c_007", "seq": 3, "kind": "company", "title": "Stripe", "subtitle": "Payments" } }
    """#
    guard case let .render(sessionId, card) = try Wire.decodeDashboard(s) else { return XCTFail("not render") }
    XCTAssertEqual(sessionId, "s_42")
    XCTAssertEqual(card.title, "Stripe")
    XCTAssertEqual(card.kind, .company)
    XCTAssertEqual(card.seq, 3)
  }

  func testDecodesStatusWithAndWithoutOptionals() throws {
    XCTAssertEqual(try Wire.decodeDashboard(#"{ "type": "status", "sessionId": "s", "battery": 0.61, "note": "reconnected" }"#),
                   .status(sessionId: "s", battery: 0.61, note: "reconnected"))
    XCTAssertEqual(try Wire.decodeDashboard(#"{ "type": "status", "sessionId": "s" }"#),
                   .status(sessionId: "s", battery: nil, note: nil))
  }

  func testDecodesSession() throws {
    XCTAssertEqual(try Wire.decodeDashboard(#"{ "type": "session", "sessionId": "s", "state": "started" }"#),
                   .session(sessionId: "s", state: "started", reason: nil))
    XCTAssertEqual(try Wire.decodeDashboard(#"{ "type": "session", "sessionId": "s", "state": "ended", "reason": "user_stop" }"#),
                   .session(sessionId: "s", state: "ended", reason: .userStop))
  }

  func testUnknownTypeIsIgnoredNotFatal() throws {
    XCTAssertEqual(try Wire.decodeDashboard(#"{ "type": "telemetry_v2", "sessionId": "s" }"#), .unknown(type: "telemetry_v2"))
  }

  /// Cortex may grow fields at any time; a new one must never break a row we already understand.
  func testUnknownFieldsAreTolerated() throws {
    let s = #"{ "type": "gate", "sessionId": "s", "frameSeq": 9, "class": "banner", "orgHint": null, "latencyMs": 120, "model": "gate-v3" }"#
    XCTAssertEqual(try Wire.decodeDashboard(s), .gate(sessionId: "s", frameSeq: 9, gateClass: .banner, orgHint: nil))
  }
}
