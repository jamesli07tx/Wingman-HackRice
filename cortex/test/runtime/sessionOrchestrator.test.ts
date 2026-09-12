// SessionOrchestrator state-machine tests (DESIGN.md §3.3 + D13).
// Fake deps only — no network, no Supabase, no live LLM. Timers are faked, so the
// 15 s / 12 s rotation and the Appendix D deadlines run in microseconds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CortexToDeviceMsg,
  DashboardEvent,
  DeviceType,
  HudCard,
  IdentifyResult,
  ProfileSummary,
  ScanExtraction,
  SummaryCardContent,
} from "@wingman/shared";
import {
  CONF_THRESHOLD,
  PAGE1_MIN_SEC,
  ROTATE_SEC,
  T_IDENTIFY_MS,
  T_PHOTO_MS,
  deviceConfig,
} from "@wingman/shared";
import { SessionOrchestrator } from "../../src/session/SessionOrchestrator.js";
import type {
  CompanyContext,
  ContextProvider,
  DeviceChannel,
  Identifier,
  PitchServiceApi,
  ScanServiceApi,
  SceneGateApi,
  StableDetection,
} from "../../src/interfaces.js";

const silentLogger = { info: () => undefined, warn: () => undefined };

class FakeChannel implements DeviceChannel {
  readonly sent: CortexToDeviceMsg[] = [];
  closed = false;
  constructor(
    readonly deviceId = "dev_1",
    readonly deviceType: DeviceType = "phone_web",
  ) {}
  send(msg: CortexToDeviceMsg): void {
    this.sent.push(msg);
  }
  close(): void {
    this.closed = true;
  }
  cards(): HudCard[] {
    return this.sent.filter((m) => m.type === "render").map((m) => m.card);
  }
  errors(): Extract<CortexToDeviceMsg, { type: "error" }>[] {
    return this.sent.filter((m): m is Extract<CortexToDeviceMsg, { type: "error" }> => m.type === "error");
  }
  lastCard(): HudCard | undefined {
    return this.cards().at(-1);
  }
}

class FakeGate implements SceneGateApi {
  readonly frames: { sessionId: string; seq: number }[] = [];
  readonly flights: string[] = [];
  readonly cooldowns: { sessionId: string; companyId: string }[] = [];
  readonly resets: string[] = [];
  failNextFrame = false;
  async onFrame(sessionId: string, seq: number): Promise<void> {
    if (this.failNextFrame) {
      this.failNextFrame = false;
      throw new Error("gate down");
    }
    this.frames.push({ sessionId, seq });
  }
  flightDone(sessionId: string): void {
    this.flights.push(sessionId);
  }
  startCooldown(sessionId: string, companyId: string): void {
    this.cooldowns.push({ sessionId, companyId });
  }
  reset(sessionId: string): void {
    this.resets.push(sessionId);
  }
}

const PROFILE: ProfileSummary = {
  name: "James Li",
  headline: "CS @ UT Austin, class of 2027",
  skills: ["TypeScript"],
  experiences: [{ org: "Guadaloop", role: "Software lead", highlight: "telemetry pipeline" }],
  interests: ["fintech"],
  links: {},
};

function companyContext(companyId: string): CompanyContext {
  return {
    companyId,
    displayName: companyId,
    card: {
      title: companyId,
      subtitle: "Payments infrastructure",
      lines: ["Hiring: SWE Intern", "Stack: Ruby, Go", "Recently: billing APIs"],
    },
    record: null,
  };
}

const PITCH: SummaryCardContent = {
  title: "stripe",
  subtitle: "Your pitch",
  lines: ["Led telemetry at Guadaloop", "Ask about usage-based billing", "TypeScript + Go"],
};

const never = new Promise<never>(() => undefined);

