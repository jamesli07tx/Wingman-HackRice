// C2: the corpus name/alias list lives in the SYSTEM prompt and must be
// byte-stable across calls, or prompt caching stops paying (DESIGN.md §2).

import { beforeEach, describe, expect, it, vi } from "vitest";

const { opusParse, opusVisionContent } = vi.hoisted(() => ({
  opusParse: vi.fn(),
  opusVisionContent: vi.fn((b64: string, text: string) => [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
    { type: "text", text },
  ]),
}));
vi.mock("../../src/llm/anthropic.js", () => ({
  opusParse,
  opusVisionContent,
  haikuClassify: vi.fn(),
  pdfContent: vi.fn(),
}));

import {
  buildIdentifySystemPrompt,
  IdentifyService,
  IDENTIFY_RULES,
} from "../../src/identify/IdentifyService.js";
import type { IdentifyCorpusEntry } from "../../src/identify/IdentifyService.js";

const CORPUS: IdentifyCorpusEntry[] = [
  { companyId: "stripe", name: "Stripe", aliases: ["Stripe Inc", "stripe.com"] },
  { companyId: "chevron", name: "Chevron", aliases: ["Chevron Corporation"] },
  { companyId: "ramp", name: "Ramp", aliases: [] },
];

const FRAME = Buffer.from("fake-jpeg-bytes");

beforeEach(() => {
  opusParse.mockReset();
  opusVisionContent.mockClear();
});

describe("IdentifyService — prompt stability", () => {
  it("builds the same system prompt regardless of corpus input order", () => {
    const shuffled = [CORPUS[2], CORPUS[0], CORPUS[1]];
    expect(buildIdentifySystemPrompt(shuffled)).toBe(buildIdentifySystemPrompt(CORPUS));
  });

  it("sorts by companyId and keeps the C2 rules ahead of the list", () => {
    const prompt = buildIdentifySystemPrompt(CORPUS);
    expect(prompt.startsWith(IDENTIFY_RULES)).toBe(true);
    expect(prompt).toContain("chevron | Chevron | Chevron Corporation");
    expect(prompt).toContain("ramp | Ramp | ");
    expect(prompt).toContain("stripe | Stripe | Stripe Inc, stripe.com");
    expect(prompt.indexOf("chevron |")).toBeLessThan(prompt.indexOf("ramp |"));
    expect(prompt.indexOf("ramp |")).toBeLessThan(prompt.indexOf("stripe |"));
  });

  it("sends a byte-identical system prompt on every call (cache-stable)", async () => {
    opusParse.mockResolvedValue({ corpusId: "stripe", nameGuess: "Stripe", confidence: 0.93 });
    const svc = new IdentifyService(CORPUS);

    await svc.identify(FRAME);
    await svc.identify(Buffer.from("another-frame"));

    const systems = opusParse.mock.calls.map((c) => (c[0] as { system: string }).system);
    expect(systems[0]).toBe(systems[1]);
    expect(systems[0]).toBe(svc.systemPrompt);
    // and equal to a freshly built prompt for the same list
    expect(systems[0]).toBe(buildIdentifySystemPrompt(CORPUS));
  });

  it("uses effort 'low', ~512 max tokens, and puts the image before the instruction", async () => {
    opusParse.mockResolvedValue({ corpusId: null, nameGuess: null, confidence: 0 });
    await new IdentifyService(CORPUS).identify(FRAME);

    const call = opusParse.mock.calls[0][0] as {
      effort: string;
      maxTokens: number;
      content: { type: string }[];
    };
    expect(call.effort).toBe("low");
    expect(call.maxTokens).toBe(512);
    expect(call.content[0].type).toBe("image");
    expect(call.content[1].type).toBe("text");
    expect(opusVisionContent).toHaveBeenCalledWith(FRAME.toString("base64"), expect.any(String));
  });
});

describe("IdentifyService — corpusId discipline (C2)", () => {
  it("passes through an id that is in the list", async () => {
    opusParse.mockResolvedValue({ corpusId: "ramp", nameGuess: "Ramp", confidence: 0.8 });
    const res = await new IdentifyService(CORPUS).identify(FRAME);
    expect(res).toEqual({ corpusId: "ramp", nameGuess: "Ramp", confidence: 0.8 });
  });

  it("nulls an invented id but keeps the nameGuess for the Tavily path", async () => {
    opusParse.mockResolvedValue({ corpusId: "acme", nameGuess: "Acme Corp", confidence: 0.71 });
    const res = await new IdentifyService(CORPUS).identify(FRAME);
    expect(res).toEqual({ corpusId: null, nameGuess: "Acme Corp", confidence: 0.71 });
  });

  it("handles an empty corpus without producing a malformed prompt", async () => {
    opusParse.mockResolvedValue({ corpusId: "stripe", nameGuess: "Stripe", confidence: 0.9 });
    const svc = new IdentifyService([]);
    expect(svc.systemPrompt).toContain("always answer with corpusId null");
    expect((await svc.identify(FRAME)).corpusId).toBeNull();
  });
});
