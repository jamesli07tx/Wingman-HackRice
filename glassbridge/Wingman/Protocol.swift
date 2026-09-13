// Protocol.swift — GlassBridge wire protocol, hand-mirror of DESIGN.md §4.2 (+ §4.1 claim DTOs).
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: shared/src/protocol.ts (Windows side; cortex DeviceGateway encodes/decodes these exact shapes)
// CONTRACT: DESIGN.md §4.2 — device WebSocket messages, HudCard, ErrorCode, armed.config; §4.1 — POST /api/devices/claim; §4.3 — DashboardEvent
// AT-INTEGRATION: nothing — transcribed from DESIGN.md §4.2, v2 frozen 2026-09-12; never resynced from cortex/ source.
//   Any post-freeze contract change needs human sign-off plus matching manual edits here AND in shared/src/protocol.ts.
//
// Rules (DESIGN_MAC.md §0.4): encode strictly (exactly these shapes, camelCase wire names — Swift property names
// already equal the wire names, so no CodingKeys remapping is needed except enum raw values); decode leniently
// (synthesized Decodable ignores unknown fields; an unknown message `type` becomes `.unknown` instead of an error).
//
// INTEGRATION: Protocol
// IN:  JSON text frames from CortexSocket
// OUT: DeviceToCortex (encode) / CortexToDevice (decode) values used by FrameSampler, HudRenderer, BridgeController
// WIRE: Wire.encode / Wire.decode are the only entry points; nothing else touches JSONEncoder/Decoder.

import Foundation

// MARK: - Shared enums (DESIGN.md §4.2, closed and frozen)

enum DeviceType: String, Codable {
  case glassesBridge = "glasses_bridge"
  case phoneWeb = "phone_web"
}

enum CardKind: String, Codable { case ack, company, pitch, scan, hint, error }

enum ErrorCode: String, Codable {
  case gateDown = "gate_down"
  case identifyTimeout = "identify_timeout"
  case noMatch = "no_match"
  case searchDown = "search_down"
  case llmDown = "llm_down"
  case rateLimited = "rate_limited"
  case photoFailed = "photo_failed"
}

enum SessionEndReason: String, Codable {
  case userStop = "user_stop"
  case error
}

// MARK: - HudCard (DESIGN.md §4.2 — renderer contract: title + subtitle + max 5 lines ≈ 40 chars + footer)

struct HudCard: Codable, Equatable {
  struct Page: Codable, Equatable { var index: Int; var count: Int }
  struct CompanyRef: Codable, Equatable { var companyId: String; var confidence: Double }

  var cardId: String
  var seq: Int
  var kind: CardKind
  var title: String
  var subtitle: String?
  var lines: [String]?
  var footer: String?
  var page: Page?
  var streaming: Bool?
  var company: CompanyRef?
  /// Informational on this device — Cortex owns rotation/hold timing (DESIGN.md §3.3, §4.2).
  var minDisplaySec: Double?
}

struct DeviceCaps: Codable, Equatable {
  var video: Bool
  var photoHiRes: Bool
}

/// Server-authoritative runtime tuning (DESIGN.md §4.2 + Appendix D). Present on `armed` → apply; absent → defaults.
struct ArmedConfig: Codable, Equatable {
  var frameIntervalMs: Int
  var frameMaxEdgePx: Int
  var docMaxEdgePx: Int
  var renderMinGapMs: Int

  /// DESIGN.md Appendix D compiled fallbacks. Overridden by armed.config whenever present.
  static let defaults = ArmedConfig(frameIntervalMs: 1750, frameMaxEdgePx: 768, docMaxEdgePx: 2048, renderMinGapMs: 500)
}

// MARK: - Device → Cortex (encoded strictly)

enum DeviceToCortex: Equatable {
  case hello(deviceType: DeviceType, caps: DeviceCaps)
  case sessionStart
  case sessionStop
  /// seq increments per emitted frame; ts = epoch millis at capture; mime is always image/jpeg.
  case frame(seq: Int, ts: Int64, dataBase64: String)
  case photo(reqId: String, dataBase64: String)
  case photoError(reqId: String, reason: String)
  case status(battery: Double?, note: String?)
}

