// D13 churn rules are the product's core tuning (DESIGN.md §3.3) — this is the
// test that proves stability, single-flight and cooldown behave. No network:
// the Anthropic helper module is mocked wholesale.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { COOLDOWN_MIN, T_GATE_MS } from "@wingman/shared";
import type { GateResult } from "@wingman/shared";

const { gateClassify } = vi.hoisted(() => ({ gateClassify: vi.fn() }));

vi.mock("../../src/llm/anthropic.js", () => ({
  gateClassify,
  gateModel: () => "claude-opus-5",
  opusParse: vi.fn(),
  opusVisionContent: vi.fn(),
  pdfContent: vi.fn(),
}));

import { GATE_SYSTEM_PROMPT, GATE_USER_TEXT, SceneGate } from "../../src/gate/SceneGate.js";
import type { GateDebug, StableDetection } from "../../src/interfaces.js";

const FRAME = Buffer.from("fake-jpeg-bytes");
const banner: GateResult = { class: "banner", orgHint: "Stripe" };
const doc: GateResult = { class: "document", orgHint: null };
const nothing: GateResult = { class: "nothing", orgHint: null };

/** What the real gateClassify resolves with (result + debug round trip). */
function ok(result: GateResult) {
  return {
    result,
    model: "claude-opus-5",
    rawText: JSON.stringify(result),
    stopReason: "end_turn",
    inputTokens: 1203,
    outputTokens: 21,
    latencyMs: 1900,
    error: null,
  };
}

function harness(opts: { now?: () => number } = {}) {
  const detections: { sessionId: string; det: StableDetection }[] = [];
  const telemetry: { sessionId: string; seq: number; result: GateResult }[] = [];
  const debug: { sessionId: string; seq: number; d: GateDebug }[] = [];
  const notes: string[] = [];
  const gate = new SceneGate(
    (sessionId, det) => detections.push({ sessionId, det }),
    (sessionId, seq, result) => telemetry.push({ sessionId, seq, result }),
    {
      now: opts.now,
      onNote: (_s, _q, note) => notes.push(note),
      onDebug: (sessionId, seq, d) => debug.push({ sessionId, seq, d }),
    },
  );
  return { gate, detections, telemetry, debug, notes };
}

beforeEach(() => {
  gateClassify.mockReset();
});

describe("SceneGate — C1 prompt", () => {
  it("sends the Appendix C1 system prompt verbatim and byte-stable", async () => {
    gateClassify.mockResolvedValue(ok(nothing));
    const { gate } = harness();
    await gate.onFrame("s1", 1, FRAME);
    await gate.onFrame("s1", 2, FRAME);

    expect(GATE_SYSTEM_PROMPT).toContain(
      "You classify a single first-person frame from smart glasses at a career fair.",
    );
    expect(GATE_SYSTEM_PROMPT).toContain("If banner, put the most legible organization name in orgHint.");
    const systems = gateClassify.mock.calls.map((c) => (c[0] as { system: string }).system);
    expect(systems).toEqual([GATE_SYSTEM_PROMPT, GATE_SYSTEM_PROMPT]);
  });
});

