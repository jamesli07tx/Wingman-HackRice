// Fair list import · extract.ts — ONE structured opus-5 call turns page text or
// a roster image into { fairName, companies[] } (one schema for both entry
// points, design grill Q3). Output is normalised here: trimmed, de-duplicated
// case-insensitively, clamped to the DTO limits, capped at MAX_COMPANIES.

import { z } from "zod";
import { opusParse } from "../llm/anthropic.js";
import { LIST_EXTRACTION_SYSTEM, LIST_EXTRACTION_USER_TEXT } from "./prompts.js";

export const MAX_COMPANIES = 300;
export const NAME_MAX = 80;
const ALIAS_MAX = 60;
const ALIASES_MAX = 8;

export const ListExtractionSchema = z.object({
  fairName: z.string().nullable(),
  companies: z.array(z.object({ name: z.string(), aliases: z.array(z.string()) })),
});
export type ListExtraction = z.infer<typeof ListExtractionSchema>;

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export type ExtractionInput =
  | { kind: "text"; text: string; sourceUrl: string; title: string | null }
  | { kind: "image"; base64: string; mediaType: ImageMediaType };

export type Extractor = (input: ExtractionInput) => Promise<ListExtraction>;

/** Case/punctuation/accent-insensitive identity for names and aliases
 *  ("Jeni's Ice-Creams" and "JENIS ICE CREAMS" collide). */
export function key(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’`"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clean(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max).trimEnd();
}

export function normalizeExtraction(raw: ListExtraction): ListExtraction {
  const seen = new Set<string>();
  const companies: ListExtraction["companies"] = [];
  for (const c of raw.companies) {
    const name = clean(c.name ?? "", NAME_MAX);
    const k = key(name);
    if (name.length < 2 || k.length === 0 || seen.has(k)) continue;
    seen.add(k);
    const aliases: string[] = [];
    for (const a of c.aliases ?? []) {
      const alias = clean(a ?? "", ALIAS_MAX);
      const ak = key(alias);
      if (alias.length < 2 || ak.length === 0 || ak === k || aliases.some((x) => key(x) === ak)) continue;
      aliases.push(alias);
      if (aliases.length >= ALIASES_MAX) break;
    }
    companies.push({ name, aliases });
    if (companies.length >= MAX_COMPANIES) break;
  }
  const fairName = raw.fairName ? clean(raw.fairName, NAME_MAX) : "";
  return { fairName: fairName.length > 0 ? fairName : null, companies };
}

type OpusContent = Parameters<typeof opusParse>[0]["content"];

/** Image FIRST, instruction last (DESIGN.md §2); text inputs are one string. */
export function extractionContent(input: ExtractionInput): OpusContent {
  if (input.kind === "image") {
    return [
      {
        type: "image",
        source: { type: "base64", media_type: input.mediaType, data: input.base64 },
      },
      { type: "text", text: LIST_EXTRACTION_USER_TEXT },
    ];
  }
  return [
    `Source URL: ${input.sourceUrl}`,
    `Page title: ${input.title ?? "(none)"}`,
    "",
    "Page text (navigation and unrelated sections included):",
    "---",
    input.text,
    "---",
    "",
    LIST_EXTRACTION_USER_TEXT,
  ].join("\n");
}

export const EXTRACTION_EFFORT = "medium" as const;

export const extractWithOpus: Extractor = async (input) =>
  normalizeExtraction(
    await opusParse({
      system: LIST_EXTRACTION_SYSTEM,
      content: extractionContent(input),
      schema: ListExtractionSchema,
      effort: EXTRACTION_EFFORT,
      maxTokens: 8192,
    }),
  );

/** Magic-byte sniff only — a declared mimetype is not trusted (the API would reject a mismatch). */
export function sniffImageType(buf: Buffer): ImageMediaType | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buf.length >= 6) {
    const head = buf.toString("ascii", 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  return null;
}
