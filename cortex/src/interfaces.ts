// ORCHESTRATOR-OWNED SEAM FILE (DESIGN_WINDOWS.md subagent rules).
// Every cortex module implements exactly one interface from this file and
// imports the others ONLY as types from here — never from a sibling module's
// implementation. This is what lets modules be built in parallel by different
// subagents and wired together once in src/index.ts.
//
// Module internals are the implementing subagent's business; these signatures
// are not. Changing a signature here is an orchestrator-only edit.

import type {
  CompanyRecord,
  CortexToDeviceMsg,
  DashboardEvent,
  DeviceType,
  GateResult,
  IdentifyResult,
  ProfileLinks,
  ProfileSummary,
  ScanExtraction,
  SummaryCardContent,
} from "@wingman/shared";

// ---------------------------------------------------------------------------
// Gateway (DESIGN.md §5.3 DeviceGateway) — WS hub; auth by deviceToken.
// ---------------------------------------------------------------------------

/** One connected device socket, abstracted so MockDeviceAdapter can stand in. */
export interface DeviceChannel {
  readonly deviceId: string;
  readonly deviceType: DeviceType;
  send(msg: CortexToDeviceMsg): void;
  close(): void;
}

/** Callbacks the gateway fires into the orchestrator. */
export interface GatewayEvents {
  onDeviceSessionStart(channel: DeviceChannel): void;
  onDeviceSessionStop(deviceId: string): void;
  onFrame(deviceId: string, seq: number, jpeg: Buffer): void;
  onPhoto(deviceId: string, reqId: string, jpeg: Buffer): void;
  onPhotoError(deviceId: string, reqId: string, reason: string): void;
  onStatus(deviceId: string, battery?: number, note?: string): void;
  onDisconnect(deviceId: string): void;
}

// ---------------------------------------------------------------------------
// SceneGate (DESIGN.md §5.3) — vision frame gate (opus-5 by default) + D13 churn rules.
// Owns: stability tracker (×N), single-flight latch, cooldown map.
// ---------------------------------------------------------------------------

export interface StableDetection {
  class: "banner" | "document";
  orgHint: string | null;
  /** the frame that produced the stable hit */
  jpeg: Buffer;
}

export interface SceneGateApi {
  /** Gate one sampled frame. Emits telemetry; calls detection callback only on
   *  ×N-stable, non-cooled-down, non-in-flight hits. */
  onFrame(sessionId: string, seq: number, jpeg: Buffer): Promise<void>;
  /** Mark identify/scan flight done so the latch releases. */
  flightDone(sessionId: string): void;
  /** Start the D13 cooldown for a company that was just presented. */
  startCooldown(sessionId: string, companyId: string): void;
  /** Optional consult: true while companyId is inside its D13 cooldown window.
   *  The orchestrator uses it to drop a re-identification of company A after
   *  the card has already moved on to company B. Optional so simple fakes
   *  stay valid. */
  isCooledDown?(sessionId: string, companyId: string): boolean;
  reset(sessionId: string): void;
}

export type DetectionHandler = (sessionId: string, det: StableDetection) => void;
export type GateTelemetryHandler = (
  sessionId: string,
  seq: number,
  result: GateResult,
) => void;

/** Debug-feed payload: the gate_debug wire event minus what the wiring adds. */
export type GateDebug = Omit<
  Extract<DashboardEvent, { type: "gate_debug" }>,
  "type" | "sessionId" | "frameSeq"
>;
export type GateDebugHandler = (sessionId: string, seq: number, debug: GateDebug) => void;

// ---------------------------------------------------------------------------
// Identify (DESIGN.md §5.3 IdentifyService)
// ---------------------------------------------------------------------------

export interface Identifier {
  /** Vision identify against the corpus alias list (system-prompt-stable). */
  identify(frameJpeg: Buffer): Promise<IdentifyResult>;
}

// ---------------------------------------------------------------------------
// Context (DESIGN.md §5.3 ContextService)
// ---------------------------------------------------------------------------

export interface CompanyContext {
  companyId: string;
  displayName: string;
  card: SummaryCardContent;
  record: CompanyRecord | null;
}

export interface ContextProvider {
  /** Corpus hit -> pre-generated card (instant). Miss -> live search path
   *  (Tavily + condense), cached back into the DB. Null -> nothing usable. */
  resolve(input: { corpusId: string | null; nameGuess: string | null }): Promise<CompanyContext | null>;
  /** Override path + REST /api/companies search. */
  byId(companyId: string): Promise<CompanyContext | null>;
  search(query: string): Promise<{ companyId: string; name: string }[]>;
}

// ---------------------------------------------------------------------------
// Pitch / Scan / Profile (DESIGN.md §5.3)
// ---------------------------------------------------------------------------

export interface PitchServiceApi {
  pitchPage(profile: ProfileSummary, company: CompanyContext): Promise<SummaryCardContent>;
}

export interface ScanServiceApi {
  extract(photoJpeg: Buffer): Promise<ScanExtraction>;
}

export interface ProfileServiceApi {
  parseResume(userId: string, pdf: Buffer): Promise<ProfileSummary>;
  setLinks(userId: string, links: ProfileLinks): Promise<void>;
  getProfile(userId: string): Promise<{ profile: ProfileSummary | null; links: ProfileLinks }>;
}

// ---------------------------------------------------------------------------
// SessionOrchestrator (DESIGN.md §3.3 state machine + §5.3)
// Owns: card lifecycle, rotation timer, context, per-stage timeouts.
// ---------------------------------------------------------------------------

export interface OrchestratorApi extends GatewayEvents {
  /** Dashboard-initiated start (REST /api/session/start). */
  startForDevice(deviceId: string): { sessionId: string } | null;
  stop(sessionId: string): void;
  /** Demo override: force a company (bypasses gate, cooldown, confidence). */
  override(sessionId: string, companyId: string): Promise<void>;
  activeSessionForUser(): { sessionId: string; deviceId: string } | null;
}

// ---------------------------------------------------------------------------
// Dashboard feed (DESIGN.md §4.3) — read-only mirror + gate telemetry.
// ---------------------------------------------------------------------------

export interface DashboardFeed {
  emit(event: DashboardEvent): void;
}
