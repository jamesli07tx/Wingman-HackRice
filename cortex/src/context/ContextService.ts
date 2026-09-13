// INTEGRATION: ContextService (implements ContextProvider)
// IN:  SessionOrchestrator -> resolve({ corpusId, nameGuess }) right after
//      IdentifyService; override + REST /api/companies -> byId(id) / search(q).
// OUT: CompanyContext { companyId, displayName, card, record } — `card` is the
//      C3 SummaryCardContent the orchestrator renders as page 1/2, `record`
//      feeds PitchService. null = nothing usable (orchestrator stays silent).
// WIRE: new ContextService(supabase, fetch, makeOpusSummarizer()) in
//       cortex/src/index.ts. Supabase client is the service-role one
//       (SUPABASE_SERVICE_ROLE_KEY); fetch is global fetch in prod, a fake in
//       tests; the summarizer is opus-5 + SUMMARY_CARD_SYSTEM_PROMPT.
//
// PATHS (DESIGN.md §5.3 / D7):
//   corpusId hit         -> companies.summary_card, PRE-GENERATED, instant.
//   corpusId null + name -> exact name/alias row if we have one (still instant)
//                        -> else Tavily REST + opus-5 condense (T_SEARCH_MS),
//                           behind a process-memory memo (RESEARCH_MEMO_TTL_MS),
//                           a per-name dedupe and a RESEARCH_MAX_INFLIGHT gate.
//                           NOTHING is written back to the corpus (the corpus is
//                           hand-curated; `cacheLiveResults` stays off).

import {
  RESEARCH_MAX_INFLIGHT,
  RESEARCH_MEMO_MAX,
  RESEARCH_MEMO_NEG_TTL_MS,
  RESEARCH_MEMO_TTL_MS,
  RESEARCH_RETRY_MS,
  SUMMARY_CARD_RULES,
  SummaryCardSchema,
  T_RESEARCH_MS,
  T_SEARCH_MS,
} from "@wingman/shared";
import type { CompanyRecord, SummaryCardContent } from "@wingman/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompanyContext, ContextProvider } from "../interfaces.js";
import { opusParse } from "../llm/anthropic.js";

/**
 * C3 system prompt — composed from the ONE canonical card-rules block in
 * @wingman/shared (DESIGN.md Appendix C3: one schema, one prompt). The
 * corpus pre-generation prompt (corpus/enrich.ts) composes the SAME
 * SUMMARY_CARD_RULES, so the two paths cannot drift on card style.
 * BYTE-STABLE MODULE CONSTANT — both halves are constants; nothing is
 * interpolated per call (prompt caching).
 */
export const SUMMARY_CARD_SYSTEM_PROMPT = `You write a single heads-up display card about an employer for a student walking a university career fair. It is rendered on a 600x600 monocular lens and read in about three seconds, so every character is expensive.

${SUMMARY_CARD_RULES}`;

/** Condenses raw evidence about a company into a C3 card. */
export type SummaryCardSummarizer = (input: {
  name: string;
  evidence: string;
}) => Promise<SummaryCardContent>;

/** Default summarizer: opus-5 + the C3 prompt above. */
export function makeOpusSummarizer(): SummaryCardSummarizer {
  return async ({ name, evidence }) =>
    opusParse({
      system: SUMMARY_CARD_SYSTEM_PROMPT,
      content: `Employer: ${name}\n\nSource material:\n${evidence}`,
      schema: SummaryCardSchema,
      maxTokens: 1024,
    });
}

/** Minimal fetch shape so tests can inject a fake without DOM lib types. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  /** optional so tiny fakes stay valid; used only to log a failure body */
  text?: () => Promise<string>;
}>;

