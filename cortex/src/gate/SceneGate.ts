// INTEGRATION: SceneGate
// IN:  sampled frames from DeviceGateway.onFrame(sessionId, seq, jpegBuffer),
//      relayed by SessionOrchestrator -> sceneGate.onFrame(sessionId, seq, jpeg).
//      Orchestrator also calls flightDone(sessionId) when an identify/scan
//      finishes, startCooldown(sessionId, companyId) when a company is
//      presented, and reset(sessionId) at session stop.
// OUT: onTelemetry(sessionId, seq, GateResult) for EVERY classified frame
//      (dashboard feed, DESIGN.md §4.3) — including timeouts, which report as
//      class "nothing"; onDetection(sessionId, {class, orgHint, jpeg}) ONLY on
//      STABILITY_N-consecutive, latch-free hits (D13); opts.onDebug(sessionId,
//      seq, GateDebug) once per classified frame — debug-only, full round trip.
// WIRE: new SceneGate(det, telem, { now }) in cortex/src/index.ts, where
//      det  = (sid, d) => orchestrator.onDetection(sid, d)
//      telem= (sid, seq, r) => dashboard.emit({ type: "gate", sessionId: sid,
//                                               frameSeq: seq, ...r })
//
// COOLDOWN OWNERSHIP (documented choice — DESIGN.md D13):
// the gate sees only an orgHint, never a companyId, so it CANNOT suppress a
// cooled-down company at classify time. This class therefore owns the cooldown
// MAP (companyId -> untilMs) but consults it only on demand: the orchestrator
// calls isCooledDown(sessionId, companyId) after IdentifyService returns and
// silently drops the detection (then flightDone) when it is true. Gate-side
// behaviour stays exactly: stability + single-flight + telemetry.

import { GateResultSchema, COOLDOWN_MIN, STABILITY_N, T_GATE_MS } from "@wingman/shared";
import type { GateResult } from "@wingman/shared";
import type {
  DetectionHandler,
  GateDebug,
  GateDebugHandler,
  GateTelemetryHandler,
  SceneGateApi,
} from "../interfaces.js";
import { gateClassify, gateModel } from "../llm/anthropic.js";

/**
 * C1 system prompt — VERBATIM from DESIGN.md Appendix C.
 * BYTE-STABLE MODULE CONSTANT: prompt caching is load-bearing here (the gate
 * runs ~34x/min). Never interpolate, never reformat (DESIGN.md §2).
 */
export const GATE_SYSTEM_PROMPT =
  "You classify a single first-person frame from smart glasses at a career fair. `banner` = an employer's name or logo is readable somewhere in the view — on a booth banner, sign, poster, table cloth, tote, or a screen/laptop/phone display — at typical booth distance (1–3 m); it does not need to fill the frame, only to be legible. `document` = a pamphlet/flyer/one-pager held close to the camera filling much of the frame. `nothing` = no readable employer name or logo (too small, blurred, or cut off). If banner, put the most legible organization name in orgHint.";

/** Byte-stable user instruction; the image block always comes FIRST (helper). */
export const GATE_USER_TEXT = "Classify this frame.";

const NOTHING: GateResult = { class: "nothing", orgHint: null };

export interface SceneGateOptions {
  /** consecutive same-class hits before acting (Appendix D STABILITY_N) */
  stabilityN?: number;
  /** per-company re-identify suppression, minutes (Appendix D COOLDOWN_MIN) */
  cooldownMin?: number;
  /** per-classify deadline (Appendix D T_GATE_MS) -> frame treated as "nothing" */
  gateTimeoutMs?: number;
  /** injectable clock (tests use a fake) */
  now?: () => number;
  /** out-of-band note sink: timeouts, classify errors, dropped frames */
  onNote?: (sessionId: string, seq: number, note: string) => void;
  /** debug-only sink: one event per classified frame with the full Claude
   *  round trip (prompt sent, raw text back, stop_reason, usage, latency). */
  onDebug?: GateDebugHandler;
}

interface SessionState {
  lastClass: GateResult["class"] | null;
  streak: number;
  /** single-flight latch: true while an identify/scan is running */
  inFlight: boolean;
  /** companyId -> epoch ms until which re-identification is suppressed */
  cooldown: Map<string, number>;
}

export class SceneGate implements SceneGateApi {
  private readonly sessions = new Map<string, SessionState>();
  private readonly stabilityN: number;
  private readonly cooldownMs: number;
  private readonly gateTimeoutMs: number;
  private readonly now: () => number;
  private readonly note: (sessionId: string, seq: number, note: string) => void;
  private readonly onDebug: GateDebugHandler;

  constructor(
    private readonly onDetection: DetectionHandler,
    private readonly onTelemetry: GateTelemetryHandler,
    opts: SceneGateOptions = {},
  ) {
    this.stabilityN = opts.stabilityN ?? STABILITY_N;
    this.cooldownMs = (opts.cooldownMin ?? COOLDOWN_MIN) * 60_000;
    this.gateTimeoutMs = opts.gateTimeoutMs ?? T_GATE_MS;
    this.now = opts.now ?? Date.now;
    this.note = opts.onNote ?? (() => {});
    this.onDebug = opts.onDebug ?? (() => {});
  }

