// Fair list import · enrich.ts — evidence + card for ONE company.
// Evidence: a Tavily basic search (1 credit), made at IMPORT time by this
// module. The live-search logic in ContextService is untouched (design grill
// Q1): at the booth an imported company is a corpus hit, everything else still
// takes the existing Tavily path.
// Card: opus-5 on IMPORT_CARD_SYSTEM with the lenient decode + mechanical clamp
// + strict re-validation discipline of corpus/enrich.ts (a length overshoot
// must never fail deterministically on every retry).

import { z } from "zod";
import { SummaryCardSchema } from "@wingman/shared";
import { opusParse, type Effort } from "../llm/anthropic.js";
import type { FetchLike } from "./fetchPage.js";
import { IMPORT_CARD_SYSTEM } from "./prompts.js";

export const EnrichResultSchema = z.strictObject({
  summaryMd: z.string().min(1).max(600),
  roles: z.array(z.string().max(60)).max(8),
  card: SummaryCardSchema,
});
export type EnrichResult = z.infer<typeof EnrichResultSchema>;

export const LenientResultSchema = z.object({
  summaryMd: z.string().min(1),
  roles: z.array(z.string()),
  card: z.object({
    title: z.string().min(1),
    subtitle: z.string().min(1),
    lines: z.array(z.string()).min(3),
  }),
});
export type LenientResult = z.infer<typeof LenientResultSchema>;

const clampLine = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function clampToContract(raw: LenientResult): EnrichResult {
  return EnrichResultSchema.parse({
    summaryMd: raw.summaryMd.slice(0, 600),
    roles: raw.roles.slice(0, 8).map((r) => clampLine(r, 60)),
    card: {
      title: clampLine(raw.card.title, 28),
      subtitle: clampLine(raw.card.subtitle, 48),
      lines: raw.card.lines.slice(0, 5).map((l) => clampLine(l, 40)),
    },
  });
}

// --- evidence ---------------------------------------------------------------

export type EvidenceSearch = (name: string) => Promise<string | null>;

export interface TavilyOptions {
  fetchImpl: FetchLike;
  apiKey?: string;
  timeoutMs?: number;
  url?: string;
  maxChars?: number;
}

const TAVILY_URL = "https://api.tavily.com/search";
const TAVILY_TIMEOUT_MS = 10_000;
const EVIDENCE_MAX_CHARS = 6_000;

/** Never throws and never retries: a Tavily hiccup must not fail an import —
 *  the card prompt handles "UNAVAILABLE" by staying general. */
export function makeTavilyEvidence(opts: TavilyOptions): EvidenceSearch {
  const url = opts.url ?? TAVILY_URL;
  return async (name) => {
    const apiKey = opts.apiKey?.trim();
    if (!apiKey) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TAVILY_TIMEOUT_MS);
    try {
      const res = await opts.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          api_key: apiKey,
          query: `${name} company overview hiring university recruiting`,
          search_depth: "basic",
          include_answer: true,
          max_results: 5,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        answer?: string | null;
        results?: { title?: string; url?: string; content?: string }[];
      };
      const parts: string[] = [];
      if (body.answer) parts.push(body.answer);
      for (const r of body.results ?? []) {
        parts.push(`${r.title ?? ""} (${r.url ?? ""})\n${r.content ?? ""}`.trim());
      }
      const evidence = parts
        .filter(Boolean)
        .join("\n\n")
        .trim()
        .slice(0, opts.maxChars ?? EVIDENCE_MAX_CHARS);
      return evidence.length > 0 ? evidence : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

// --- card -------------------------------------------------------------------

export interface CardInput {
  name: string;
  aliases: string[];
  fairName: string;
  evidence: string | null;
}

export type CardWriter = (input: CardInput) => Promise<EnrichResult>;

/** Volatile material lives in the user turn, after the cached system prompt. */
export function cardUserTurn(input: CardInput): string {
  return [
    `Company: ${input.name}`,
    `Also known as: ${input.aliases.join(", ") || "(no aliases on file)"}`,
    `Event: ${input.fairName} (this organization is listed as exhibiting or sponsoring there)`,
    "",
    input.evidence
      ? `Web search results (may be partial or noisy):\n---\n${input.evidence}\n---`
      : "Web search results: UNAVAILABLE. Use well-known public facts about this organization only.",
  ].join("\n");
}

export const CARD_EFFORT: Effort = "low";

export function makeOpusCardWriter(opts: { effort?: Effort; maxTokens?: number } = {}): CardWriter {
  return async (input) =>
    clampToContract(
      await opusParse({
        system: IMPORT_CARD_SYSTEM,
        content: cardUserTurn(input),
        schema: LenientResultSchema,
        effort: opts.effort ?? CARD_EFFORT,
        maxTokens: opts.maxTokens ?? 4096,
      }),
    );
}