export interface ContextServiceOptions {
  /** defaults to process.env.TAVILY_API_KEY */
  tavilyApiKey?: string;
  /** write live-searched companies back into the corpus (default false — research every time) */
  cacheLiveResults?: boolean;
  /** Appendix D T_SEARCH_MS — the Tavily leg (both attempts + backoff) */
  searchTimeoutMs?: number;
  /** Appendix D T_RESEARCH_MS — the whole live path, incl. queue wait */
  researchTimeoutMs?: number;
  tavilyUrl?: string;
}

const TAVILY_URL = "https://api.tavily.com/search";
/** per-result snippet cap, and the ~4 kB ceiling on what opus condenses */
const RESULT_MAX_CHARS = 600;
const EVIDENCE_MAX_CHARS = 4000;

/** Tavily answered, but not with a result: a key/quota/server problem, never a
 *  "no such company". Thrown so the orchestrator degrades with `search_down`
 *  (a swallowed null here is what made a dead API key look like "No match"). */
class TavilyHttpError extends Error {
  constructor(readonly status: number) {
    super(`tavily HTTP ${status}`);
  }
}

interface CompanyRow {
  company_id: string;
  name: string;
  aliases: string[] | null;
  tier: "sponsor" | "marquee";
  summary_md: string | null;
  roles: string[] | null;
  deadlines: string[] | null;
  careers_url: string | null;
  facts_json: Record<string, unknown> | null;
  summary_card: SummaryCardContent | null;
  source: string | null;
  updated_at: string | null;
}

