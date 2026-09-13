import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

/// Every JSON literal below is copied verbatim from DESIGN.md §4.2 / §4.1.
final class ProtocolTests: XCTestCase {

  private func json(_ s: String) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any])
  }

  // MARK: Cortex → Device (decode, lenient)

  func testDecodesArmedWithConfig() throws {
    let s = #"{ "type": "armed", "sessionId": "s_42", "config": { "frameIntervalMs": 1750, "frameMaxEdgePx": 1280, "docMaxEdgePx": 2048, "renderMinGapMs": 500 } }"#
    XCTAssertEqual(try Wire.decode(s), .armed(sessionId: "s_42", config: ArmedConfig(frameIntervalMs: 1750, frameMaxEdgePx: 1280, docMaxEdgePx: 2048, renderMinGapMs: 500)))
  }

  func testDecodesArmedWithoutConfigFallsBackToNil() throws {
    XCTAssertEqual(try Wire.decode(#"{ "type": "armed", "sessionId": "s_42" }"#), .armed(sessionId: "s_42", config: nil))
    XCTAssertEqual(ArmedConfig.defaults, ArmedConfig(frameIntervalMs: 1000, frameMaxEdgePx: 1024, docMaxEdgePx: 2048, renderMinGapMs: 500))
  }

  func testDecodesCapturePhoto() throws {
    XCTAssertEqual(try Wire.decode(#"{ "type": "capture_photo", "reqId": "r_18", "quality": "document" }"#), .capturePhoto(reqId: "r_18", quality: "document"))
  }

  func testDecodesRenderWithFullHudCard() throws {
    let s = #"""
    { "type": "render", "card": {
      "cardId": "c_007", "seq": 3, "kind": "company", "title": "Stripe",
      "subtitle": "Payments infrastructure for the internet",
      "lines": [ "Hiring: SWE Intern, New Grad Backend", "Stack: Ruby, Go, ML infra at scale", "Recently: launched usage-based billing APIs" ],
      "footer": "Wingman · 1/2", "page": { "index": 1, "count": 2 }, "streaming": false,
      "company": { "companyId": "stripe", "confidence": 0.93 }, "minDisplaySec": 15 } }
    """#
    guard case let .render(card) = try Wire.decode(s) else { return XCTFail("not render") }
    XCTAssertEqual(card.cardId, "c_007"); XCTAssertEqual(card.seq, 3); XCTAssertEqual(card.kind, .company)
    XCTAssertEqual(card.title, "Stripe"); XCTAssertEqual(card.subtitle, "Payments infrastructure for the internet")
    XCTAssertEqual(card.lines?.count, 3); XCTAssertEqual(card.footer, "Wingman · 1/2")
    XCTAssertEqual(card.page, HudCard.Page(index: 1, count: 2)); XCTAssertEqual(card.streaming, false)
    XCTAssertEqual(card.company, HudCard.CompanyRef(companyId: "stripe", confidence: 0.93)); XCTAssertEqual(card.minDisplaySec, 15)
  }

  func testDecodesMinimalHudCard() throws {
    guard case let .render(card) = try Wire.decode(#"{ "type": "render", "card": { "cardId": "c_1", "seq": 1, "kind": "ack", "title": "Identifying…" } }"#) else { return XCTFail() }
    XCTAssertNil(card.subtitle); XCTAssertNil(card.lines); XCTAssertNil(card.page); XCTAssertEqual(card.kind, .ack)
  }

  func testDecodesSessionEndAndError() throws {
    XCTAssertEqual(try Wire.decode(#"{ "type": "session_end", "reason": "user_stop" }"#), .sessionEnd(reason: .userStop))
    XCTAssertEqual(try Wire.decode(#"{ "type": "session_end", "reason": "error" }"#), .sessionEnd(reason: .error))
    XCTAssertEqual(try Wire.decode(#"{ "type": "error", "code": "identify_timeout", "message": "…", "recoverable": true }"#), .error(code: .identifyTimeout, message: "…", recoverable: true))
    for raw in ["gate_down", "identify_timeout", "no_match", "search_down", "llm_down", "rate_limited", "photo_failed"] {
      XCTAssertNotNil(ErrorCode(rawValue: raw), raw)
    }
  }

  func testUnknownFieldsAreIgnored() throws {
    let s = #"{ "type": "render", "future": 1, "card": { "cardId": "c_1", "seq": 1, "kind": "hint", "title": "x", "extra": { "a": 1 } } }"#
    guard case .render = try Wire.decode(s) else { return XCTFail() }
  }

  func testUnknownMessageTypeIsTolerated() throws {
    XCTAssertEqual(try Wire.decode(#"{ "type": "telemetry", "x": 1 }"#), .unknown(type: "telemetry"))
  }

  // MARK: Device → Cortex (encode, strict)

  func testEncodesHello() throws {
    let d = try json(Wire.encode(.hello(deviceType: .glassesBridge, caps: DeviceCaps(video: true, photoHiRes: true))))
    XCTAssertEqual(d as NSDictionary, ["type": "hello", "deviceType": "glasses_bridge", "caps": ["video": true, "photoHiRes": true]] as NSDictionary)
  }

  func testEncodesSessionStartStop() throws {
    XCTAssertEqual(try json(Wire.encode(.sessionStart)) as NSDictionary, ["type": "session_start"] as NSDictionary)
    XCTAssertEqual(try json(Wire.encode(.sessionStop)) as NSDictionary, ["type": "session_stop"] as NSDictionary)
  }

  func testEncodesFrame() throws {
    let d = try json(Wire.encode(.frame(seq: 412, ts: 1757700000123, dataBase64: "AAAA")))
    XCTAssertEqual(d as NSDictionary, ["type": "frame", "seq": 412, "ts": 1757700000123, "mime": "image/jpeg", "dataBase64": "AAAA"] as NSDictionary)
  }

  func testEncodesPhotoAndPhotoError() throws {
    XCTAssertEqual(try json(Wire.encode(.photo(reqId: "r_18", dataBase64: "AAAA"))) as NSDictionary,
                   ["type": "photo", "reqId": "r_18", "mime": "image/jpeg", "dataBase64": "AAAA"] as NSDictionary)
    XCTAssertEqual(try json(Wire.encode(.photoError(reqId: "r_18", reason: "capture_failed"))) as NSDictionary,
                   ["type": "photo_error", "reqId": "r_18", "reason": "capture_failed"] as NSDictionary)
  }

  func testEncodesStatusOmittingNilFields() throws {
    XCTAssertEqual(try json(Wire.encode(.status(battery: 0.61, note: "reconnected"))) as NSDictionary,
                   ["type": "status", "battery": 0.61, "note": "reconnected"] as NSDictionary)
    XCTAssertEqual(try json(Wire.encode(.status(battery: nil, note: nil))) as NSDictionary, ["type": "status"] as NSDictionary)
  }

  // MARK: §4.1 claim DTOs

  func testClaimRequestAndResponseShapes() throws {
    let req = try json(String(decoding: try Wire.encoder.encode(ClaimRequest(code: "483291", name: "James's phone")), as: UTF8.self))
    XCTAssertEqual(req as NSDictionary, ["code": "483291", "deviceType": "glasses_bridge", "name": "James's phone"] as NSDictionary)
    let resp = try Wire.decoder.decode(ClaimResponse.self, from: Data(#"{ "deviceId": "d_1", "deviceToken": "tok", "extra": 1 }"#.utf8))
    XCTAssertEqual(resp, ClaimResponse(deviceId: "d_1", deviceToken: "tok"))
  }
}