function harness(opts: { profile?: ProfileSummary | null } = {}) {
  const channel = new FakeChannel();
  const gate = new FakeGate();
  const dashboardEvents: DashboardEvent[] = [];

  const identify = vi.fn<(jpeg: Buffer) => Promise<IdentifyResult>>(async () => ({
    corpusId: "stripe",
    nameGuess: "Stripe",
    confidence: 0.93,
  }));
  const resolve = vi.fn<ContextProvider["resolve"]>(async () => companyContext("stripe"));
  const byId = vi.fn<ContextProvider["byId"]>(async (id) => companyContext(id));
  const pitchPage = vi.fn<PitchServiceApi["pitchPage"]>(async () => PITCH);
  const extract = vi.fn<ScanServiceApi["extract"]>(async () => ({
    lines: ["SWE Intern — apply by Oct 15"],
    roles: ["SWE Intern"],
    deadlines: ["Oct 15"],
  }));

  const identifier: Identifier = { identify };
  const context: ContextProvider = { resolve, byId, search: async () => [] };
  const pitch: PitchServiceApi = { pitchPage };
  const scan: ScanServiceApi = { extract };

  const orch = new SessionOrchestrator({
    gate,
    identifier,
    context,
    pitch,
    scan,
    getProfile: async () => (opts.profile === undefined ? PROFILE : opts.profile),
    dashboard: { emit: (e) => dashboardEvents.push(e) },
    logger: silentLogger,
  });

  return { orch, channel, gate, dashboardEvents, identify, resolve, byId, pitchPage, extract };
}

function banner(orgHint: string | null = "Stripe"): StableDetection {
  return { class: "banner", orgHint, jpeg: Buffer.from("frame") };
}
function document(): StableDetection {
  return { class: "document", orgHint: null, jpeg: Buffer.from("doc") };
}

/** Arm a session and let the profile preload settle. */
async function arm(h: ReturnType<typeof harness>): Promise<string> {
  h.orch.onDeviceSessionStart(h.channel);
  await vi.advanceTimersByTimeAsync(0);
  return "s_1";
}

