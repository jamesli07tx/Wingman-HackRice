// INTEGRATION(X-MACHINE):
// COUNTERPART: glassbridge/Wingman/Protocol.swift — the Mac side's hand-mirror of this contract.
// CONTRACT: DESIGN.md §4 (§4.1 REST DTOs, §4.2 device WebSocket + HudCard) — this file transcribes it.
// AT-INTEGRATION: nothing to do — but ANY edit to this file after the hour-2 freeze requires human
// sign-off plus a matching manual change to Protocol.swift on the Mac. The two files sync only
// through DESIGN.md, never through each other.
//
// v2 protocol is 100% JSON text frames — there is no binary path (audio is gone).
// Wire field names are camelCase and FROZEN. Decode leniently (ignore unknown fields);
// encode strictly (exactly these shapes).

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export type DeviceType = "glasses_bridge" | "phone_web";

export type CardKind = "ack" | "company" | "pitch" | "scan" | "hint" | "error";

/** DESIGN.md §4.2 — closed enum, frozen. */
export type ErrorCode =
  | "gate_down"
  | "identify_timeout"
  | "no_match"
  | "search_down"
  | "llm_down"
  | "rate_limited"
  | "photo_failed";

export type SessionEndReason = "user_stop" | "error";

// ---------------------------------------------------------------------------
// HudCard — the shared content model (DESIGN.md §4.2)
// Renderer contract: title + subtitle + max 5 lines of ~40 chars + footer.
// Same cardId + higher seq = update/rotation, replaced in place.
// ---------------------------------------------------------------------------

export interface HudCard {
  cardId: string;
  seq: number;
  kind: CardKind;
  title: string;
  subtitle?: string;
  lines?: string[];
  footer?: string;
  /** Two-page auto-rotation marker, e.g. { index: 1, count: 2 } (D11). */
  page?: { index: number; count: number };
  streaming?: boolean;
  company?: { companyId: string; confidence: number };
  /** Minimum seconds a renderer keeps this card before replacement (D11). */
  minDisplaySec?: number;
}

// ---------------------------------------------------------------------------
// Device WebSocket — wss://…/ws/device?token=<deviceToken>  (DESIGN.md §4.2)
// ---------------------------------------------------------------------------

export interface DeviceCaps {
  video: boolean;
  photoHiRes: boolean;
}

// Device -> Cortex ----------------------------------------------------------

export interface HelloMsg {
  type: "hello";
  deviceType: DeviceType;
  caps: DeviceCaps;
}

/** Device-initiated Start (GlassBridge button / phone page load action). */
export interface SessionStartMsg {
  type: "session_start";
}

export interface SessionStopMsg {
  type: "session_stop";
}

/** Sampled at frameIntervalMs, longest edge <= frameMaxEdgePx, JPEG q~0.6, target <= 120 KB. */
export interface FrameMsg {
  type: "frame";
  seq: number;
  /** epoch millis at capture */
  ts: number;
  mime: "image/jpeg";
  dataBase64: string;
}

/** Response to capture_photo; document quality: <= docMaxEdgePx, JPEG q~0.8. */
export interface PhotoMsg {
  type: "photo";
  reqId: string;
  mime: "image/jpeg";
  dataBase64: string;
}

export interface PhotoErrorMsg {
  type: "photo_error";
  reqId: string;
  reason: string;
}

export interface StatusMsg {
  type: "status";
  /** 0..1 */
  battery?: number;
  note?: string;
}

export type DeviceToCortexMsg =
  | HelloMsg
  | SessionStartMsg
  | SessionStopMsg
  | FrameMsg
  | PhotoMsg
  | PhotoErrorMsg
  | StatusMsg;

// Cortex -> Device ----------------------------------------------------------

/**
 * Server-authoritative runtime tuning (DESIGN.md §4.2 + Appendix D).
 * Optional on ArmedMsg: devices apply it when present, else compiled defaults.
 * This is how demo-day tuning reaches the glasses without a Swift rebuild.
 */
export interface ArmedConfig {
  frameIntervalMs: number;
  frameMaxEdgePx: number;
  docMaxEdgePx: number;
  renderMinGapMs: number;
}

export interface ArmedMsg {
  type: "armed";
  sessionId: string;
  config?: ArmedConfig;
}

export interface CapturePhotoMsg {
  type: "capture_photo";
  reqId: string;
  quality: "document";
}

