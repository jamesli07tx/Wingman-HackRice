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
  NO_MATCH_BACKOFF_SEC,
  PAGE1_MIN_SEC, T_PITCH_MS,
  ROTATE_SEC,
  T_IDENTIFY_MS,
  T_PHOTO_MS,
  deviceConfig,
} from "@wingman/shared";
import { ContextService } from "../../src/context/ContextService.js";
import type { SummaryCardSummarizer } from "../../src/context/ContextService.js";
import { makeFakeFetch, makeFakeSupabase } from "../services/fakes.js";
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
    readonly userId = "u_1",
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

function harness(opts: { profile?: ProfileSummary | null; context?: ContextProvider } = {}) {
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
  const context: ContextProvider = opts.context ?? { resolve, byId, search: async () => [] };
  const pitch: PitchServiceApi = { pitchPage };
  const scan: ScanServiceApi = { extract };

  const getUserCard = vi.fn<(userId: string, companyId: string) => Promise<SummaryCardContent | null>>(async () => null);
  const orch = new SessionOrchestrator({
    gate,
    identifier,
    context,
    pitch,
    scan,
    getProfile: async () => (opts.profile === undefined ? PROFILE : opts.profile),
    getUserCard,
    dashboard: { emit: (e) => dashboardEvents.push(e) },
    logger: silentLogger,
  });

  return { orch, channel, gate, dashboardEvents, identify, resolve, byId, pitchPage, extract, getUserCard };
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

  it("a run of 'nothing' frames never cancels an in-flight identify — card and pitch still land", async () => {
    const h = harness();
    const sessionId = await arm(h);

    // Identify is slow; the wearer has already looked away by the time it answers.
    let answer!: (r: IdentifyResult) => void;
    h.identify.mockReturnValueOnce(new Promise<IdentifyResult>((r) => (answer = r)));

    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.orch.stateOf(sessionId)).toBe("IDENTIFYING");

    // Three blank frames while the flight is open: forwarded to the gate, inert here.
    for (const seq of [11, 12, 13]) h.orch.onFrame("dev_1", seq, Buffer.from("blank"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.gate.frames.map((f) => f.seq)).toEqual([11, 12, 13]);
    expect(h.orch.stateOf(sessionId)).toBe("IDENTIFYING");

    answer({ corpusId: "stripe", nameGuess: "Stripe", confidence: 0.93 });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.channel.lastCard()).toMatchObject({
      kind: "company",
      title: "stripe",
      page: { index: 1, count: 2 },
    });
    expect(h.pitchPage).toHaveBeenCalledTimes(1);
    expect(h.orch.stateOf(sessionId)).toBe("PRESENTING");

    // …and the pitch page still rotates in behind it.
    await vi.advanceTimersByTimeAsync(PAGE1_MIN_SEC * 1000);
    expect(h.channel.lastCard()).toMatchObject({
      page: { index: 2, count: 2 },
      subtitle: "Your pitch",
    });
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
    // page 1 holds, the rotation finds no page 2 yet and retries; the pitch
    // degrades at T_PITCH_MS and the NEXT rotation shows it.
    // Degrades at T_PITCH_MS (now longer than PAGE1_MIN_SEC); the NEXT rotation after that shows it.
    await vi.advanceTimersByTimeAsync(Math.max(T_PITCH_MS, PAGE1_MIN_SEC * 1000) + ROTATE_SEC * 1000);

    const last = h.channel.lastCard()!;
    expect(last).toMatchObject({ page: { index: 2, count: 2 }, subtitle: "Your pitch" });
    expect(last.lines?.[0]).toContain("Pitch unavailable");
    expect(h.channel.errors().map((e) => e.code)).toContain("llm_down");
  });

  it("unsure identify with a name: Researching… card, then the researched company card", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.identify.mockResolvedValueOnce({
      corpusId: null,
      nameGuess: "Maybe Stripe",
      confidence: CONF_THRESHOLD - 0.01,
    });
    h.resolve.mockResolvedValueOnce(companyContext("maybe-stripe"));

    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);

    const cards = h.channel.cards();
    expect(cards[0]).toMatchObject({ kind: "ack", title: "Identifying…" });
    expect(cards[1]).toMatchObject({
      cardId: cards[0]!.cardId, // replaces the ack in place
      seq: 2,
      kind: "ack",
      title: "Researching…",
      subtitle: "Maybe Stripe",
      lines: ["Looking up Maybe Stripe."],
      footer: "Wingman",
    });
    // live path, not the corpus guess
    expect(h.resolve).toHaveBeenCalledWith({ corpusId: null, nameGuess: "Maybe Stripe" });
    expect(cards[2]).toMatchObject({ kind: "company", title: "maybe-stripe" });
    expect(h.orch.stateOf(sessionId)).toBe("PRESENTING");
    // the operator still sees the doubt on the feed (D13)
    expect(h.dashboardEvents).toContainEqual({
      type: "silenced_identify",
      sessionId,
      nameGuess: "Maybe Stripe",
      confidence: CONF_THRESHOLD - 0.01,
    });
  });

  it("the previous card never rotates back over Researching… while a new identify is in flight", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(PAGE1_MIN_SEC * 1000 + ROTATE_SEC * 1000); // stripe 1/2 → 2/2 → 1/2, rotating

    let finish!: (ctx: ReturnType<typeof companyContext>) => void;
    h.identify.mockResolvedValueOnce({ corpusId: null, nameGuess: "Ramp", confidence: CONF_THRESHOLD - 0.01 });
    h.resolve.mockReturnValueOnce(new Promise((r) => (finish = r)));
    h.orch.onDetection(sessionId, banner("Ramp"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channel.cards().at(-1)).toMatchObject({ kind: "ack", title: "Researching…", subtitle: "Ramp" });
    const during = h.channel.cards().length;

    // A full rotation period passes while the research is out (inside T_RESEARCH_MS) — nothing else may be rendered.
    await vi.advanceTimersByTimeAsync(ROTATE_SEC * 1000 + 1000);
    expect(h.channel.cards()).toHaveLength(during);

    finish(companyContext("ramp"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channel.cards().at(-1)).toMatchObject({ kind: "company", title: "ramp" });
  });

  it("the user's own brief replaces page 1 for their session and feeds the pitch", async () => {
    const h = harness();
    const sessionId = await arm(h);
    const mine: SummaryCardContent = { title: "Stripe (my notes)", subtitle: "Talk to Priya", lines: ["Ask about the intern return offer.", "Mention the billing project.", "Booth 12."] };
    h.getUserCard.mockResolvedValueOnce(mine);
    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.getUserCard).toHaveBeenCalledWith("u_1", "stripe");
    expect(h.channel.cards().at(-1)).toMatchObject({ kind: "company", title: "Stripe (my notes)", lines: mine.lines });
    expect(h.pitchPage).toHaveBeenCalledWith(PROFILE, expect.objectContaining({ card: mine }));
  });

  it("a slow user-card lookup never delays the shared card", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.getUserCard.mockReturnValueOnce(new Promise(() => undefined));
    h.orch.onDetection(sessionId, banner());
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.channel.cards().at(-1)).toMatchObject({ kind: "company", title: "stripe" });
  });

  it("unsure with no name anywhere: hint + backoff, nothing to research", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.identify.mockResolvedValueOnce({ corpusId: null, nameGuess: null, confidence: 0.1 });

    h.orch.onDetection(sessionId, banner(null));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.channel.lastCard()).toMatchObject({ kind: "hint", title: "No match" });
    expect(h.orch.stateOf(sessionId)).toBe("ARMED");

    // the "*" key is backed off too — a nameless banner cannot loop either
    h.orch.onDetection(sessionId, banner(null));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.identify).toHaveBeenCalledTimes(1);
  });

  it("no_match backs the same orgHint off: no ack/hint loop, then re-identifies", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.resolve.mockResolvedValueOnce(null);

    h.orch.onDetection(sessionId, banner("Stripe"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channel.lastCard()).toMatchObject({ kind: "hint", title: "No match" });
    const afterFirst = h.channel.cards().length; // ack + hint, rendered once

    // The wearer keeps looking; the gate keeps firing. The lens stays put.
    h.orch.onDetection(sessionId, banner("Stripe"));
    h.orch.onDetection(sessionId, banner(" stripe ")); // same key, different casing
    await vi.advanceTimersByTimeAsync(0);
    expect(h.identify).toHaveBeenCalledTimes(1);
    expect(h.channel.cards()).toHaveLength(afterFirst);
    expect(h.gate.flights).toHaveLength(3); // latch released on every suppression
    expect(
      h.dashboardEvents.filter((e) => e.type === "status" && e.note?.startsWith("identify backoff")),
    ).toHaveLength(2);

    // Window expires -> the same banner is fair game again.
    await vi.advanceTimersByTimeAsync(NO_MATCH_BACKOFF_SEC * 1000);
    h.orch.onDetection(sessionId, banner("Stripe"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.identify).toHaveBeenCalledTimes(2);
    expect(h.channel.lastCard()).toMatchObject({ kind: "company", title: "stripe" });
  });

  it("a different orgHint bypasses another banner's backoff", async () => {
    const h = harness();
    const sessionId = await arm(h);
    h.resolve.mockResolvedValueOnce(null);
    h.orch.onDetection(sessionId, banner("Stripe"));
    await vi.advanceTimersByTimeAsync(0);

    h.identify.mockResolvedValueOnce({ corpusId: "ramp", nameGuess: "Ramp", confidence: 0.9 });
    h.resolve.mockResolvedValueOnce(companyContext("ramp"));
    h.orch.onDetection(sessionId, banner("Ramp"));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.identify).toHaveBeenCalledTimes(2);
    expect(h.channel.lastCard()).toMatchObject({ kind: "company", title: "ramp" });
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

    // page1 + rotation + the resumed card (the ack covered the lens; rotation was paused for the identify)
    expect(h.channel.cards().filter((c) => c.kind === "company")).toHaveLength(3);
    expect(h.channel.cards().length).toBe(before + 2); // ack, then the same card back
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

// The research path for real: SessionOrchestrator -> ContextService.resolve ->
// Tavily REST -> condense -> present. Only fetch and Supabase are faked.
describe("SessionOrchestrator + ContextService live research path", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => vi.useRealTimers());

  const RAMP_CARD: SummaryCardContent = {
    title: "Ramp",
    subtitle: "Corporate cards and spend management",
    lines: ["Hiring: SWE Intern (NYC)", "Stack: TypeScript, Go", "Recently: launched Ramp AI"],
  };

  function research(fetchFake: ReturnType<typeof makeFakeFetch>, summarize: SummaryCardSummarizer) {
    const supabase = makeFakeSupabase(() => ({ data: null, error: null })); // empty corpus
    const context = new ContextService(supabase.client, fetchFake.fetchImpl, summarize, {
      tavilyApiKey: "tvly-test",
    });
    return harness({ context });
  }

  it("a name the corpus does not have is searched on Tavily and rendered as a company card", async () => {
    const fetchFake = makeFakeFetch({
      answer: "Ramp is a corporate card and spend management company.",
      results: [
        { title: "Ramp careers", url: "https://ramp.com/careers", content: "SWE Intern, New York." },
      ],
    });
    const summarize = vi.fn(async () => RAMP_CARD);
    const h = research(fetchFake, summarize);
    const sessionId = await arm(h);
    h.identify.mockResolvedValueOnce({ corpusId: null, nameGuess: "Ramp", confidence: 0.7 });

    h.orch.onDetection(sessionId, banner("Ramp"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchFake.calls).toHaveLength(1);
    expect(fetchFake.calls[0].url).toBe("https://api.tavily.com/search");
    const init = fetchFake.calls[0].init as { headers: Record<string, string>; body: string };
    expect(init.headers.authorization).toBe("Bearer tvly-test");
    expect(JSON.parse(init.body)).toMatchObject({ api_key: "tvly-test", max_results: 5, include_answer: true });
    expect(summarize).toHaveBeenCalledTimes(1);

    expect(h.channel.cards().map((c) => c.title)).toEqual(["Identifying…", "Researching…", "Ramp"]);
    expect(h.channel.lastCard()).toMatchObject({
      kind: "company",
      company: { companyId: "ramp", confidence: 0.7 },
    });
    expect(h.channel.lastCard()!.lines).toEqual(RAMP_CARD.lines);
  });

  it("Tavily HTTP 5xx is search_down on the lens and the feed, and backs the banner off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFake = makeFakeFetch({}, { ok: false, status: 503 });
    const summarize = vi.fn(async () => RAMP_CARD);
    const h = research(fetchFake, summarize);
    const sessionId = await arm(h);
    h.identify.mockResolvedValueOnce({ corpusId: null, nameGuess: "Ramp", confidence: 0.7 });

    h.orch.onDetection(sessionId, banner("Ramp"));
    await vi.advanceTimersByTimeAsync(1300); // 800 ms backoff + jitter for the single retry

    expect(summarize).not.toHaveBeenCalled();
    expect(fetchFake.calls).toHaveLength(2); // 5xx is retried exactly once, then final
    expect(h.channel.errors().map((e) => e.code)).toContain("search_down");
    expect(h.channel.lastCard()).toMatchObject({ kind: "hint", title: "Pulling details" });
    expect(h.dashboardEvents).toContainEqual({
      type: "status",
      sessionId,
      note: "search_down: tavily HTTP 503",
    });
    expect(warn.mock.calls[0]?.[0]).toContain("tavily HTTP 503");

    // and the same banner does not loop straight back into it
    h.orch.onDetection(sessionId, banner("Ramp"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.identify).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