describe("SessionOrchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => vi.useRealTimers());

  it("ARMED: sends armed with the Appendix D device config and announces the session", async () => {
    const h = harness();
    const sessionId = await arm(h);

    expect(h.channel.sent[0]).toEqual({ type: "armed", sessionId, config: deviceConfig() });
    expect(h.gate.resets).toContain(sessionId);
    expect(h.dashboardEvents).toContainEqual({ type: "session", sessionId, state: "started" });
    expect(h.orch.stateOf(sessionId)).toBe("ARMED");
    expect(h.orch.activeSessionForUser()).toEqual({ sessionId, deviceId: "dev_1" });
  });

  it("frames are forwarded to SceneGate; a gate failure degrades instead of hanging", async () => {
    const h = harness();
    const sessionId = await arm(h);

    h.orch.onFrame("dev_1", 7, Buffer.from("f"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.gate.frames).toEqual([{ sessionId, seq: 7 }]);

    h.gate.failNextFrame = true;
    h.orch.onFrame("dev_1", 8, Buffer.from("f"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channel.errors().map((e) => e.code)).toContain("gate_down");
  });

  it("IDENTIFYING -> PRESENTING: ack card, then company card page 1/2, cooldown + flight released", async () => {
    const h = harness();
    const sessionId = await arm(h);

    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);

    const cards = h.channel.cards();
    expect(cards[0]).toMatchObject({ kind: "ack", title: "Identifying…", subtitle: "Stripe" });
    expect(cards[1]).toMatchObject({
      kind: "company",
      title: "stripe",
      footer: `Wingman · 1/2`,
      page: { index: 1, count: 2 },
      minDisplaySec: PAGE1_MIN_SEC,
      company: { companyId: "stripe", confidence: 0.93 },
    });
    expect(cards[1]!.lines).toEqual(["Hiring: SWE Intern", "Stack: Ruby, Go", "Recently: billing APIs"]);
    expect(h.gate.cooldowns).toEqual([{ sessionId, companyId: "stripe" }]);
    expect(h.gate.flights).toEqual([sessionId]);
    expect(h.orch.stateOf(sessionId)).toBe("PRESENTING");
    expect(h.dashboardEvents.filter((e) => e.type === "render")).toHaveLength(2);
  });

  it("rotation: page 1 holds PAGE1_MIN_SEC, then alternates every ROTATE_SEC with the same cardId", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);

    const companyCard = h.channel.cards()[1]!;
    expect(h.pitchPage).toHaveBeenCalledTimes(1);

    // Nothing rotates before PAGE1_MIN_SEC.
    await vi.advanceTimersByTimeAsync(PAGE1_MIN_SEC * 1000 - 100);
    expect(h.channel.cards()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(100);
    const page2 = h.channel.lastCard()!;
    expect(page2.cardId).toBe(companyCard.cardId);
    expect(page2.seq).toBeGreaterThan(companyCard.seq);
    expect(page2).toMatchObject({ footer: "Wingman · 2/2", page: { index: 2, count: 2 }, subtitle: "Your pitch" });
    expect(page2.lines).toEqual(PITCH.lines);

    await vi.advanceTimersByTimeAsync(ROTATE_SEC * 1000);
    const backToPage1 = h.channel.lastCard()!;
    expect(backToPage1).toMatchObject({ footer: "Wingman · 1/2", page: { index: 1, count: 2 } });
    expect(backToPage1.cardId).toBe(companyCard.cardId);
    expect(backToPage1.seq).toBeGreaterThan(page2.seq);
  });

  it("a pitch that misses T_PITCH_MS still rotates, on a degraded page 2", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.pitchPage.mockReturnValueOnce(never);

    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(PAGE1_MIN_SEC * 1000);

    const last = h.channel.lastCard()!;
    expect(last).toMatchObject({ page: { index: 2, count: 2 }, subtitle: "Your pitch" });
    expect(last.lines?.[0]).toContain("Pitch unavailable");
    expect(h.channel.errors().map((e) => e.code)).toContain("llm_down");
  });

  it("silence below CONF_THRESHOLD: dashboard-only, nothing new on the lens (D13)", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.identify.mockResolvedValueOnce({
      corpusId: null,
      nameGuess: "Maybe Stripe",
      confidence: CONF_THRESHOLD - 0.01,
    });

    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);

    expect(h.channel.cards().map((c) => c.kind)).toEqual(["ack"]); // ack only — no company card
    expect(h.dashboardEvents).toContainEqual({
      type: "silenced_identify",
      sessionId,
      nameGuess: "Maybe Stripe",
      confidence: CONF_THRESHOLD - 0.01,
    });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.orch.stateOf(sessionId)).toBe("ARMED");
    expect(h.gate.flights).toEqual([sessionId]); // latch released either way
  });

  it("identify timeout degrades to a hint card and returns to ARMED", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.identify.mockReturnValueOnce(never);

    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(T_IDENTIFY_MS);

    expect(h.channel.lastCard()).toMatchObject({ kind: "hint", title: "Still looking" });
    expect(h.channel.errors().map((e) => e.code)).toContain("identify_timeout");
    expect(h.orch.stateOf(sessionId)).toBe("ARMED");
    expect(h.gate.flights).toEqual([sessionId]);
  });

  it("no usable context degrades to a no_match hint", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.resolve.mockResolvedValueOnce(null);

    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);

    expect(h.channel.lastCard()).toMatchObject({ kind: "hint", title: "No match" });
    expect(h.channel.errors().map((e) => e.code)).toContain("no_match");
    expect(h.orch.stateOf(sessionId)).toBe("ARMED");
  });

  it("replace-on-change is guarded by PAGE1_MIN_SEC, then swaps the card set", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);
    const firstCardId = h.channel.cards()[1]!.cardId;
    const rendersBefore = h.channel.cards().length;

    // Too soon: suppressed, but the single-flight latch is still released.
    h.orch.onDetection(sessionId, banner("Ramp"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channel.cards()).toHaveLength(rendersBefore);
    expect(h.gate.flights).toHaveLength(2);
    expect(h.identify).toHaveBeenCalledTimes(1);

    // After the hold, a different company replaces the set with a NEW cardId.
    await vi.advanceTimersByTimeAsync(PAGE1_MIN_SEC * 1000);
    h.identify.mockResolvedValueOnce({ corpusId: "ramp", nameGuess: "Ramp", confidence: 0.88 });
    h.resolve.mockResolvedValueOnce(companyContext("ramp"));
    h.orch.onDetection(sessionId, banner("Ramp"));
    await vi.advanceTimersByTimeAsync(0);

    const replaced = h.channel.cards().at(-1)!;
    expect(replaced).toMatchObject({ kind: "company", title: "ramp", page: { index: 1, count: 2 } });
    expect(replaced.cardId).not.toBe(firstCardId);
    expect(h.gate.cooldowns.map((c) => c.companyId)).toEqual(["stripe", "ramp"]);
  });

  it("the same company again is suppressed and re-cools down instead of re-rendering", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PAGE1_MIN_SEC * 1000); // clears the guard (rotates to 2/2)
    const before = h.channel.cards().length;

    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);

    expect(h.channel.cards().filter((c) => c.kind === "company")).toHaveLength(2); // page1 + rotation only
    expect(h.channel.cards().length).toBe(before + 1); // just the ack
    expect(h.gate.cooldowns.map((c) => c.companyId)).toEqual(["stripe", "stripe"]);
    expect(h.orch.stateOf(sessionId)).toBe("PRESENTING");
  });

  it("SCANNING: document detection captures a photo and merges the extraction into the card", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);
    const companyCard = h.channel.cards()[1]!;

    h.orch.onDetection(sessionId, document());
    const capture = h.channel.sent.at(-1)!;
    expect(capture).toMatchObject({ type: "capture_photo", quality: "document" });
    expect(h.orch.stateOf(sessionId)).toBe("SCANNING");

    const reqId = (capture as { reqId: string }).reqId;
    h.orch.onPhoto("dev_1", reqId, Buffer.from("jpeg"));
    await vi.advanceTimersByTimeAsync(0);

    const merged = h.channel.lastCard()!;
    expect(merged.cardId).toBe(companyCard.cardId);
    expect(merged.seq).toBeGreaterThan(companyCard.seq);
    expect(merged.lines).toContain("SWE Intern — apply by Oct 15");
    expect(h.orch.stateOf(sessionId)).toBe("PRESENTING");
    expect(h.gate.flights).toHaveLength(2);
  });

  it("SCANNING with no company context renders a standalone scan card", async () => {
    const h = harness();
    const sessionId = await arm(h);

    h.orch.onDetection(sessionId, document());
    const reqId = (h.channel.sent.at(-1) as { reqId: string }).reqId;
    h.orch.onPhoto("dev_1", reqId, Buffer.from("jpeg"));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.channel.lastCard()).toMatchObject({ kind: "scan", title: "Pamphlet" });
  });

  it("a photo that never arrives degrades at T_PHOTO_MS (never a hang)", async () => {
    const h = harness();
    const sessionId = await arm(h);

    h.orch.onDetection(sessionId, document());
    await vi.advanceTimersByTimeAsync(T_PHOTO_MS);

    expect(h.channel.lastCard()).toMatchObject({ kind: "hint", title: "Could not read that" });
    expect(h.channel.errors().map((e) => e.code)).toContain("photo_failed");
    expect(h.orch.stateOf(sessionId)).toBe("ARMED");
    expect(h.gate.flights).toHaveLength(1);
  });

  it("override forces a card set, bypassing gate, confidence and the hold guard", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);

    await h.orch.override(sessionId, "ramp");
    await vi.advanceTimersByTimeAsync(0);

    expect(h.byId).toHaveBeenCalledWith("ramp");
    expect(h.identify).toHaveBeenCalledTimes(1); // override never identifies
    expect(h.channel.lastCard()).toMatchObject({
      kind: "company",
      title: "ramp",
      company: { companyId: "ramp", confidence: 1 },
    });
  });

  it("no profile: single-page card, no rotation, no pitch call", async () => {
    const h = harness({ profile: null });
    const sessionId = await arm(h);

    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(PAGE1_MIN_SEC * 1000 + ROTATE_SEC * 1000);

    const cards = h.channel.cards();
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({ footer: "Wingman" });
    expect(cards[1]!.page).toBeUndefined();
    expect(h.pitchPage).not.toHaveBeenCalled();
  });

  it("stop purges the session, ends the device session and stops the rotation timer", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);
    const before = h.channel.cards().length;

    h.orch.stop(sessionId);
    expect(h.channel.sent.at(-1)).toEqual({ type: "session_end", reason: "user_stop" });
    expect(h.dashboardEvents).toContainEqual({
      type: "session",
      sessionId,
      state: "ended",
      reason: "user_stop",
    });
    expect(h.orch.stateOf(sessionId)).toBeNull();
    expect(h.orch.activeSessionForUser()).toBeNull();
    expect(h.gate.resets.filter((s) => s === sessionId)).toHaveLength(2); // arm + stop

    await vi.advanceTimersByTimeAsync(PAGE1_MIN_SEC * 1000 + ROTATE_SEC * 2000);
    expect(h.channel.cards()).toHaveLength(before); // no zombie rotation
  });

  it("startForDevice needs a registered channel and is idempotent per device", async () => {
    const h = harness();
    expect(h.orch.startForDevice("dev_1")).toBeNull();

    h.orch.registerChannel(h.channel);
    const first = h.orch.startForDevice("dev_1");
    expect(first).toEqual({ sessionId: "s_1" });
    expect(h.orch.startForDevice("dev_1")).toEqual(first);

    h.orch.onDisconnect("dev_1");
    expect(h.orch.activeSessionForUser()).toBeNull();
    expect(h.orch.startForDevice("dev_1")).toBeNull();
  });
});