extension DeviceToCortex: Encodable {
  private enum Key: String, CodingKey { case type, deviceType, caps, seq, ts, mime, dataBase64, reqId, reason, battery, note }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    switch self {
    case let .hello(deviceType, caps):
      try c.encode("hello", forKey: .type)
      try c.encode(deviceType, forKey: .deviceType)
      try c.encode(caps, forKey: .caps)
    case .sessionStart:
      try c.encode("session_start", forKey: .type)
    case .sessionStop:
      try c.encode("session_stop", forKey: .type)
    case let .frame(seq, ts, dataBase64):
      try c.encode("frame", forKey: .type)
      try c.encode(seq, forKey: .seq)
      try c.encode(ts, forKey: .ts)
      try c.encode("image/jpeg", forKey: .mime)
      try c.encode(dataBase64, forKey: .dataBase64)
    case let .photo(reqId, dataBase64):
      try c.encode("photo", forKey: .type)
      try c.encode(reqId, forKey: .reqId)
      try c.encode("image/jpeg", forKey: .mime)
      try c.encode(dataBase64, forKey: .dataBase64)
    case let .photoError(reqId, reason):
      try c.encode("photo_error", forKey: .type)
      try c.encode(reqId, forKey: .reqId)
      try c.encode(reason, forKey: .reason)
    case let .status(battery, note):
      try c.encode("status", forKey: .type)
      try c.encodeIfPresent(battery, forKey: .battery)
      try c.encodeIfPresent(note, forKey: .note)
    }
  }
}

// MARK: - Cortex → Device (decoded leniently)

enum CortexToDevice: Equatable {
  case armed(sessionId: String, config: ArmedConfig?)
  case capturePhoto(reqId: String, quality: String)
  case render(card: HudCard)
  case sessionEnd(reason: SessionEndReason)
  case error(code: ErrorCode, message: String, recoverable: Bool)
  /// A `type` this build does not know — logged and ignored, never fatal.
  case unknown(type: String)
}

extension CortexToDevice: Decodable {
  private enum Key: String, CodingKey { case type, sessionId, config, reqId, quality, card, reason, code, message, recoverable }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "armed":
      self = .armed(sessionId: try c.decode(String.self, forKey: .sessionId),
                    config: try c.decodeIfPresent(ArmedConfig.self, forKey: .config))
    case "capture_photo":
      self = .capturePhoto(reqId: try c.decode(String.self, forKey: .reqId),
                           quality: try c.decodeIfPresent(String.self, forKey: .quality) ?? "document")
    case "render":
      self = .render(card: try c.decode(HudCard.self, forKey: .card))
    case "session_end":
      self = .sessionEnd(reason: try c.decode(SessionEndReason.self, forKey: .reason))
    case "error":
      self = .error(code: try c.decode(ErrorCode.self, forKey: .code),
                    message: try c.decodeIfPresent(String.self, forKey: .message) ?? "",
                    recoverable: try c.decodeIfPresent(Bool.self, forKey: .recoverable) ?? true)
    default:
      self = .unknown(type: type)
    }
  }
}

// MARK: - Dashboard WebSocket (DESIGN.md §4.3) — read-only mirror + gate telemetry
//
// Decoded as leniently as CortexToDevice: an unknown `type` becomes `.unknown`, and an unknown gate
// `class` becomes a nil `gateClass` rather than a thrown error — a Cortex that grows a sixth class
// must degrade one row of the Feed, never blank the whole timeline.

enum GateClass: String, Decodable, Equatable { case banner, document, nothing }

/// The gate call behind one frame (DESIGN.md §4.3 `gate_debug`): the exact prompt Cortex sent and the exact
/// text the model returned. Decoded as leniently as everything else here — a field Cortex renames must cost
/// one line of the panel, never the whole event, because DashboardSocket drops anything that fails to decode.
struct GateDebug: Decodable, Equatable {
  /// The parsed verdict, when the model returned parseable JSON. Same rule as `.gate`: an unknown class is nil.
  struct Result: Decodable, Equatable {
    var gateClass: GateClass?
    var orgHint: String?

