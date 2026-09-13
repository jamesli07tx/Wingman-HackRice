// Per-company evidence (Tavily, import-time, never throws) and card writing
// (opus-5 on the SAME card rules as the live path; clamp, don't reject).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUMMARY_CARD_RULES } from "@wingman/shared";

const { opusParse } = vi.hoisted(() => ({ opusParse: vi.fn() }));
vi.mock("../../src/llm/anthropic.js", () => ({
  opusParse,
  gateClassify: vi.fn(),
  opusVisionContent: vi.fn(),
  pdfContent: vi.fn(),
  gateModel: vi.fn(),
  client: vi.fn(),
  OPUS: "claude-opus-5",
  HAIKU: "claude-haiku-4-5",
  RefusalError: class RefusalError extends Error {},
}));

import {
  CARD_EFFORT,
  cardUserTurn,
  clampToContract,
  makeOpusCardWriter,
  makeTavilyEvidence,
} from "../../src/fairs/enrich.js";
import type { FetchLike } from "../../src/fairs/fetchPage.js";
import { IMPORT_CARD_SYSTEM } from "../../src/fairs/prompts.js";

beforeEach(() => {
  opusParse.mockReset();
});

describe("clampToContract", () => {
  it("clamps to the C3 limits instead of rejecting an overshoot", () => {
    const r = clampToContract({
      summaryMd: "s".repeat(700),
      roles: Array.from({ length: 10 }, () => "r".repeat(70)),
      card: {
        title: "T".repeat(40),
        subtitle: "S".repeat(60),
        lines: ["1", "2", "3", "4", "5", "6"].map((l) => l.repeat(50)),
      },
    });
    expect(r.summaryMd).toHaveLength(600);
    expect(r.roles).toHaveLength(8);
    expect(r.roles[0]).toHaveLength(60);
    expect(r.card.title).toHaveLength(28);
    expect(r.card.subtitle).toHaveLength(48);
    expect(r.card.lines).toHaveLength(5);
    for (const l of r.card.lines) expect(l.length).toBeLessThanOrEqual(40);
  });
});

describe("cardUserTurn", () => {
  it("says UNAVAILABLE without evidence and embeds evidence otherwise", () => {
    const none = cardUserTurn({ name: "Acme", aliases: [], fairName: "HackRice 16", evidence: null });
    expect(none).toContain("Company: Acme");
    expect(none).toContain("Event: HackRice 16");
    expect(none).toContain("UNAVAILABLE");
    const some = cardUserTurn({ name: "Acme", aliases: ["ACME Corp"], fairName: "F", evidence: "Acme builds rockets" });
    expect(some).toContain("Also known as: ACME Corp");
    expect(some).toContain("Acme builds rockets");
    expect(some).not.toContain("UNAVAILABLE");
  });
});

describe("makeTavilyEvidence", () => {
  it("returns null without a key and never calls fetch", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    expect(await makeTavilyEvidence({ fetchImpl })("Acme")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("flattens answer + results and sends the bearer key with a basic search", async () => {
    let seen: { url: string; init: Parameters<FetchLike>[1] } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          answer: "MathWorks makes MATLAB",
          results: [{ title: "Careers", url: "https://mathworks.com/careers", content: "Hiring interns" }],
        }),
      };
    };
    const ev = await makeTavilyEvidence({ fetchImpl, apiKey: "tv-key" })("MathWorks");
    expect(ev).toContain("MathWorks makes MATLAB");
    expect(ev).toContain("Careers (https://mathworks.com/careers)");
    expect(ev).toContain("Hiring interns");
    expect(seen!.init?.headers?.authorization).toBe("Bearer tv-key");
    const body = JSON.parse(seen!.init?.body ?? "{}") as { search_depth: string; query: string; max_results: number };
    expect(body.search_depth).toBe("basic");
    expect(body.max_results).toBe(5);
    expect(body.query).toContain("MathWorks");
  });

  it("returns null on an HTTP error, an empty result, or a thrown fetch (never throws)", async () => {
    const http: FetchLike = async () => ({ ok: false, status: 432, text: async () => "", json: async () => ({}) });
    expect(await makeTavilyEvidence({ fetchImpl: http, apiKey: "k" })("Acme")).toBeNull();
    const empty: FetchLike = async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ results: [] }) });
    expect(await makeTavilyEvidence({ fetchImpl: empty, apiKey: "k" })("Acme")).toBeNull();
    const thrown: FetchLike = async () => {
      throw new Error("socket hang up");
    };
    expect(await makeTavilyEvidence({ fetchImpl: thrown, apiKey: "k" })("Acme")).toBeNull();
  });

  it("caps the evidence length", async () => {
    const big: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ answer: "x".repeat(10_000) }),
    });
    const ev = await makeTavilyEvidence({ fetchImpl: big, apiKey: "k", maxChars: 500 })("Acme");
    expect(ev).toHaveLength(500);
  });
});

describe("makeOpusCardWriter", () => {
  it("uses IMPORT_CARD_SYSTEM (ending in the shared card rules) at the fixed effort and clamps", async () => {
    opusParse.mockResolvedValue({
      summaryMd: "MathWorks builds MATLAB and Simulink.",
      roles: ["Software Engineer Intern"],
      card: {
        title: "MathWorks",
        subtitle: "MATLAB and Simulink",
        lines: ["Hiring: SWE Intern", "MATLAB, Simulink, C++", "Natick, MA headquarters", "x".repeat(80)],
      },
    });
    const r = await makeOpusCardWriter()({ name: "MathWorks", aliases: [], fairName: "HackRice 16", evidence: "ev" });
    expect(r.card.title).toBe("MathWorks");
    expect(r.card.lines[3]).toHaveLength(40);
    const call = opusParse.mock.calls[0]![0] as { system: string; effort: string; content: string };
    expect(call.system).toBe(IMPORT_CARD_SYSTEM);
    expect(IMPORT_CARD_SYSTEM.endsWith(SUMMARY_CARD_RULES)).toBe(true);
    expect(call.effort).toBe(CARD_EFFORT);
    expect(call.content).toContain("Company: MathWorks");
  });
});
