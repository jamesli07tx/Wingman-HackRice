// ORCHESTRATOR-OWNED (cross-cutting). The single Anthropic client + house
// rules from DESIGN.md §2. Every cortex module calls Claude ONLY through these
// helpers — no module constructs its own client or request shapes.
//
// House rules encoded here:
// - exact model IDs, no date suffixes
// - haiku-4-5: NO thinking param; opus-5: adaptive thinking is the default (omit param)
// - structured outputs via output_config.format (zodOutputFormat)
// - refusal fallbacks on every opus-5 call: betas server-side-fallback-2026-07-01 + fallbacks "default"
// - stop_reason === "refusal" checked on every response
// - prompt caching: byte-stable system prompts with cache_control; images LAST in the user turn

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export const OPUS = "claude-opus-5";
export const HAIKU = "claude-haiku-4-5";

// Resolves ANTHROPIC_API_KEY from the environment (root .env is loaded in index.ts).
export const client = new Anthropic();

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
 * C1 gate call — haiku vision classify. Runs ~34×/min, so the byte-stable
 * system prompt is cache_control'd and the frame image comes last.
 * NO thinking param (haiku does not take adaptive).
 */
export async function haikuClassify<S extends z.ZodType>(opts: {
  system: string;
  jpegBase64: string;
  userText: string;
  schema: S;
  maxTokens?: number;
}): Promise<z.infer<S>> {
  const response = await withRetry(() =>
    client.messages.parse({
      model: HAIKU,
      max_tokens: opts.maxTokens ?? 128,
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [imageBlock(opts.jpegBase64), { type: "text", text: opts.userText }] },
      ],
      output_config: { format: zodOutputFormat(opts.schema) },
    }),
  );
  if (response.stop_reason === "refusal") {
    throw new RefusalError(response.stop_details?.category ?? null);
  }
  if (response.parsed_output == null) {
    throw new Error("gate: structured output failed to parse");
  }
  return response.parsed_output as z.infer<S>;
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
    client.beta.messages.create({
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
