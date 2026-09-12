// Acceptance check, DESIGN_WINDOWS.md §2 step 2: every JSON example in
// DESIGN.md §4 embedded LITERALLY and validated against protocol.ts types
// (compile-time) and schemas.ts (runtime). If the doc and this file disagree,
// the doc wins — fix the transcription, never the doc.

import { describe, expect, it } from "vitest";
import {
  CONF_THRESHOLD,
  deviceConfig,
  FRAME_INTERVAL_MS,
  GateResultSchema,
  IdentifyResultSchema,
  ProfileSummarySchema,
  ScanExtractionSchema,
  SummaryCardSchema,
} from "../src/index.js";
import type {
  ArmedMsg,
  CapturePhotoMsg,
  CortexToDeviceMsg,
  DeviceToCortexMsg,
  ErrorMsg,
  FrameMsg,
  HelloMsg,
  HudCard,
  PhotoErrorMsg,
  PhotoMsg,
  ProfileSummary,
  RenderMsg,
  SessionEndMsg,
  StatusMsg,
} from "../src/index.js";

describe("DESIGN.md §4.2 device → cortex examples", () => {
  it("compile and round-trip through the discriminated union", () => {
    const hello: HelloMsg = {
      type: "hello",
      deviceType: "glasses_bridge",
      caps: { video: true, photoHiRes: true },
    };
    const frame: FrameMsg = {
      type: "frame",
      seq: 412,
      ts: 1757700000123,
      mime: "image/jpeg",
      dataBase64: "…",
    };
    const photo: PhotoMsg = { type: "photo", reqId: "r_18", mime: "image/jpeg", dataBase64: "…" };
    const photoError: PhotoErrorMsg = { type: "photo_error", reqId: "r_18", reason: "capture_failed" };
    const status: StatusMsg = { type: "status", battery: 0.61, note: "reconnected" };

    const all: DeviceToCortexMsg[] = [
      hello,
      { type: "session_start" },
      { type: "session_stop" },
      frame,
      photo,
      photoError,
      status,
    ];
    for (const msg of all) {
      const roundTripped = JSON.parse(JSON.stringify(msg)) as DeviceToCortexMsg;
      expect(roundTripped.type).toBe(msg.type);
    }
  });
});

describe("DESIGN.md §4.2 cortex → device examples", () => {
  it("armed carries the optional server-authoritative config", () => {
    const armed: ArmedMsg = {
      type: "armed",
      sessionId: "s_42",
      config: { frameIntervalMs: 1750, frameMaxEdgePx: 768, docMaxEdgePx: 2048, renderMinGapMs: 500 },
    };
    expect(armed.config).toEqual(deviceConfig());
    expect(deviceConfig().frameIntervalMs).toBe(FRAME_INTERVAL_MS);
  });

  it("remaining messages compile as the union", () => {
    const capture: CapturePhotoMsg = { type: "capture_photo", reqId: "r_18", quality: "document" };
    const sessionEnd: SessionEndMsg = { type: "session_end", reason: "user_stop" };
    const error: ErrorMsg = { type: "error", code: "gate_down", message: "…", recoverable: true };
    const all: CortexToDeviceMsg[] = [capture, sessionEnd, error];
    expect(all).toHaveLength(3);
  });

  it("the HudCard example from the doc compiles and respects renderer limits", () => {
    // NOTE: DESIGN.md §4.2's example line "Recently: launched usage-based
    // billing APIs" is 43 chars — over its own Appendix C3 cap of 40.
    // Appendix C is normative (Cortex enforces it at generation time), so the
    // line is shortened here. Flagged to the human; Mac side treats 40 as the
    // ceiling too.
    const card: HudCard = {
      cardId: "c_007",
      seq: 3,
      kind: "company",
      title: "Stripe",
      subtitle: "Payments infrastructure for the internet",
      lines: [
        "Hiring: SWE Intern, New Grad Backend",
        "Stack: Ruby, Go, ML infra at scale",
        "Recently: usage-based billing APIs",
      ],
      footer: "Wingman · 1/2",
      page: { index: 1, count: 2 },
      streaming: false,
      company: { companyId: "stripe", confidence: 0.93 },
      minDisplaySec: 15,
    };
    const render: RenderMsg = { type: "render", card };
    expect(render.card.lines!.length).toBeLessThanOrEqual(5);
    for (const line of render.card.lines!) expect(line.length).toBeLessThanOrEqual(40);
    expect(card.company!.confidence).toBeGreaterThanOrEqual(CONF_THRESHOLD);
  });
});

describe("DESIGN.md Appendix C schemas", () => {
  it("C1 gate accepts doc-shaped results and rejects junk", () => {
    expect(GateResultSchema.parse({ class: "banner", orgHint: "Stripe" })).toBeTruthy();
    expect(GateResultSchema.parse({ class: "nothing", orgHint: null })).toBeTruthy();
    expect(() => GateResultSchema.parse({ class: "face", orgHint: null })).toThrow();
    expect(() => GateResultSchema.parse({ class: "banner", orgHint: null, extra: 1 })).toThrow();
  });

  it("C2 identify enforces confidence bounds and nullables", () => {
    expect(
      IdentifyResultSchema.parse({ corpusId: "stripe", nameGuess: null, confidence: 0.93 }),
    ).toBeTruthy();
    expect(
      IdentifyResultSchema.parse({ corpusId: null, nameGuess: "Acme Robotics", confidence: 0.4 }),
    ).toBeTruthy();
    expect(() =>
      IdentifyResultSchema.parse({ corpusId: null, nameGuess: null, confidence: 1.4 }),
    ).toThrow();
  });

  it("C3 summary card enforces the lens limits (28/48/3-5×40)", () => {
    const fromDocExample = {
      title: "Stripe",
      subtitle: "Payments infrastructure for the internet",
      lines: [
        "Hiring: SWE Intern, New Grad Backend",
        "Stack: Ruby, Go, ML infra at scale",
        "Recently: usage-based billing APIs",
      ],
    };
    expect(SummaryCardSchema.parse(fromDocExample)).toBeTruthy();
    expect(() =>
      SummaryCardSchema.parse({ ...fromDocExample, lines: fromDocExample.lines.slice(0, 2) }),
    ).toThrow(); // min 3 lines
    expect(() =>
      SummaryCardSchema.parse({ ...fromDocExample, title: "x".repeat(29) }),
    ).toThrow();
  });

  it("C5 scan extraction shape", () => {
    expect(
      ScanExtractionSchema.parse({
        lines: ["SWE Intern: apps close Oct 15"],
        roles: ["SWE Intern"],
        deadlines: ["Oct 15 — SWE Intern"],
      }),
    ).toBeTruthy();
  });

  it("C6 profile summary matches the §4.1 doc example", () => {
    const docExample: ProfileSummary = {
      name: "James Li",
      headline: "CS @ UT Austin, class of 2027",
      skills: ["TypeScript", "Python", "embedded systems"],
      experiences: [
        { org: "Guadaloop", role: "Software lead", highlight: "Built telemetry pipeline for hyperloop pod" },
      ],
      interests: ["fintech infrastructure", "AR/wearables"],
      links: { github: "https://github.com/…" },
    };
    expect(ProfileSummarySchema.parse(docExample)).toEqual(docExample);
  });
});