/** cortex/db/schema.sql (snake_case) -> @wingman/shared CompanyRecord. */
export function rowToRecord(row: CompanyRow): CompanyRecord {
  return {
    companyId: row.company_id,
    name: row.name,
    aliases: row.aliases ?? [],
    tier: row.tier,
    summaryMd: row.summary_md ?? "",
    roles: row.roles ?? [],
    deadlines: row.deadlines ?? [],
    careersUrl: row.careers_url ?? "",
    factsJson: row.facts_json ?? {},
    summaryCard: row.summary_card ?? null,
    source: row.source ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

/** Deterministic id for a company we learned about from live search. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "unknown";
}

/** One remembered research outcome. `err` = the call failed (search_down). */
interface MemoEntry {
  ctx: CompanyContext | null;
  err?: unknown;
  until: number;
}

export class ContextService implements ContextProvider {
  private readonly searchTimeoutMs: number;
  private readonly researchTimeoutMs: number;
  private readonly tavilyUrl: string;
  private readonly cacheLiveResults: boolean;

  // Live-research scaling, all in process memory — nothing here touches Supabase.
  // ponytail: per-instance, not a module singleton; cortex builds one
  // ContextService. Move to a shared store only if cortex ever runs multi-process.
  /** normalized name -> last outcome. Insertion order doubles as the LRU order. */
  private readonly memo = new Map<string, MemoEntry>();
  /** normalized name -> the research already running for it (dedupe). */
  private readonly inflight = new Map<string, Promise<CompanyContext | null>>();
  /** FIFO of callers waiting for a Tavily slot. */
  private readonly waiting: (() => void)[] = [];
  private tavilyActive = 0;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly fetchImpl: FetchLike,
    private readonly summarize: SummaryCardSummarizer,
    private readonly opts: ContextServiceOptions = {},
  ) {
    this.searchTimeoutMs = opts.searchTimeoutMs ?? T_SEARCH_MS;
    this.researchTimeoutMs = opts.researchTimeoutMs ?? T_RESEARCH_MS;
    this.tavilyUrl = opts.tavilyUrl ?? TAVILY_URL;
    this.cacheLiveResults = opts.cacheLiveResults ?? false;
  }

  async resolve(input: {
    corpusId: string | null;
    nameGuess: string | null;
  }): Promise<CompanyContext | null> {
    // 1. Corpus hit -> pre-generated card. The < 5 s contract lives here (D7).
    if (input.corpusId) {
      const hit = await this.byId(input.corpusId);
      if (hit) return hit;
    }

    const name = input.nameGuess?.trim();
    if (!name) return null;

    // 2. Identify missed the id but read a name we already hold. Still instant.
    const known = await this.byExactName(name);
    if (known) return known;

    // 3. Live search fallback (D6): Tavily -> opus-5 condense -> cache back.
    return this.liveSearch(name);
  }

  async byId(companyId: string): Promise<CompanyContext | null> {
    const { data, error } = await this.supabase
      .from("companies")
      .select("*")
      .eq("company_id", companyId)
      .maybeSingle();
    if (error || !data) return null;
    return this.toContext(rowToRecord(data as CompanyRow));
  }

  async search(query: string): Promise<{ companyId: string; name: string }[]> {
    const q = sanitize(query);
    if (!q) return [];
    const { data, error } = await this.supabase
      .from("companies")
      .select("company_id,name")
      .or(`name.ilike.%${q}%,aliases.cs.{${q}}`)
      .limit(20);
    if (error || !data) return [];
    return (data as { company_id: string; name: string }[]).map((r) => ({
      companyId: r.company_id,
      name: r.name,
    }));
  }

  // -------------------------------------------------------------------------

  /** Case-insensitive exact match on name, or an exact alias-array hit. */
  private async byExactName(name: string): Promise<CompanyContext | null> {
    const q = sanitize(name);
    if (!q) return null;
    const { data, error } = await this.supabase
      .from("companies")
      .select("*")
      .or(`name.ilike.${q},aliases.cs.{${q}}`)
      .limit(1);
    if (error || !data) return null;
    const rows = data as CompanyRow[];
    if (rows.length === 0) return null;
    return this.toContext(rowToRecord(rows[0]));
  }

  /** Live research (D6): memo -> per-name dedupe -> Tavily slot -> condense.
   *  Returns null when Tavily genuinely found nothing; THROWS when the search
   *  backend itself is unusable, so the orchestrator can say `search_down`. */
  private async liveSearch(name: string): Promise<CompanyContext | null> {
    const key = name.trim().toLowerCase();

    const memo = this.memo.get(key);
    if (memo && memo.until > Date.now()) {
      this.memo.delete(key);
      this.memo.set(key, memo); // touch — insertion order is the LRU order
      // eslint-disable-next-line no-console
      console.info(`[context] research memo hit: ${name}`);
      if (memo.err) throw memo.err;
      return memo.ctx && { ...memo.ctx, note: `research memo hit: ${name}` };
    }
    if (memo) this.memo.delete(key); // expired

    // Two lenses on the same banner (or a re-detect mid-flight) = ONE Tavily call.
    const running = this.inflight.get(key);
    if (running) return running;

    const flight = this.research(name, key);
    this.inflight.set(key, flight);
    try {
      return await flight;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async research(name: string, key: string): Promise<CompanyContext | null> {
    const started = Date.now();
    const until = started + this.researchTimeoutMs;

    let evidence: string | null;
    try {
      evidence = await this.withTavilySlot(async () => {
        // Queued past our own budget: the orchestrator has already degraded, so
        // do not spend a Tavily call (and a rate-limit slot) nobody is waiting for.
        if (Date.now() >= until) return null;
        return this.tavily(name, Math.min(until, Date.now() + this.searchTimeoutMs));
      });
    } catch (err) {
      // search_down is remembered briefly: a dead key or a rate limit is a
      // property of the minute, not of the company.
      this.remember(key, { ctx: null, err, until: Date.now() + RESEARCH_MEMO_NEG_TTL_MS });
      throw err;
    }
    if (!evidence) {
      this.remember(key, { ctx: null, until: Date.now() + RESEARCH_MEMO_NEG_TTL_MS });
      return null;
    }

    let card: SummaryCardContent | null = null;
    try {
      card = SummaryCardSchema.parse(await this.summarize({ name, evidence }));
    } catch {
      card = null; // condense failed — the evidence below still beats "No match"
    }

    const companyId = slugify(name);
    const record: CompanyRecord = {
      companyId,
      name,
      aliases: [],
      tier: "marquee",
      summaryMd: evidence,
      roles: [],
      deadlines: [],
      careersUrl: "",
      factsJson: {},
      summaryCard: card,
      source: "tavily",
      updatedAt: new Date().toISOString(),
    };
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    if (!card) {
      // Tavily found material but opus could not condense it: render the raw
      // evidence degraded rather than dropping to no_match, and remember it only
      // briefly so the next look at this booth gets another shot at a real card.
      const degraded = fallbackCard(record);
      if (!degraded) {
        this.remember(key, { ctx: null, until: Date.now() + RESEARCH_MEMO_NEG_TTL_MS });
        return null;
      }
      const ctx: CompanyContext = {
        companyId,
        displayName: name,
        card: { ...degraded, subtitle: "Pulling details…" },
        record,
        note: `research degraded: ${name} ${secs} s (condense failed)`,
      };
      this.remember(key, { ctx, until: Date.now() + RESEARCH_MEMO_NEG_TTL_MS });
      return ctx;
    }

    // Write-back to the corpus is OFF by default (human's call, 2026-09-13): the corpus is a curated
    // lookup cache; live-searched companies are researched again each time rather than cached.
    // A write failure must never cost us the card we already have.
    if (this.cacheLiveResults) try {
      await this.supabase.from("companies").upsert(
        {
          company_id: record.companyId,
          name: record.name,
          aliases: record.aliases,
          tier: record.tier,
          summary_md: record.summaryMd,
          roles: record.roles,
          deadlines: record.deadlines,
          careers_url: record.careersUrl,
          facts_json: record.factsJson,
          summary_card: record.summaryCard,
          source: record.source,
          updated_at: record.updatedAt,
        },
        { onConflict: "company_id" },
      );
    } catch {
      /* ignore — the card is already in hand */
    }

    const ctx: CompanyContext = {
      companyId,
      displayName: name,
      card,
      record,
      note: `research ok: ${name} ${secs} s`,
    };
    this.remember(key, { ctx, until: Date.now() + RESEARCH_MEMO_TTL_MS });
    // eslint-disable-next-line no-console
    console.info(`[context] research ok: ${name} ${secs} s`);
    return ctx;
  }

  /** Process-memory memo, LRU-ish: oldest insertion evicted past the cap. */
  private remember(key: string, entry: MemoEntry): void {
    this.memo.delete(key);
    this.memo.set(key, entry);
    for (const oldest of this.memo.keys()) {
      if (this.memo.size <= RESEARCH_MEMO_MAX) break;
      this.memo.delete(oldest);
    }
  }

  /** At most RESEARCH_MAX_INFLIGHT Tavily calls per process; the rest queue FIFO.
   *  The slot covers the Tavily leg only (bounded by T_SEARCH_MS) — the opus
   *  condense is unbounded and must not hold a searcher's place in the queue. */
  private async withTavilySlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tavilyActive < RESEARCH_MAX_INFLIGHT) this.tavilyActive++;
    else await new Promise<void>((resume) => this.waiting.push(resume)); // slot handed over, not re-counted
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.tavilyActive--;
    }
  }

  /** Tavily REST inside ONE deadline shared by both attempts. At most one retry,
   *  and only for what a retry can fix: 429, 5xx, and transport drops. Any other
   *  4xx (401 dead key, 403 quota) is final — retrying just burns the budget the
   *  orchestrator is holding a "Researching…" card against. */
  private async tavily(name: string, until: number): Promise<string | null> {
    const apiKey = this.opts.tavilyApiKey ?? process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error("tavily key missing");

    for (let attempt = 0; ; attempt++) {
      const left = until - Date.now();
      if (left <= 0) return null;
      try {
        return await this.tavilyOnce(name, apiKey, left);
      } catch (err) {
        const retryable =
          err instanceof TavilyHttpError ? err.status === 429 || err.status >= 500 : true;
        if (attempt > 0 || !retryable) throw err;
        // Jitter so a room full of lenses does not re-hit the rate limit in lockstep.
        const backoff = RESEARCH_RETRY_MS + Math.floor(Math.random() * 400);
        if (until - Date.now() <= backoff) throw err; // no room to retry inside the budget
        await new Promise((resume) => setTimeout(resume, backoff));
      }
    }
  }

  private async tavilyOnce(name: string, apiKey: string, budgetMs: number): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const res = await this.fetchImpl(this.tavilyUrl, {
        method: "POST",
        // Current Tavily docs authenticate with a bearer token; the legacy
        // `api_key` body field is sent too so either form works.
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          api_key: apiKey,
          // Hiring intent, not a general profile: the card is 3-5 lines a student
          // reads at a booth, so ask for the material those lines are made of.
          query: `${name} company careers hiring`,
          search_depth: "basic",
          topic: "general",
          max_results: 5,
          include_answer: true,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = res.text ? (await res.text().catch(() => "")).slice(0, 120) : "";
        // The key is never logged — only the status and the first 120 chars.
        // eslint-disable-next-line no-console
        console.warn(`[context] tavily HTTP ${res.status} for "${name}": ${body}`);
        throw new TavilyHttpError(res.status);
      }
      const body = (await res.json()) as {
        answer?: string | null;
        results?: { title?: string; url?: string; content?: string }[];
      };
      // Tavily's own `answer` leads: it is already condensed, and on a thin
      // employer it is often the only usable sentence in the response.
      const parts: string[] = [];
      const answer = body.answer?.trim();
      if (answer) parts.push(answer);
      for (const r of body.results ?? []) {
        const head = `${r.title ?? ""} ${r.url ? `(${r.url})` : ""}`.trim();
        const content = (r.content ?? "").slice(0, RESULT_MAX_CHARS).trim();
        if (!head && !content) continue;
        parts.push(`${head}\n${content}`.trim());
      }
      const evidence = parts.join("\n\n").trim().slice(0, EVIDENCE_MAX_CHARS);
      return evidence.length > 0 ? evidence : null;
    } finally {
      clearTimeout(timer);
    }
  }

  private toContext(record: CompanyRecord): CompanyContext | null {
    // Pre-generated card (D7) when enrich.ts has run; otherwise a zero-LLM
    // card built from the row itself, so the override path still renders
    // something during an LLM outage (DESIGN.md §8 outage drill).
    const card = record.summaryCard ?? fallbackCard(record);
    if (!card) return null;
    return { companyId: record.companyId, displayName: record.name, card, record };
  }
}

/** Zero-LLM degraded card from a corpus row. Null if the row says nothing. */
export function fallbackCard(record: CompanyRecord): SummaryCardContent | null {
  const lines: string[] = [];
  if (record.roles.length > 0) lines.push(`Hiring: ${record.roles.slice(0, 2).join(", ")}`);
  for (const d of record.deadlines.slice(0, 2)) lines.push(`Deadline: ${d}`);
  for (const s of record.summaryMd.split(/\n+/)) {
    const t = s.replace(/^[-*#>\s]+/, "").trim();
    if (t) lines.push(t);
    if (lines.length >= 3) break;
  }
  if (record.careersUrl) lines.push("Careers page on file");
  if (lines.length === 0) return null;
  while (lines.length < 3) lines.push("Details pulling…");
  return {
    title: clamp(record.name, 28),
    subtitle: clamp(record.tier === "sponsor" ? "HackRice sponsor" : "Employer", 48),
    lines: lines.slice(0, 5).map((l) => clamp(l, 40)),
  };
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** PostgREST `or()` filters are comma/paren delimited — keep those out. */
function sanitize(s: string): string {
  return s.replace(/[,()%{}"'\\*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
