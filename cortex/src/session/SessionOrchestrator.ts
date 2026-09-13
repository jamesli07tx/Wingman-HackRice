// INTEGRATION: SessionOrchestrator (DESIGN.md §3.3 state machine + §5.3)
// IN:  GatewayEvents callbacks from DeviceGateway / MockDeviceAdapter (frames, photos,
//      status, connect/disconnect), stable detections from SceneGate via `onDetection`,
//      and REST commands (start / stop / override) from rest/routes.ts.
// OUT: CortexToDeviceMsg on the session's DeviceChannel (armed, capture_photo, render,
//      session_end, error) + every render/status/silenced_identify/session event mirrored
//      to DashboardFeed (DESIGN.md §4.3).
// WIRE: const orch = new SessionOrchestrator({ gate, identifier, context, pitch, scan,
//         getProfile, dashboard });
//       const gate = new SceneGate(…, orch.onDetection, dashboardGateTelemetry);
//       new DeviceGateway({ supabase, events: orch, onChannelOpen: (c) => orch.registerChannel(c) });
//
// Owns (and is the ONLY owner of): card lifecycle + cardId/seq, the two-page rotation timer,
// per-stage deadlines (Appendix D) -> degraded card, and the replace-on-change guard.
// D13 rules that live in SceneGate (stability x2, single-flight latch, cooldown map) are
// driven from here through SceneGateApi.flightDone / startCooldown / reset.

import type {
  CardKind,
  DeviceType,
  ErrorCode,
  HudCard,
  ProfileSummary,
  SummaryCardContent,
} from "@wingman/shared";
import {
  CONF_THRESHOLD,
  NO_MATCH_BACKOFF_SEC,
  PAGE1_MIN_SEC,
  ROTATE_SEC,
  T_IDENTIFY_MS,
  T_PHOTO_MS,
  T_PITCH_MS,
  T_RESEARCH_MS,
  T_SEARCH_MS,
  deviceConfig,
} from "@wingman/shared";
import type {
  CompanyContext,
  ContextProvider,
  DashboardFeed,
  DetectionHandler,
  DeviceChannel,
  Identifier,
  OrchestratorApi,
  PitchServiceApi,
  ScanServiceApi,
  SceneGateApi,
  StableDetection,
} from "../interfaces.js";

export type SessionState = "ARMED" | "IDENTIFYING" | "SCANNING" | "PRESENTING";

export interface OrchestratorLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: OrchestratorLogger = {
  // eslint-disable-next-line no-console
  info: (msg, meta) => console.log(`[session] ${msg}`, meta ?? ""),
  // eslint-disable-next-line no-console
  warn: (msg, meta) => console.warn(`[session] ${msg}`, meta ?? ""),
};

export interface SessionOrchestratorDeps {
  gate: SceneGateApi;
  identifier: Identifier;
  context: ContextProvider;
  pitch: PitchServiceApi;
  scan: ScanServiceApi;
  /** Single-user demo (D8): the cached ProfileSummary, pre-loaded at session start. */
  getProfile: () => Promise<ProfileSummary | null>;
  dashboard: DashboardFeed;
  /** Injectable clock (tests). */
  now?: () => number;
  logger?: OrchestratorLogger;
}

/** The live two-page card set for a session (D11). */
interface CardSet {
  cardId: string;
  seq: number;
  kind: CardKind;
  companyId: string | null;
  confidence: number;
  /** Page 1: the company summary (or the standalone scan content). */
  page1: SummaryCardContent;
  /** Page 2: the pitch — null until PitchService answers. */
  page2: SummaryCardContent | null;
  /** 1 = no rotation (no profile / standalone scan); 2 = summary + pitch rotation. */
  pages: 1 | 2;
  /** Lines merged in from a pamphlet scan (DESIGN.md §3.1 F7). */
  scanLines: string[];
  currentPage: 1 | 2;
  /** When page 1 first hit the lens — the PAGE1_MIN_SEC replace-on-change guard. */
  shownAt: number;
}

