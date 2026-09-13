// Fair list import · fetchPage.ts — the "link" entry point.
// Fetches a public page and reduces it to text an LLM can read. Sponsor walls
// are usually logos whose only text is an aria-label / alt attribute (that is
// exactly how hackrice.com marks its sponsors up), so accessible names are
// surfaced before tags are stripped. Every failure is classified so the console
// can disable the link path and ask for an image instead (design grill Q3/Q5).
// Login-gated rosters (12twenty, Handshake) typically answer 200 with a sign-in
// shell; those surface as `no_companies` one step later, in FairImportService.

import type { LinkFailureReason } from "./types.js";

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: "follow" | "error" | "manual";
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

/** Global fetch satisfies this; tests inject a fake. */
export type FetchLike = (input: string, init?: FetchInit) => Promise<FetchResponseLike>;

export type PageFetch =
  | { ok: true; url: string; title: string | null; text: string }
  | { ok: false; reason: LinkFailureReason; message: string };

export const PAGE_FETCH_TIMEOUT_MS = 8_000;
/** ~10k tokens: a sponsor wall plus its surroundings. */
export const PAGE_TEXT_MAX_CHARS = 40_000;
const MIN_USEFUL_CHARS = 40;
const USER_AGENT = "WingmanFairImport/0.1 (+HackRice 16 student project)";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
};

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_: string, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_: string, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m: string, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = decodeEntities(m[1]!.replace(/\s+/g, " ")).trim();
  return t.length > 0 ? t.slice(0, 120) : null;
}

/** HTML -> plain text, accessible names and logo filenames preserved as text. */
export function stripToText(html: string): string {
  let s = html
    .replace(/<(script|style|noscript|svg|head|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Accessible names first: surface the attribute value as text beside its tag
  // (the tag is stripped below). Covers aria-label="MathWorks — visit website",
  // alt="Capital One logo", title="…".
  s = s.replace(
    /<[a-z][^>]*?\s(?:aria-label|alt|title)\s*=\s*"([^"]{1,120})"[^>]*>/gi,
    (tag: string, value: string) => ` ${value} ${tag}`,
  );
  // Logo filenames are the next best hint: "/sponsors/mathworks.svg".
  s = s.replace(
    /<img\b[^>]*?\ssrc\s*=\s*"[^"]*?\/([^"/?#]+)\.(?:png|jpe?g|svg|webp|gif)"[^>]*>/gi,
    (_: string, base: string) => ` [logo: ${base.replace(/[-_]+/g, " ")}] `,
  );
  s = s.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/ul|\/ol)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s
    .replace(/[ \t \r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const FOCUS_WORDS = "sponsor|exhibitor|employer|partner|compan|recruit";

/** Long pages: keep windows around the words a roster section is named by. */
export function focusText(text: string, max = PAGE_TEXT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const re = new RegExp(FOCUS_WORDS, "gi");
  const hits: number[] = [];
  for (let m = re.exec(text); m && hits.length < 40; m = re.exec(text)) hits.push(m.index);
  if (hits.length === 0) return text.slice(0, max);
  const half = Math.floor(max / 6);
  const windows: [number, number][] = [];
  for (const h of hits) {
    const a = Math.max(0, h - half);
    const b = Math.min(text.length, h + half);
    const last = windows[windows.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else windows.push([a, b]);
  }
  let out = "";
  for (const [a, b] of windows) {
    if (out.length + (b - a) > max) break;
    out += (out.length > 0 ? "\n…\n" : "") + text.slice(a, b);
  }
  return out.length > 0 ? out : text.slice(0, max);
}

export async function fetchPage(
  url: string,
  deps: { fetchImpl: FetchLike; timeoutMs?: number },
): Promise<PageFetch> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    return { ok: false, reason: "invalid_url", message: "That is not a valid http(s) link" };
  }

  const timeoutMs = deps.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetchImpl(parsed.toString(), {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      const gated = res.status === 401 || res.status === 403;
      return {
        ok: false,
        reason: "http_error",
        message: `The page answered HTTP ${res.status}${gated ? " (it needs a login)" : ""}`,
      };
    }
    const html = await res.text();
    const text = focusText(stripToText(html));
    if (text.length < MIN_USEFUL_CHARS) {
      return {
        ok: false,
        reason: "empty_page",
        message: "The page had no readable text (it may need a login or JavaScript)",
      };
    }
    return { ok: true, url: parsed.toString(), title: pageTitle(html), text };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return aborted
      ? {
          ok: false,
          reason: "timeout",
          message: `The page took more than ${Math.round(timeoutMs / 1000)} s to load`,
        }
      : { ok: false, reason: "fetch_failed", message: `Could not reach that link (${errText(err)})` };
  } finally {
    clearTimeout(timer);
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
