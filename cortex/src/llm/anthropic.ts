// ORCHESTRATOR-OWNED (cross-cutting). The single Anthropic client + house
// rules from DESIGN.md §2. Every cortex module calls Claude ONLY through these
// helpers — no module constructs its own client or request shapes.
//
// House rules encoded here:
// - exact model IDs, no date suffixes
// - gate: opus-5 at effort "low" by default (GATE_MODEL overrides); haiku-4-5 takes NO thinking param
// - structured outputs via output_config.format (zodOutputFormat)
// - refusal fallbacks on every opus-5 call: betas server-side-fallback-2026-07-01 + fallbacks "default"
// - stop_reason === "refusal" checked on every response
// - prompt caching: byte-stable system prompts with cache_control; images LAST in the user turn

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export const OPUS = "claude-opus-5";
export const HAIKU = "claude-haiku-4-5";

// Resolves ANTHROPIC_API_KEY from the environment LAZILY. A module-level `new Anthropic()` ran at import
// time — before index.ts had loaded the root .env — so every deployment without the key already in the
// process environment failed with "Could not resolve authentication method" on the first LLM call.
let _client: Anthropic | undefined;
export function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export type Effort = "low" | "medium" | "high";

export class RefusalError extends Error {
  constructor(public category: string | null) {
    super(`Claude refused (category: ${category ?? "unknown"})`);
  }
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError ||
        err instanceof Anthropic.APIConnectionError;
      if (!retryable || i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i + Math.random() * 250));
    }
  }
  throw lastErr;
}

function imageBlock(jpegBase64: string) {
  return {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/jpeg" as const, data: jpegBase64 },
  };
}

function extractText(content: { type: string; text?: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * C1 gate model. Opus 5 by default — the gate has to read small, angled or
 * on-screen logos in 768 px glasses frames, where haiku missed. Set
 * GATE_MODEL=claude-haiku-4-5 (or claude-sonnet-5) to trade accuracy for
 * latency/cost. Resolved per call so index.ts's .env load order is irrelevant.
 * Measured on the fixture frames from a laptop: haiku p50 1.3 s, sonnet-5 1.7 s,
 * opus-5 (effort low) 2.1 s / p90 2.5 s — all inside T_GATE_MS.
 */
export function gateModel(): string {
  return process.env.GATE_MODEL || OPUS;
}

/**
 * C1 gate call — vision classify. Runs ~34×/min, so the byte-stable system
 * prompt is cache_control'd and the frame image comes last.
 * haiku: NO thinking param. opus/sonnet: adaptive thinking at effort "low"
 * (thinking draws from max_tokens, hence the larger cap); refusal fallbacks on opus.
 *
 * Returns the parse result PLUS what the dashboard's debug feed needs (model,
 * raw first text block, stop_reason, usage, latency). A response that arrives
 * but is unusable — refusal, no text block (stop_reason "max_tokens" with only
 * a thinking block), unparseable JSON — comes back as result null + error text
 * rather than a throw, so the raw evidence still reaches the dashboard.
 * Transport failures (rate limit, connection) still throw.
 */
export async function gateClassify<S extends z.ZodType>(opts: {
  system: string;
  jpegBase64: string;
  userText: string;
  schema: S;
  model?: string;
}): Promise<{
  result: z.infer<S> | null;
  model: string;
  rawText: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  error: string | null;
}> {
  const model = opts.model ?? gateModel();
  const isHaiku = model.includes("haiku");
  const startedAt = Date.now();
  const response = await withRetry(() =>
    client().beta.messages.create({
      model,
      max_tokens: isHaiku ? 128 : 512,
      ...(model === OPUS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [imageBlock(opts.jpegBase64), { type: "text", text: opts.userText }] },
      ],
      output_config: { format: zodOutputFormat(opts.schema), ...(isHaiku ? {} : { effort: "low" }) },
    } as never),
  );
  const rawText = extractText(response.content as { type: string; text?: string }[]) || null;
  const base = {
    model,
    rawText,
    stopReason: response.stop_reason ?? null,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
    latencyMs: Date.now() - startedAt,
  };
  if (response.stop_reason === "refusal") {
    const category =
      (response as { stop_details?: { category: string | null } }).stop_details?.category ?? null;
    return { ...base, result: null, error: new RefusalError(category).message };
  }
  if (!rawText) return { ...base, result: null, error: "gate: structured output missing" };
  try {
    return { ...base, result: opts.schema.parse(JSON.parse(rawText)) as z.infer<S>, error: null };
  } catch (err) {
    return { ...base, result: null, error: `gate: unparseable response: ${(err as Error).message}` };
  }
}

/**
 * opus-5 structured call (identify / summary / pitch / scan / resume).
 * Adaptive thinking by default (param omitted). Refusal fallbacks enabled
 * server-side; the response is zod-validated locally either way.
 */
export async function opusParse<S extends z.ZodType>(opts: {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[] | string;
  schema: S;
  effort?: Effort;
  maxTokens?: number;
  cacheSystem?: boolean;
}): Promise<z.infer<S>> {
  const response = await withRetry(() =>
    client().beta.messages.create({
      model: OPUS,
      max_tokens: opts.maxTokens ?? 2048,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        {
          type: "text",
          text: opts.system,
          ...(opts.cacheSystem !== false ? { cache_control: { type: "ephemeral" as const } } : {}),
        },
      ],
      messages: [{ role: "user", content: opts.content as never }],
      output_config: { format: zodOutputFormat(opts.schema), effort: opts.effort ?? "high" },
    } as never),
  );
  if (response.stop_reason === "refusal") {
    throw new RefusalError(
      (response as { stop_details?: { category: string | null } }).stop_details?.category ?? null,
    );
  }
  const text = extractText(response.content as { type: string; text?: string }[]);
  return opts.schema.parse(JSON.parse(text)) as z.infer<S>;
}

/** Convenience: opus-5 vision call — image first, instruction text last. */
export function opusVisionContent(jpegBase64: string, instruction: string) {
  return [imageBlock(jpegBase64), { type: "text" as const, text: instruction }];
}

/** Convenience: opus-5 PDF document block (resume parse, C6 — no beta header needed). */
export function pdfContent(pdfBase64: string, instruction: string) {
  return [
    {
      type: "document" as const,
      source: { type: "base64" as const, media_type: "application/pdf" as const, data: pdfBase64 },
    },
    { type: "text" as const, text: instruction },
  ];
}
