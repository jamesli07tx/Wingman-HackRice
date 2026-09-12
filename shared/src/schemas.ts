// DESIGN.md Appendix C — structured-output schemas for every LLM call, as Zod
// (v4). Wire-equivalent to the JSON Schemas in the appendix (strictObject =
// additionalProperties: false, all fields required unless noted). Cortex
// passes these through zodOutputFormat() into output_config.format; tests
// validate fixtures and doc examples against them.

import { z } from "zod";
import type { ProfileSummary, SummaryCardContent } from "./protocol.js";

// C1 · Gate (claude-opus-5 effort low by default; GATE_MODEL=claude-haiku-4-5 for the cheap gate)
export const GateResultSchema = z.strictObject({
  class: z.enum(["banner", "document", "nothing"]),
  orgHint: z.string().max(60).nullable(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

// C2 · Identify (claude-opus-5, effort low). corpusId must come from the
// provided corpus list or be null; null + nameGuess -> Tavily path;
// confidence < CONF_THRESHOLD -> silence (D13).
export const IdentifyResultSchema = z.strictObject({
  corpusId: z.string().nullable(),
  nameGuess: z.string().max(80).nullable(),
  confidence: z.number().min(0).max(1),
});
export type IdentifyResult = z.infer<typeof IdentifyResultSchema>;

// C3 · Summary card — used by corpus enrich.ts pre-generation AND the Tavily
// live path (one schema, one prompt).
export const SummaryCardSchema = z.strictObject({
  title: z.string().max(28),
  subtitle: z.string().max(48),
  lines: z.array(z.string().max(40)).min(3).max(5),
}) satisfies z.ZodType<SummaryCardContent>;

// C4 · Pitch page — same shape as C3; title fixed to the company name,
// subtitle "Your pitch", lines = 3-5 personalized talking points grounded
// ONLY in the profile and company record (prompt forbids invented experience).
export const PitchPageSchema = SummaryCardSchema;

// C5 · Scan extraction (claude-opus-5 vision, document photo).
// lines renders directly; roles/deadlines merge into the company record.
export const ScanExtractionSchema = z.strictObject({
  lines: z.array(z.string().max(40)).min(1).max(5),
  roles: z.array(z.string().max(60)),
  deadlines: z.array(z.string().max(60)),
});
export type ScanExtraction = z.infer<typeof ScanExtractionSchema>;

// C6 · ProfileSummary (resume PDF -> §4.1 shape).
export const ProfileSummarySchema = z.strictObject({
  name: z.string(),
  headline: z.string(),
  skills: z.array(z.string()),
  experiences: z.array(
    z.strictObject({ org: z.string(), role: z.string(), highlight: z.string() }),
  ),
  interests: z.array(z.string()),
  links: z.record(z.string(), z.string()),
}) satisfies z.ZodType<ProfileSummary>;