export interface RenderMsg {
  type: "render";
  card: HudCard;
}

export interface SessionEndMsg {
  type: "session_end";
  reason: SessionEndReason;
}

export interface ErrorMsg {
  type: "error";
  code: ErrorCode;
  message: string;
  recoverable: boolean;
}

export type CortexToDeviceMsg =
  | ArmedMsg
  | CapturePhotoMsg
  | RenderMsg
  | SessionEndMsg
  | ErrorMsg;

// ---------------------------------------------------------------------------
// REST DTOs — Console <-> Cortex, Clerk JWT (DESIGN.md §4.1)
// ---------------------------------------------------------------------------

export interface ProfileExperience {
  org: string;
  role: string;
  highlight: string;
}

/** Produced once by resume parse at upload time, cached (DESIGN.md §4.1). */
export interface ProfileSummary {
  name: string;
  headline: string;
  skills: string[];
  experiences: ProfileExperience[];
  interests: string[];
  links: Record<string, string>;
}

export interface ProfileLinks {
  linkedin?: string;
  x?: string;
  github?: string;
  website?: string;
}

export interface LinkCodeResponse {
  /** 6 digits, shown on the dashboard */
  code: string;
  /** ISO timestamp */
  expiresAt: string;
}

export interface ClaimRequest {
  code: string;
  deviceType: DeviceType;
  name: string;
}

export interface ClaimResponse {
  deviceId: string;
  deviceToken: string;
}

/** Phone mode: Clerk-authenticated, mints its own token; idempotent per user (D9). */
export interface SelfClaimRequest {
  name: string;
}

export interface DeviceInfo {
  deviceId: string;
  deviceType: DeviceType;
  name: string;
  /** ISO timestamp */
  lastSeen: string;
}

export interface SessionStartRequest {
  deviceId: string;
}

export interface SessionStartResponse {
  sessionId: string;
}

export interface SessionStopRequest {
  sessionId: string;
}

/** Demo safety: force identification (bypasses gate, cooldown, confidence). */
export interface OverrideRequest {
  companyId: string;
}

export interface CompanySearchItem {
  companyId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Company record — corpus/DB shape (DESIGN.md §5.4). Not a wire type for the
// glasses; shared because cortex and corpus scripts both use it.
// ---------------------------------------------------------------------------

export interface SummaryCardContent {
  /** maxLength 28 (schema C3) */
  title: string;
  /** maxLength 48 */
  subtitle: string;
  /** 3..5 items, each maxLength 40 */
  lines: string[];
}

export interface CompanyRecord {
  companyId: string;
  name: string;
  aliases: string[];
  tier: "sponsor" | "marquee";
  summaryMd: string;
  roles: string[];
  deadlines: string[];
  careersUrl: string;
  factsJson: Record<string, unknown>;
  /** Pre-generated at ingest — contract term D7. */
  summaryCard: SummaryCardContent | null;
  source: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Dashboard WebSocket — read-only mirror + gate telemetry (DESIGN.md §4.3)
// ---------------------------------------------------------------------------

export type DashboardEvent =
  | { type: "render"; sessionId: string; card: HudCard }
  | { type: "status"; sessionId: string; battery?: number; note?: string }
  | {
      type: "gate";
      sessionId: string;
      frameSeq: number;
      class: "banner" | "document" | "nothing";
      orgHint: string | null;
    }
  | {
      /** Sub-threshold identification the lens silenced (D13) — operator may override. */
      type: "silenced_identify";
      sessionId: string;
      nameGuess: string | null;
      confidence: number;
    }
  | { type: "session"; sessionId: string; state: "started" | "ended"; reason?: SessionEndReason }
  | {
      /**
       * DEBUG ONLY — exactly what the gate sent to Claude and what came back,
       * emitted once per classified frame right after the `gate` event above
       * (timeouts and errors included). Consoles that don't know this type
       * ignore it; nothing in the pipeline depends on it.
       */
      type: "gate_debug";
      sessionId: string;
      frameSeq: number;
      model: string;
      systemPrompt: string;
      userText: string;
      /** raw text of the first text block; null when the response had none */
      rawResponse: string | null;
      stopReason: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      latencyMs: number;
      error: string | null;
      result: { class: "banner" | "document" | "nothing"; orgHint: string | null } | null;
    };