    private enum Key: String, CodingKey { case `class`, orgHint }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: Key.self)
      gateClass = (try? c.decode(String.self, forKey: .class)).flatMap(GateClass.init(rawValue:))
      orgHint = try? c.decode(String.self, forKey: .orgHint)
    }
  }

  var sessionId: String
  var frameSeq: Int
  var model: String
  var systemPrompt: String
  var userText: String
  /// nil = the model returned no text at all (see `stopReason`) — the failure this event exists to expose.
  var rawResponse: String?
  var stopReason: String?
  var inputTokens: Int?
  var outputTokens: Int?
  var latencyMs: Int
  var error: String?
  var result: Result?

  private enum Key: String, CodingKey {
    case sessionId, frameSeq, model, systemPrompt, userText, rawResponse, stopReason
    case inputTokens, outputTokens, latencyMs, error, result
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    // frameSeq is the row's identity — an event without one has nothing to attach to. Everything else degrades.
    frameSeq = try c.decode(Int.self, forKey: .frameSeq)
    sessionId = (try? c.decode(String.self, forKey: .sessionId)) ?? ""
    model = (try? c.decode(String.self, forKey: .model)) ?? "gate"
    systemPrompt = (try? c.decode(String.self, forKey: .systemPrompt)) ?? ""
    userText = (try? c.decode(String.self, forKey: .userText)) ?? ""
    rawResponse = try? c.decode(String.self, forKey: .rawResponse)
    stopReason = try? c.decode(String.self, forKey: .stopReason)
    inputTokens = try? c.decode(Int.self, forKey: .inputTokens)
    outputTokens = try? c.decode(Int.self, forKey: .outputTokens)
    latencyMs = (try? c.decode(Int.self, forKey: .latencyMs)) ?? 0
    error = try? c.decode(String.self, forKey: .error)
    result = try? c.decode(Result.self, forKey: .result)
  }
}

/// Display strings only — never on the wire (same rule as ProfileSummary.Experience.id). They live here
/// rather than in the Feed so `swift test` can check the one piece of logic in them: what `note` says.
extension GateDebug {
  var latencyText: String { String(format: "%.1f s", Double(latencyMs) / 1000) }

  var tokensText: String? {
    guard let inputTokens, let outputTokens else { return nil }
    return "\(inputTokens)→\(outputTokens) tok"
  }

  /// The row's detail line: "claude-opus-5 · 2.3 s · 918→22 tok · end_turn".
  var summary: String {
    ([model, latencyText, tokensText, stopReason].compactMap { $0 }).joined(separator: " · ")
  }

  /// Red under the summary when this call produced no verdict; nil when the model answered normally.
  var note: String? {
    if let error { return error }
    if rawResponse == nil { return "no JSON returned (stop: \(stopReason ?? "unknown"))" }
    return nil
  }
}

enum DashboardEvent: Decodable, Equatable {
  case render(sessionId: String, card: HudCard)
  case status(sessionId: String, battery: Double?, note: String?)
  case gate(sessionId: String, frameSeq: Int, gateClass: GateClass?, orgHint: String?)
  /// The gate call itself — prompt in, raw text out (the Feed's "Gate model" panel and row expansion).
  case gateDebug(GateDebug)
  case silencedIdentify(sessionId: String, nameGuess: String?, confidence: Double)
  case session(sessionId: String, state: String, reason: SessionEndReason?)
  /// A `type` this build does not know — shown as one grey row, never fatal.
  case unknown(type: String)

  /// shared/src/constants.ts CONF_THRESHOLD — under this the lens silences an identification (D13).
  static let confThreshold = 0.25