describe("SceneGate — stability tracker (STABILITY_N = 2)", () => {
  it("emits telemetry for every frame but no detection on a single banner", async () => {
    gateClassify.mockResolvedValueOnce(ok(nothing)).mockResolvedValueOnce(ok(banner));
    const { gate, detections, telemetry } = harness();

    await gate.onFrame("s1", 1, FRAME);
    await gate.onFrame("s1", 2, FRAME);

    expect(telemetry.map((t) => t.result.class)).toEqual(["nothing", "banner"]);
    expect(detections).toHaveLength(0);
  });

  it("fires exactly once on the second consecutive banner", async () => {
    gateClassify.mockResolvedValue(ok(banner));
    const { gate, detections } = harness();

    await gate.onFrame("s1", 1, FRAME);
    expect(detections).toHaveLength(0);
    await gate.onFrame("s1", 2, FRAME);

    expect(detections).toHaveLength(1);
    expect(detections[0].sessionId).toBe("s1");
    expect(detections[0].det).toEqual({ class: "banner", orgHint: "Stripe", jpeg: FRAME });
  });

  it("resets the streak when the class changes (a glance never fires)", async () => {
    gateClassify
      .mockResolvedValueOnce(ok(banner))
      .mockResolvedValueOnce(ok(nothing))
      .mockResolvedValueOnce(ok(banner))
      .mockResolvedValueOnce(ok(doc));
    const { gate, detections } = harness();

    for (let seq = 1; seq <= 4; seq++) await gate.onFrame("s1", seq, FRAME);

    expect(detections).toHaveLength(0);
  });

  it("tracks stability per session", async () => {
    gateClassify.mockResolvedValue(ok(banner));
    const { gate, detections } = harness();

    await gate.onFrame("s1", 1, FRAME);
    await gate.onFrame("s2", 1, FRAME);

    expect(detections).toHaveLength(0);
  });
});

describe("SceneGate — single-flight latch", () => {
  it("drops frames (no classify, no telemetry) while a flight is open", async () => {
    gateClassify.mockResolvedValue(ok(banner));
    const { gate, detections, telemetry, notes } = harness();

    await gate.onFrame("s1", 1, FRAME);
    await gate.onFrame("s1", 2, FRAME); // stable -> detection, latch closes
    expect(detections).toHaveLength(1);

    const classifyCallsAtLatch = gateClassify.mock.calls.length;
    const telemetryAtLatch = telemetry.length;

    await gate.onFrame("s1", 3, FRAME);
    await gate.onFrame("s1", 4, FRAME);

    expect(gateClassify.mock.calls.length).toBe(classifyCallsAtLatch);
    expect(telemetry.length).toBe(telemetryAtLatch);
    expect(detections).toHaveLength(1);
    expect(notes.filter((n) => n.startsWith("dropped"))).toHaveLength(2);
  });

  it("releases on flightDone and needs a FRESH run of N to fire again", async () => {
    gateClassify.mockResolvedValue(ok(banner));
    const { gate, detections } = harness();

    await gate.onFrame("s1", 1, FRAME);
    await gate.onFrame("s1", 2, FRAME);
    expect(detections).toHaveLength(1);

    gate.flightDone("s1");

    await gate.onFrame("s1", 3, FRAME);
    expect(detections).toHaveLength(1); // streak was reset by the emit
    await gate.onFrame("s1", 4, FRAME);
    expect(detections).toHaveLength(2);
  });
});

describe("SceneGate — cooldown map (Appendix D COOLDOWN_MIN)", () => {
  it("records a cooldown the orchestrator can consult, and expires it", () => {
    let clock = 1_000_000;
    const { gate } = harness({ now: () => clock });

    expect(gate.isCooledDown("s1", "stripe")).toBe(false);
    gate.startCooldown("s1", "stripe");
    expect(gate.isCooledDown("s1", "stripe")).toBe(true);
    expect(gate.cooldownRemainingMs("s1", "stripe")).toBe(COOLDOWN_MIN * 60_000);

    clock += COOLDOWN_MIN * 60_000 - 1_000;
    expect(gate.isCooledDown("s1", "stripe")).toBe(true);

    clock += 1_000; // past COOLDOWN_MIN
    expect(gate.isCooledDown("s1", "stripe")).toBe(false);
    expect(gate.cooldownRemainingMs("s1", "stripe")).toBe(0);
  });

  it("does not suppress a different company, and is per-session", () => {
    const { gate } = harness({ now: () => 0 });
    gate.startCooldown("s1", "stripe");
    expect(gate.isCooledDown("s1", "ramp")).toBe(false);
    expect(gate.isCooledDown("s2", "stripe")).toBe(false);
  });

  it("reset() purges stability, latch and cooldowns (D14 session purge)", async () => {
    gateClassify.mockResolvedValue(ok(banner));
    const { gate, detections } = harness({ now: () => 0 });

    await gate.onFrame("s1", 1, FRAME);
    await gate.onFrame("s1", 2, FRAME);
    gate.startCooldown("s1", "stripe");
    expect(detections).toHaveLength(1);

    gate.reset("s1");

    expect(gate.isCooledDown("s1", "stripe")).toBe(false);
    // latch is gone too: two fresh frames fire again with no flightDone call
    await gate.onFrame("s1", 3, FRAME);
    await gate.onFrame("s1", 4, FRAME);
    expect(detections).toHaveLength(2);
  });
});

