// One extraction schema for both entry points; output normalised to the DTO
// limits; the model call is byte-stable (mocked — no network, no keys).

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  EXTRACTION_EFFORT,
  MAX_COMPANIES,
  extractWithOpus,
  extractionContent,
  key,
  normalizeExtraction,
  sniffImageType,
} from "../../src/fairs/extract.js";
import { LIST_EXTRACTION_SYSTEM, LIST_EXTRACTION_USER_TEXT } from "../../src/fairs/prompts.js";

beforeEach(() => {
  opusParse.mockReset();
});

describe("normalizeExtraction", () => {
  it("dedups case-insensitively, trims, drops junk, strips aliases equal to the name", () => {
    const out = normalizeExtraction({
      fairName: "  HackRice 16 ",
      companies: [
        { name: " MathWorks ", aliases: ["mathworks", "The MathWorks", "The MathWorks"] },
        { name: "MATHWORKS", aliases: [] },
        { name: "X", aliases: [] },
        { name: "Amazon Web Services", aliases: ["AWS", "aws", ""] },
      ],
    });
    expect(out.fairName).toBe("HackRice 16");
    expect(out.companies).toEqual([
      { name: "MathWorks", aliases: ["The MathWorks"] },
      { name: "Amazon Web Services", aliases: ["AWS"] },
    ]);
  });

  it("clamps the name length, caps the list, and nulls a blank fair name", () => {
    const many = Array.from({ length: MAX_COMPANIES + 5 }, (_, i) => ({ name: `Company ${i}`, aliases: [] }));
    const out = normalizeExtraction({
      fairName: "   ",
      companies: [{ name: "A".repeat(200), aliases: [] }, ...many],
    });
    expect(out.companies[0]!.name).toHaveLength(80);
    expect(out.companies).toHaveLength(MAX_COMPANIES);
    expect(out.fairName).toBeNull();
  });
});

describe("key", () => {
  it("ignores case, punctuation and accents", () => {
    expect(key("Jeni's Ice Creams")).toBe(key("JENIS ICE-CREAMS"));
    expect(key("Café Brands")).toBe(key("cafe brands"));
  });
});

describe("extractionContent", () => {
  it("image FIRST, instruction last, media type preserved", () => {
    const c = extractionContent({ kind: "image", base64: "AAA", mediaType: "image/png" });
    expect(Array.isArray(c)).toBe(true);
    const blocks = c as { type: string; source?: { media_type: string; data: string }; text?: string }[];
    expect(blocks[0]!.type).toBe("image");
    expect(blocks[0]!.source?.media_type).toBe("image/png");
    expect(blocks[0]!.source?.data).toBe("AAA");
    expect(blocks[1]).toEqual({ type: "text", text: LIST_EXTRACTION_USER_TEXT });
  });

  it("text input carries url, title and the page text, instruction last", () => {
    const c = extractionContent({
      kind: "text",
      text: "SPONSORS MathWorks",
      sourceUrl: "https://hackrice.com/",
      title: "HackRice 16",
    }) as string;
    expect(c).toContain("Source URL: https://hackrice.com/");
    expect(c).toContain("Page title: HackRice 16");
    expect(c).toContain("SPONSORS MathWorks");
    expect(c.trim().endsWith(LIST_EXTRACTION_USER_TEXT)).toBe(true);
  });
});

describe("extractWithOpus", () => {
  it("uses the byte-stable system prompt at the fixed effort and normalises the result", async () => {
    opusParse.mockResolvedValue({
      fairName: "HackRice 16",
      companies: [
        { name: "MathWorks", aliases: [] },
        { name: "mathworks", aliases: [] },
      ],
    });
    const out = await extractWithOpus({ kind: "text", text: "x", sourceUrl: "https://a.test/", title: null });
    expect(out.companies).toHaveLength(1);
    const call = opusParse.mock.calls[0]![0] as { system: string; effort: string };
    expect(call.system).toBe(LIST_EXTRACTION_SYSTEM);
    expect(call.effort).toBe(EXTRACTION_EFFORT);
  });
});

describe("sniffImageType", () => {
  it("detects png/jpeg/webp/gif by magic bytes and rejects everything else", () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
    const webp = Buffer.alloc(12);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    expect(sniffImageType(webp)).toBe("image/webp");
    expect(sniffImageType(Buffer.from("GIF89a......"))).toBe("image/gif");
    expect(sniffImageType(Buffer.from("%PDF-1.4"))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});