  private enum Key: String, CodingKey {
    case type, sessionId, card, battery, note, frameSeq, `class`, orgHint, nameGuess, confidence, state, reason
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    let type = try c.decode(String.self, forKey: .type)
    // Diagnostics, not control: a missing sessionId must not cost us the row.
    let sessionId = (try? c.decode(String.self, forKey: .sessionId)) ?? ""
    switch type {
    case "render":
      self = .render(sessionId: sessionId, card: try c.decode(HudCard.self, forKey: .card))
    case "status":
      self = .status(sessionId: sessionId,
                     battery: try c.decodeIfPresent(Double.self, forKey: .battery),
                     note: try c.decodeIfPresent(String.self, forKey: .note))
    case "gate":
      self = .gate(sessionId: sessionId,
                   frameSeq: try c.decode(Int.self, forKey: .frameSeq),
                   gateClass: (try? c.decode(String.self, forKey: .class)).flatMap(GateClass.init(rawValue:)),
                   orgHint: try c.decodeIfPresent(String.self, forKey: .orgHint))
    case "gate_debug":
      self = .gateDebug(try GateDebug(from: decoder))   // flat on the wire, so it reads the same container
    case "silenced_identify":
      self = .silencedIdentify(sessionId: sessionId,
                               nameGuess: try c.decodeIfPresent(String.self, forKey: .nameGuess),
                               confidence: try c.decodeIfPresent(Double.self, forKey: .confidence) ?? 0)
    case "session":
      self = .session(sessionId: sessionId,
                      state: try c.decode(String.self, forKey: .state),
                      reason: try? c.decode(SessionEndReason.self, forKey: .reason))
    default:
      self = .unknown(type: type)
    }
  }
}

// MARK: - REST DTOs (DESIGN.md §4.1)
//
// Decoded LENIENTLY — every field is optional. Cortex answers GET /api/profile with
// { profile: null } before a resume is uploaded, and the parser fills whatever the PDF had.

/// The parsed resume Cortex hands back (DESIGN.md §4.1).
struct ProfileSummary: Codable, Equatable {
  struct Experience: Codable, Equatable, Identifiable {
    var org: String?
    var role: String?
    var highlight: String?
    /// SwiftUI list identity only — never on the wire.
    var id: String { "\(org ?? "")|\(role ?? "")" }
  }

  var name: String?
  var headline: String?
  var skills: [String]?
  var experiences: [Experience]?
  var interests: [String]?
  var links: ProfileLinks?
}

/// PUT /api/profile/links body. Synthesized `encode` uses encodeIfPresent for Optionals,
/// so a nil field is OMITTED rather than sent as null — which is what the zod schema wants.
struct ProfileLinks: Codable, Equatable {
  var linkedin: String?
  var x: String?
  var github: String?
  var website: String?

  var isEmpty: Bool { [linkedin, x, github, website].allSatisfy { ($0 ?? "").isEmpty } }
}

/// GET /api/profile → { profile, links }; POST /api/profile/resume → { profile }.
struct ProfileEnvelope: Decodable, Equatable {
  var profile: ProfileSummary?
  var links: ProfileLinks?
}

/// POST /api/devices/link-code (Bearer) → { code, expiresAt }.
struct LinkCodeResponse: Decodable, Equatable {
  var code: String
  var expiresAt: String?
}

/// GET /api/devices → [ { deviceId, deviceType, name, lastSeen } ].
struct DeviceInfo: Decodable, Equatable, Identifiable {
  var deviceId: String
  var deviceType: String?
  var name: String?
  var lastSeen: String?

  var id: String { deviceId }
}

// POST /api/devices/claim

struct ClaimRequest: Encodable {
  var code: String
  var deviceType: DeviceType = .glassesBridge
  var name: String
}

struct ClaimResponse: Decodable, Equatable {
  var deviceId: String
  var deviceToken: String
}

// MARK: - One coder pair for the app

enum Wire {
  static let encoder = JSONEncoder()
  static let decoder = JSONDecoder()

  static func encode(_ msg: DeviceToCortex) -> String {
    // Encoding a value type of our own enum cannot fail in practice; fall back to {} rather than crash a stream.
    String(decoding: (try? encoder.encode(msg)) ?? Data("{}".utf8), as: UTF8.self)
  }

  static func decode(_ text: String) throws -> CortexToDevice {
    try decoder.decode(CortexToDevice.self, from: Data(text.utf8))
  }

  static func decodeDashboard(_ text: String) throws -> DashboardEvent {
    try decoder.decode(DashboardEvent.self, from: Data(text.utf8))
  }
}