interface Session {
  sessionId: string;
  deviceId: string;
  channel: DeviceChannel;
  state: SessionState;
  profile: ProfileSummary | null;
  card: CardSet | null;
  pendingPhoto: { reqId: string; timer: ReturnType<typeof setTimeout> } | null;
  rotationTimer: ReturnType<typeof setTimeout> | null;
  /** D13 no-match backoff: gate orgHint key -> epoch ms until re-identify is allowed. */
  backoff: Map<string, number>;
  lastGateErrorAt: number;
  closed: boolean;
}

type Settled<T> = { kind: "ok"; value: T } | { kind: "timeout" } | { kind: "error"; error: unknown };

/** Race a stage against its Appendix D deadline — never a hang, always a decision. */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
  });
  try {
    return await Promise.race([
      p.then<Settled<T>, Settled<T>>(
        (value) => ({ kind: "ok", value }),
        (error) => ({ kind: "error", error }),
      ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const GATE_ERROR_MIN_GAP_MS = 10_000;

export class SessionOrchestrator implements OrchestratorApi {
  readonly #sessions = new Map<string, Session>();
  readonly #byDevice = new Map<string, Session>();
  readonly #channels = new Map<string, DeviceChannel>();
  readonly #log: OrchestratorLogger;
  #sessionCounter = 0;
  #cardCounter = 0;
  #reqCounter = 0;

  constructor(private readonly deps: SessionOrchestratorDeps) {
    this.#log = deps.logger ?? consoleLogger;
  }

  // -------------------------------------------------------------------------
  // Channel registry (additive seam — see DeviceGateway.onChannelOpen)
  // -------------------------------------------------------------------------

  registerChannel(channel: DeviceChannel): void {
    this.#channels.set(channel.deviceId, channel);
  }

  unregisterChannel(deviceId: string): void {
    this.#channels.delete(deviceId);
  }

  // -------------------------------------------------------------------------
  // OrchestratorApi
  // -------------------------------------------------------------------------

  /** Dashboard-initiated start (REST /api/session/start). Null = device not connected. */
  startForDevice(deviceId: string): { sessionId: string } | null {
    const existing = this.#byDevice.get(deviceId);
    if (existing) return { sessionId: existing.sessionId };
    const channel = this.#channels.get(deviceId);
    if (!channel) return null;
    return { sessionId: this.#arm(channel).sessionId };
  }

  stop(sessionId: string): void {
    this.#end(this.#sessions.get(sessionId), "user_stop", true);
  }

  /** Demo override: force a company — bypasses gate, cooldown, confidence AND the
   *  PAGE1_MIN_SEC replace guard (it is the operator's explicit instruction). */
  async override(sessionId: string, companyId: string): Promise<void> {
    const s = this.#sessions.get(sessionId);
    if (!s || s.closed) return;
    const resolved = await withDeadline(this.deps.context.byId(companyId), T_SEARCH_MS);
    if (s.closed) return;
    if (resolved.kind !== "ok" || resolved.value === null) {
      this.#degrade(s, resolved.kind === "timeout" ? "search_down" : "no_match", "No match", [
        `Could not load ${companyId}`,
      ]);
      s.state = "ARMED";
      return;
    }
    this.#present(s, resolved.value, 1);
  }

  activeSessionForUser(): { sessionId: string; deviceId: string } | null {
    for (const s of this.#sessions.values()) {
      if (!s.closed) return { sessionId: s.sessionId, deviceId: s.deviceId };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // GatewayEvents
  // -------------------------------------------------------------------------

  onDeviceSessionStart(channel: DeviceChannel): void {
    this.registerChannel(channel);
    const existing = this.#byDevice.get(channel.deviceId);
    if (existing && !existing.closed) {
      // Re-arm an existing session (device reconnected / pressed Start twice).
      existing.channel = channel;
      this.#sendArmed(existing);
      return;
    }
    this.#arm(channel);
  }

  onDeviceSessionStop(deviceId: string): void {
    this.#end(this.#byDevice.get(deviceId), "user_stop", true);
  }

  onFrame(deviceId: string, seq: number, jpeg: Buffer): void {
    const s = this.#byDevice.get(deviceId);
    if (!s || s.closed) return;
    void this.deps.gate.onFrame(s.sessionId, seq, jpeg).catch((err: unknown) => {
      const now = this.#now();
      if (now - s.lastGateErrorAt > GATE_ERROR_MIN_GAP_MS) {
        s.lastGateErrorAt = now;
        this.#sendError(s, "gate_down", "frame gate unavailable");
      }
      this.#log.warn("gate.onFrame failed", { sessionId: s.sessionId, err: String(err) });
    });
  }

  onPhoto(deviceId: string, reqId: string, jpeg: Buffer): void {
    const s = this.#byDevice.get(deviceId);
    if (!s || s.closed || !s.pendingPhoto || s.pendingPhoto.reqId !== reqId) return;
    clearTimeout(s.pendingPhoto.timer);
    s.pendingPhoto = null;
    void this.#runExtract(s, jpeg);
  }

  onPhotoError(deviceId: string, reqId: string, reason: string): void {
    const s = this.#byDevice.get(deviceId);
    if (!s || s.closed || !s.pendingPhoto || s.pendingPhoto.reqId !== reqId) return;
    clearTimeout(s.pendingPhoto.timer);
    s.pendingPhoto = null;
    this.#failScan(s, `capture failed: ${reason}`);
  }

  onStatus(deviceId: string, battery?: number, note?: string): void {
    const s = this.#byDevice.get(deviceId);
    if (!s) return;
    this.deps.dashboard.emit({ type: "status", sessionId: s.sessionId, battery, note });
  }

  onDisconnect(deviceId: string): void {
    this.unregisterChannel(deviceId);
    // Socket is gone: purge without trying to send session_end down a dead pipe.
    this.#end(this.#byDevice.get(deviceId), "error", false);
  }

  // -------------------------------------------------------------------------
  // SceneGate detection handler (wire: new SceneGate(…, orchestrator.onDetection, …))
  // -------------------------------------------------------------------------

  readonly onDetection: DetectionHandler = (sessionId: string, det: StableDetection): void => {
    const s = this.#sessions.get(sessionId);
    if (!s || s.closed) return;

    // Defensive: SceneGate's single-flight latch should already prevent this.
    if (s.state === "IDENTIFYING" || s.state === "SCANNING") {
      this.deps.gate.flightDone(sessionId);
      return;
    }

    if (det.class === "banner") {
      // D13 no-match backoff: the gate keeps calling this a banner but identify
      // could not resolve it. Without this the lens loops ack -> hint -> ack for
      // as long as the wearer keeps looking at it. No ack, no hint, no LLM call.
      const heldMs = this.#backoffLeftMs(s, det.orgHint);
      if (heldMs > 0) {
        const key = backoffKey(det.orgHint);
        this.#log.info("identify backoff", { sessionId, orgHint: key, leftMs: heldMs });
        this.deps.dashboard.emit({
          type: "status",
          sessionId,
          note: `identify backoff (${key}) ${Math.ceil(heldMs / 1000)} s`,
        });
        this.deps.gate.flightDone(sessionId);
        return;
      }

      // Replace-on-change guard (D11/D13): a presented set holds the lens for
      // PAGE1_MIN_SEC before a different company may replace it.
      if (s.card && this.#now() - s.card.shownAt < PAGE1_MIN_SEC * 1000) {
        this.#log.info("banner suppressed by PAGE1_MIN_SEC guard", { sessionId });
        this.deps.gate.flightDone(sessionId);
        return;
      }
      // The gate drops every frame until flightDone — say so once on the Feed instead of going silent.
      this.deps.dashboard.emit({ type: "status", sessionId, note: `gate paused: identifying ${det.orgHint ?? "banner"}` });
      void this.#runIdentify(s, det);
      return;
    }
    this.#requestPhoto(s);
  };

  // -------------------------------------------------------------------------
  // ARMED
  // -------------------------------------------------------------------------

  #arm(channel: DeviceChannel): Session {
    const sessionId = `s_${++this.#sessionCounter}`;
    const session: Session = {
      sessionId,
      deviceId: channel.deviceId,
      channel,
      state: "ARMED",
      profile: null,
      card: null,
      pendingPhoto: null,
      rotationTimer: null,
      backoff: new Map(),
      lastGateErrorAt: 0,
      closed: false,
    };
    this.#sessions.set(sessionId, session);
    this.#byDevice.set(channel.deviceId, session);
    this.deps.gate.reset(sessionId);
    this.#sendArmed(session);
    this.deps.dashboard.emit({ type: "session", sessionId, state: "started" });
    this.#log.info("armed", { sessionId, deviceId: channel.deviceId, deviceType: channel.deviceType });

    // Profile is pre-loaded so the pitch stage never pays for it (DESIGN.md §3.2 F6).
    void this.deps
      .getProfile()
      .then((p) => {
        if (!session.closed) session.profile = p;
      })
      .catch((err: unknown) => this.#log.warn("profile preload failed", { err: String(err) }));

    return session;
  }

  #sendArmed(session: Session): void {
    // INTEGRATION(X-MACHINE):
    // COUNTERPART: glassbridge/Wingman/FrameSampler.swift (cadence + downscale) and
    //   HudRenderer.swift (renderMinGapMs coalescing) — both read these overrides.
    // CONTRACT: DESIGN.md §4.2 `armed` message + Appendix D — config is OPTIONAL and
    //   server-authoritative; devices apply it when present, else compiled defaults.
    // AT-INTEGRATION: confirm glasses cadence changes after editing shared/constants.ts
    //   and redeploying Cortex — no Swift rebuild should be needed.
    session.channel.send({
      type: "armed",
      sessionId: session.sessionId,
      config: deviceConfig(),
    });
  }

  // -------------------------------------------------------------------------
  // IDENTIFYING
  // -------------------------------------------------------------------------

  async #runIdentify(s: Session, det: StableDetection): Promise<void> {
    s.state = "IDENTIFYING";
    // The previous set's page rotation must not fire while Identifying…/Researching… holds the lens —
    // it re-rendered the OLD company over the new search. Resumed only on the keep-the-old-card paths.
    this.#clearRotation(s);
    const cardId = this.#renderAck(s, det.orgHint);
    try {
      const identified = await withDeadline(this.deps.identifier.identify(det.jpeg), T_IDENTIFY_MS);
      if (s.closed) return;
      if (identified.kind !== "ok") {
        this.#degrade(
          s,
          identified.kind === "timeout" ? "identify_timeout" : "llm_down",
          "Still looking",
          ["Could not read that banner.", "Move a little closer."],
        );
        this.#startBackoff(s, det.orgHint);
        s.state = "ARMED";
        return;
      }

      const result = identified.value;
      if (result.confidence < CONF_THRESHOLD) {
        // D13: the operator still sees the doubt on the feed. The lens no longer
        // goes silent for it — a name we can research beats showing nothing.
        this.deps.dashboard.emit({
          type: "silenced_identify",
          sessionId: s.sessionId,
          nameGuess: result.nameGuess,
          confidence: result.confidence,
        });
      }

      // Unsure = no corpus hit, or a corpus guess below the bar. Either way the
      // live research path owns it (ContextService: exact row -> Tavily -> condense),
      // behind its own card because it is seconds, not milliseconds.
      const unsure = result.corpusId === null || result.confidence < CONF_THRESHOLD;
      const name = result.nameGuess?.trim() || det.orgHint?.trim() || null;
      if (unsure && !name) {
        // Nothing to research with: no corpus id, no name, no orgHint.
        this.#degrade(s, "no_match", "No match", ["Nothing readable on that banner."]);
        this.#startBackoff(s, det.orgHint);
        s.state = "ARMED";
        return;
      }
      if (unsure && name) this.#renderResearching(s, cardId, name);

      const resolved = await withDeadline(
        this.deps.context.resolve(
          unsure
            ? { corpusId: null, nameGuess: name }
            : { corpusId: result.corpusId, nameGuess: result.nameGuess },
        ),
        unsure ? T_RESEARCH_MS : T_SEARCH_MS,
      );
      if (s.closed) return;
      if (resolved.kind !== "ok") {
        // A thrown resolve means the search backend itself is unusable (dead
        // Tavily key, HTTP error) — say search_down, not "no match".
        const why = resolved.kind === "timeout" ? "timeout" : errText(resolved.error);
        this.deps.dashboard.emit({ type: "status", sessionId: s.sessionId, note: `search_down: ${why}` });
        this.#degrade(s, "search_down", "Pulling details", [
          name ?? "That company.",
          "Details are taking a moment.",
        ]);
        this.#startBackoff(s, det.orgHint);
        s.state = "ARMED";
        return;
      }
      if (resolved.value === null) {
        this.#degrade(s, "no_match", "No match", [
          name ? `Nothing found for ${name}.` : "Nothing found for that banner.",
        ]);
        this.#startBackoff(s, det.orgHint);
        s.state = "ARMED";
        return;
      }

      const ctx = resolved.value;
      if (ctx.note) this.deps.dashboard.emit({ type: "status", sessionId: s.sessionId, note: ctx.note });
      if (s.card && s.card.companyId === ctx.companyId) {
        // Same company again — suppressed (the COOLDOWN_MIN cooldown owns this).
        this.deps.gate.startCooldown(s.sessionId, ctx.companyId);
        this.#resumeCard(s);
        return;
      }
      if (this.deps.gate.isCooledDown?.(s.sessionId, ctx.companyId)) {
        // D13: company A stays suppressed for COOLDOWN_MIN even after the card
        // moved on to company B — drop the detection silently.
        this.#resumeCard(s);
        return;
      }
      this.#present(s, ctx, result.confidence);
    } finally {
      this.deps.gate.flightDone(s.sessionId);
    }
  }

  /** ms left on the no-match backoff for this gate orgHint (0 = free to identify). */
  #backoffLeftMs(s: Session, orgHint: string | null): number {
    const key = backoffKey(orgHint);
    const until = s.backoff.get(key);
    if (until === undefined) return 0;
    const left = until - this.#now();
    if (left <= 0) {
      s.backoff.delete(key);
      return 0;
    }
    return left;
  }

  /** Keyed on the GATE's orgHint, not identify's nameGuess: that string is the
   *  only thing the next stable detection carries, so it is the only key that
   *  can suppress the loop. A different banner is unaffected. */
  #startBackoff(s: Session, orgHint: string | null): void {
    s.backoff.set(backoffKey(orgHint), this.#now() + NO_MATCH_BACKOFF_SEC * 1000);
  }

  // -------------------------------------------------------------------------
  // PRESENTING
  // -------------------------------------------------------------------------

  #present(s: Session, ctx: CompanyContext, confidence: number): void {
    this.#clearRotation(s);
    const hasPitch = s.profile !== null;
    const card: CardSet = {
      cardId: `c_${++this.#cardCounter}`,
      seq: 0,
      kind: "company",
      companyId: ctx.companyId,
      confidence,
      page1: ctx.card,
      page2: null,
      pages: hasPitch ? 2 : 1,
      scanLines: [],
      currentPage: 1,
      shownAt: this.#now(),
    };
    s.card = card;
    s.state = "PRESENTING";
    this.#renderCard(s, card);
    this.deps.gate.startCooldown(s.sessionId, ctx.companyId);
    this.#log.info("presenting", { sessionId: s.sessionId, companyId: ctx.companyId, cardId: card.cardId });

    if (hasPitch) {
      void this.#runPitch(s, ctx, card);
      this.#scheduleRotation(s, card, PAGE1_MIN_SEC * 1000);
    }
  }

  async #runPitch(s: Session, ctx: CompanyContext, card: CardSet): Promise<void> {
    const profile = s.profile;
    if (!profile) return;
    const pitched = await withDeadline(this.deps.pitch.pitchPage(profile, ctx), T_PITCH_MS);
    if (s.closed || s.card !== card) return; // replaced meanwhile — drop the stale pitch
    if (pitched.kind === "ok") {
      card.page2 = pitched.value;
      return;
    }
    // Degraded page 2 — rotation still works, the lens never shows a dead page.
    card.page2 = {
      title: card.page1.title,
      subtitle: "Your pitch",
      lines: ["Pitch unavailable right now.", "Page 1 has the talking points."],
    };
    this.#log.warn("pitch unavailable", { sessionId: s.sessionId, kind: pitched.kind, err: pitched.kind === "error" ? String((pitched as { error?: unknown }).error ?? "") : undefined });
    this.#sendError(s, "llm_down", "pitch unavailable");
  }

  /** Identify ended without a new set: put the current card back on the lens (the ack covered it) and
   *  restart its rotation; with no card at all this is a plain return to ARMED. */
  #resumeCard(s: Session): void {
    const card = s.card;
    if (!card) {
      s.state = "ARMED";
      return;
    }
    s.state = "PRESENTING";
    this.#renderCard(s, card);
    if (card.pages === 2) this.#scheduleRotation(s, card, ROTATE_SEC * 1000);
  }

  #scheduleRotation(s: Session, card: CardSet, delayMs: number): void {
    this.#clearRotation(s);
    s.rotationTimer = setTimeout(() => this.#rotate(s, card), delayMs);
  }

  /** Every rotation is just another `render` with the same cardId and a higher seq. */
  #rotate(s: Session, card: CardSet): void {
    if (s.closed || s.card !== card) return;
    const next: 1 | 2 = card.currentPage === 1 ? 2 : 1;
    if (next === 2 && card.page2 === null) {
      // Pitch not ready yet — hold page 1 and try again next interval.
      this.#scheduleRotation(s, card, ROTATE_SEC * 1000);
      return;
    }
    card.currentPage = next;
    this.#renderCard(s, card);
    this.#scheduleRotation(s, card, ROTATE_SEC * 1000);
  }

  #clearRotation(s: Session): void {
    if (s.rotationTimer) {
      clearTimeout(s.rotationTimer);
      s.rotationTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // SCANNING
  // -------------------------------------------------------------------------

  #requestPhoto(s: Session): void {
    s.state = "SCANNING";
    const reqId = `r_${++this.#reqCounter}`;
    const timer = setTimeout(() => {
      if (s.closed || !s.pendingPhoto || s.pendingPhoto.reqId !== reqId) return;
      s.pendingPhoto = null;
      this.#failScan(s, "capture timed out");
    }, T_PHOTO_MS);
    s.pendingPhoto = { reqId, timer };
    s.channel.send({ type: "capture_photo", reqId, quality: "document" });
    this.#log.info("capture_photo", { sessionId: s.sessionId, reqId });
  }

  async #runExtract(s: Session, jpeg: Buffer): Promise<void> {
    try {
      // AMBIGUITY: Appendix D has no T_SCAN_MS; the extraction stage reuses T_PITCH_MS
      // (the other opus-5 deadline). The F7 budget is < 8 s end to end.
      const extracted = await withDeadline(this.deps.scan.extract(jpeg), T_PITCH_MS);
      if (s.closed) return;
      if (extracted.kind !== "ok") {
        this.#failScan(s, extracted.kind === "timeout" ? "extraction timed out" : "extraction failed");
        return;
      }
      const lines = extracted.value.lines;
      if (s.card) {
        // Merge into the live card set (same cardId, higher seq).
        s.card.scanLines = lines;
        s.card.currentPage = 1;
        this.#renderCard(s, s.card);
      } else {
        // Standalone scan card (SCANNING with no company context).
        const card: CardSet = {
          cardId: `c_${++this.#cardCounter}`,
          seq: 0,
          kind: "scan",
          companyId: null,
          confidence: 1,
          page1: {
            title: "Pamphlet",
            subtitle: "From the document",
            lines,
          },
          page2: null,
          pages: 1,
          scanLines: [],
          currentPage: 1,
          shownAt: this.#now(),
        };
        s.card = card;
        this.#renderCard(s, card);
      }
      s.state = "PRESENTING";
    } finally {
      this.deps.gate.flightDone(s.sessionId);
    }
  }

  /** Scan failures keep the company card set — the next rotation restores it. */
  #failScan(s: Session, message: string): void {
    this.#degrade(s, "photo_failed", "Could not read that", [message]);
    s.state = s.card ? "PRESENTING" : "ARMED";
    this.deps.gate.flightDone(s.sessionId);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Returns the cardId so the research card can replace it in place. */
  #renderAck(s: Session, orgHint: string | null): string {
    const cardId = `c_${++this.#cardCounter}`;
    const card: HudCard = {
      cardId,
      seq: 1,
      kind: "ack",
      title: "Identifying…",
      ...(orgHint ? { subtitle: clamp(orgHint, 48) } : {}),
      footer: "Wingman",
      streaming: true,
    };
    this.#send(s, card);
    return cardId;
  }

  /** The live research path costs seconds (Tavily + condense) — say so instead
   *  of holding "Identifying…" until T_RESEARCH_MS. */
  #renderResearching(s: Session, cardId: string, name: string): void {
    this.#send(s, {
      cardId,
      seq: 2,
      kind: "ack",
      title: "Researching…",
      subtitle: clamp(name, 48),
      lines: [clamp(`Looking up ${name}.`, 40)],
      footer: "Wingman",
    });
  }

  #renderCard(s: Session, card: CardSet): void {
    const content = card.currentPage === 2 && card.page2 ? card.page2 : card.page1;
    const lines =
      card.currentPage === 1 ? [...content.lines, ...card.scanLines].slice(0, 5) : content.lines.slice(0, 5);
    const hud: HudCard = {
      cardId: card.cardId,
      seq: ++card.seq,
      kind: card.kind,
      title: clamp(content.title, 28),
      subtitle: clamp(content.subtitle, 48),
      lines: lines.map((l) => clamp(l, 40)),
      footer: card.pages === 2 ? `Wingman · ${card.currentPage}/2` : "Wingman",
      ...(card.pages === 2 ? { page: { index: card.currentPage, count: 2 } } : {}),
      streaming: false,
      ...(card.companyId ? { company: { companyId: card.companyId, confidence: card.confidence } } : {}),
      ...(card.currentPage === 1 ? { minDisplaySec: PAGE1_MIN_SEC } : {}),
    };
    this.#send(s, hud);
  }

  /** Degraded hint/error card — a stage missed its deadline; the lens never hangs. */
  #degrade(s: Session, code: ErrorCode, title: string, lines: string[]): void {
    this.#sendError(s, code, title);
    if (code === "identify_timeout" || code === "llm_down" || code === "no_match" || code === "search_down") {
      // IDENTIFYING failures drop back to a clean ARMED (DESIGN.md §3.3).
      this.#clearRotation(s);
      s.card = null;
    }
    this.#send(s, {
      cardId: `c_${++this.#cardCounter}`,
      seq: 1,
      kind: "hint",
      title: clamp(title, 28),
      lines: lines.map((l) => clamp(l, 40)).slice(0, 5),
      footer: "Wingman",
    });
  }

  #send(s: Session, card: HudCard): void {
    s.channel.send({ type: "render", card });
    this.deps.dashboard.emit({ type: "render", sessionId: s.sessionId, card });
  }

  #sendError(s: Session, code: ErrorCode, message: string): void {
    s.channel.send({ type: "error", code, message, recoverable: true });
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  #end(s: Session | undefined, reason: "user_stop" | "error", notifyDevice: boolean): void {
    if (!s || s.closed) return;
    s.closed = true;
    this.#clearRotation(s);
    if (s.pendingPhoto) {
      clearTimeout(s.pendingPhoto.timer);
      s.pendingPhoto = null;
    }
    if (notifyDevice) s.channel.send({ type: "session_end", reason });
    this.deps.gate.reset(s.sessionId);
    this.deps.dashboard.emit({ type: "session", sessionId: s.sessionId, state: "ended", reason });
    // Session memory purged: card set, profile, context (DESIGN.md §3.3 / D14).
    s.card = null;
    s.profile = null;
    this.#sessions.delete(s.sessionId);
    if (this.#byDevice.get(s.deviceId) === s) this.#byDevice.delete(s.deviceId);
    this.#log.info("session ended", { sessionId: s.sessionId, reason });
  }

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // --- test/inspection affordances (not part of OrchestratorApi) ------------

  stateOf(sessionId: string): SessionState | null {
    return this.#sessions.get(sessionId)?.state ?? null;
  }

  deviceTypeOf(sessionId: string): DeviceType | null {
    return this.#sessions.get(sessionId)?.channel.deviceType ?? null;
  }
}

function backoffKey(orgHint: string | null): string {
  return orgHint?.trim().toLowerCase() || "*";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