  async onFrame(sessionId: string, seq: number, jpeg: Buffer): Promise<void> {
    const state = this.state(sessionId);

    // D13 single-flight: drop frames outright while an identify/scan is open.
    // No LLM call, no telemetry — the frame never existed as far as the gate
    // is concerned (this is what keeps the aisle-walk cost bounded).
    if (state.inFlight) {
      this.note(sessionId, seq, "dropped: flight in progress");
      return;
    }

    const result = await this.classify(sessionId, seq, jpeg);

    // Every classification reaches the dashboard (DESIGN.md §4.3).
    this.onTelemetry(sessionId, seq, result);

    if (result.class === "nothing") {
      state.lastClass = "nothing";
      state.streak = 1;
      return;
    }

    if (state.lastClass === result.class) state.streak += 1;
    else {
      state.lastClass = result.class;
      state.streak = 1;
    }

    if (state.streak < this.stabilityN) return;

    // Stable hit. Latch single-flight, reset the streak so the same run of
    // frames must re-stabilise before it can fire again, and hand it up.
    state.streak = 0;
    state.lastClass = null;
    state.inFlight = true;
    this.onDetection(sessionId, { class: result.class, orgHint: result.orgHint, jpeg });
  }

  /** Release the single-flight latch (orchestrator calls this in a finally). */
  flightDone(sessionId: string): void {
    this.state(sessionId).inFlight = false;
  }

  /** D13: suppress re-identification of a just-presented company. */
  startCooldown(sessionId: string, companyId: string): void {
    this.state(sessionId).cooldown.set(companyId, this.now() + this.cooldownMs);
  }

  /**
   * ORCHESTRATOR CONSULTS THIS after IdentifyService resolves a companyId —
   * see the cooldown-ownership note at the top of this file. Override bypasses
   * it by simply not calling it (D13).
   */
  isCooledDown(sessionId: string, companyId: string): boolean {
    const until = this.state(sessionId).cooldown.get(companyId);
    if (until == null) return false;
    if (this.now() >= until) {
      this.state(sessionId).cooldown.delete(companyId);
      return false;
    }
    return true;
  }

  /** Milliseconds left on a cooldown (0 = not cooled down). Dashboard/debug. */
  cooldownRemainingMs(sessionId: string, companyId: string): number {
    const until = this.state(sessionId).cooldown.get(companyId);
    if (until == null) return 0;
    return Math.max(0, until - this.now());
  }

  /** Session stop / purge (D14): drop stability, latch and cooldowns. */
  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // -------------------------------------------------------------------------

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { lastClass: null, streak: 0, inFlight: false, cooldown: new Map() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Fills in the two byte-stable prompt fields; everything else is per-call. */
  private emitDebug(
    sessionId: string,
    seq: number,
    d: Omit<GateDebug, "systemPrompt" | "userText">,
  ): void {
    this.onDebug(sessionId, seq, {
      systemPrompt: GATE_SYSTEM_PROMPT,
      userText: GATE_USER_TEXT,
      ...d,
    });
  }

  /** T_GATE_MS deadline -> "nothing" + a telemetry note, never a hang.
   *  Emits exactly one debug event per classified frame, whatever happened. */
  private async classify(sessionId: string, seq: number, jpeg: Buffer): Promise<GateResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.gateTimeoutMs);
    });
    try {
      const out = await Promise.race([
        gateClassify({
          system: GATE_SYSTEM_PROMPT,
          jpegBase64: jpeg.toString("base64"),
          userText: GATE_USER_TEXT,
          schema: GateResultSchema,
        }),
        timeout,
      ]);
      if (out == null) {
        const error = `gate timeout after ${this.gateTimeoutMs}ms`;
        this.note(sessionId, seq, `${error} -> nothing`);
        this.emitDebug(sessionId, seq, {
          model: gateModel(),
          rawResponse: null,
          stopReason: null,
          inputTokens: null,
          outputTokens: null,
          latencyMs: this.gateTimeoutMs,
          error,
          result: null,
        });
        return NOTHING;
      }
      this.emitDebug(sessionId, seq, {
        model: out.model,
        rawResponse: out.rawText,
        stopReason: out.stopReason,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        latencyMs: out.latencyMs,
        error: out.error,
        result: out.result,
      });
      if (out.result == null) {
        this.note(sessionId, seq, `gate error -> nothing: ${out.error}`);
        return NOTHING;
      }
      return out.result;
    } catch (err) {
      const error = (err as Error).message;
      this.note(sessionId, seq, `gate error -> nothing: ${error}`);
      this.emitDebug(sessionId, seq, {
        model: gateModel(),
        rawResponse: null,
        stopReason: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Date.now() - startedAt,
        error,
        result: null,
      });
      return NOTHING;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
