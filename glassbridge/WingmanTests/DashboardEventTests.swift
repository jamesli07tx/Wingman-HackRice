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

  // MARK: gate_debug — the exact prompt in, the exact text out

  func testDecodesGateDebug() throws {
    let s = #"""
    { "type": "gate_debug", "sessionId": "s_1", "frameSeq": 17, "model": "claude-opus-5",
      "systemPrompt": "You judge one frame.", "userText": "Classify this frame.",
      "rawResponse": "{\"class\":\"nothing\",\"orgHint\":null}", "stopReason": "end_turn",
      "inputTokens": 918, "outputTokens": 22, "latencyMs": 2310, "error": null,
      "result": { "class": "banner", "orgHint": "Stripe" } }
    """#
    guard case let .gateDebug(d) = try Wire.decodeDashboard(s) else { return XCTFail("not gate_debug") }
    XCTAssertEqual(d.sessionId, "s_1")
    XCTAssertEqual(d.frameSeq, 17)
    XCTAssertEqual(d.model, "claude-opus-5")
    XCTAssertEqual(d.systemPrompt, "You judge one frame.")
    XCTAssertEqual(d.userText, "Classify this frame.")
    XCTAssertEqual(d.rawResponse, #"{"class":"nothing","orgHint":null}"#)
    XCTAssertEqual(d.stopReason, "end_turn")
    XCTAssertEqual(d.inputTokens, 918)
    XCTAssertEqual(d.outputTokens, 22)
    XCTAssertEqual(d.latencyMs, 2310)
    XCTAssertNil(d.error)
    XCTAssertEqual(d.result?.gateClass, .banner)
    XCTAssertEqual(d.result?.orgHint, "Stripe")
    XCTAssertEqual(d.summary, "claude-opus-5 · 2.3 s · 918→22 tok · end_turn")
    XCTAssertNil(d.note)
  }

  /// Every nullable field null: the timeout/no-answer shape, which is the whole point of the event.
  func testDecodesGateDebugWithEveryNullableFieldNull() throws {
    let s = #"""
    { "type": "gate_debug", "sessionId": "s_1", "frameSeq": 4, "model": "claude-opus-5",
      "systemPrompt": "p", "userText": "u", "rawResponse": null, "stopReason": null,
      "inputTokens": null, "outputTokens": null, "latencyMs": 4000, "error": null, "result": null }
    """#
    guard case let .gateDebug(d) = try Wire.decodeDashboard(s) else { return XCTFail("not gate_debug") }
    XCTAssertNil(d.rawResponse)
    XCTAssertNil(d.stopReason)
    XCTAssertNil(d.inputTokens)
    XCTAssertNil(d.outputTokens)
    XCTAssertNil(d.error)
    XCTAssertNil(d.result)
    XCTAssertEqual(d.summary, "claude-opus-5 · 4.0 s")
    XCTAssertEqual(d.note, "no JSON returned (stop: unknown)")

    let maxTokens = #"{ "type": "gate_debug", "frameSeq": 5, "latencyMs": 4000, "stopReason": "max_tokens", "error": "gate timeout after 4000ms" }"#
    guard case let .gateDebug(t) = try Wire.decodeDashboard(maxTokens) else { return XCTFail("not gate_debug") }
    XCTAssertEqual(t.note, "gate timeout after 4000ms")   // the error wins over the generic no-JSON note
  }

  /// Cortex grows fields (and classes) without asking us; neither may cost us the event.
  func testGateDebugToleratesUnknownFieldsAndClasses() throws {
    let s = #"""
    { "type": "gate_debug", "sessionId": "s_1", "frameSeq": 9, "model": "m", "systemPrompt": "p",
      "userText": "u", "rawResponse": "{}", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 2,
      "latencyMs": 10, "thinkingTokens": 900, "cacheReadTokens": 12,
      "result": { "class": "whiteboard", "orgHint": null, "why": "new" } }
    """#
    guard case let .gateDebug(d) = try Wire.decodeDashboard(s) else { return XCTFail("not gate_debug") }
    XCTAssertEqual(d.frameSeq, 9)
    XCTAssertNil(d.result?.gateClass)   // unknown class degrades to nil, never an error
    XCTAssertNil(d.result?.orgHint)
    XCTAssertEqual(d.summary, "m · 0.0 s · 1→2 tok · end_turn")
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