describe("SceneGate — T_GATE_MS timeout", () => {
  it("treats a hung classify as 'nothing' and notes it", async () => {
    vi.useFakeTimers();
    try {
      gateClassify.mockImplementation(() => new Promise(() => {}));
      const { gate, telemetry, detections, notes } = harness();

      const pending = gate.onFrame("s1", 1, FRAME);
      await vi.advanceTimersByTimeAsync(T_GATE_MS + 1);
      await pending;

      expect(telemetry).toEqual([{ sessionId: "s1", seq: 1, result: { class: "nothing", orgHint: null } }]);
      expect(detections).toHaveLength(0);
      expect(notes.some((n) => n.includes("gate timeout"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a classify error as 'nothing' rather than throwing", async () => {
    gateClassify.mockRejectedValue(new Error("rate_limited"));
    const { gate, telemetry, notes } = harness();

    await expect(gate.onFrame("s1", 1, FRAME)).resolves.toBeUndefined();
    expect(telemetry[0].result.class).toBe("nothing");
    expect(notes.some((n) => n.includes("gate error"))).toBe(true);
  });
});

describe("SceneGate — gate_debug feed", () => {
  it("reports the full round trip for a normal classify", async () => {
    gateClassify.mockResolvedValue(ok(banner));
    const { gate, debug } = harness();

    await gate.onFrame("s1", 7, FRAME);

    expect(debug).toHaveLength(1);
    expect(debug[0]).toMatchObject({ sessionId: "s1", seq: 7 });
    expect(debug[0].d).toEqual({
      model: "claude-opus-5",
      systemPrompt: GATE_SYSTEM_PROMPT,
      userText: GATE_USER_TEXT,
      rawResponse: JSON.stringify(banner),
      stopReason: "end_turn",
      inputTokens: 1203,
      outputTokens: 21,
      latencyMs: 1900,
      error: null,
      result: banner,
    });
  });

  it("reports a truncated/empty response as an error with result null", async () => {
    gateClassify.mockResolvedValue({
      ...ok(nothing),
      result: null,
      rawText: null,
      stopReason: "max_tokens",
      error: "gate: structured output missing",
    });
    const { gate, debug, telemetry } = harness();

    await gate.onFrame("s1", 1, FRAME);

    expect(telemetry[0].result).toEqual(nothing); // still fails safe
    expect(debug[0].d).toMatchObject({
      result: null,
      rawResponse: null,
      stopReason: "max_tokens",
      error: "gate: structured output missing",
    });
  });

  it("reports the timeout as an error, with latency = the deadline", async () => {
    vi.useFakeTimers();
    try {
      gateClassify.mockImplementation(() => new Promise(() => {}));
      const { gate, debug } = harness();

      const pending = gate.onFrame("s1", 1, FRAME);
      await vi.advanceTimersByTimeAsync(T_GATE_MS + 1);
      await pending;

      expect(debug).toHaveLength(1);
      expect(debug[0].d).toMatchObject({
        rawResponse: null,
        stopReason: null,
        latencyMs: T_GATE_MS,
        error: `gate timeout after ${T_GATE_MS}ms`,
        result: null,
      });
      expect(debug[0].d.systemPrompt).toBe(GATE_SYSTEM_PROMPT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a thrown classify error", async () => {
    gateClassify.mockRejectedValue(new Error("rate_limited"));
    const { gate, debug } = harness();

    await gate.onFrame("s1", 1, FRAME);

    expect(debug[0].d).toMatchObject({ error: "rate_limited", rawResponse: null, result: null });
  });
});
