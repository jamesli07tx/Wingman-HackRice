// Wingman corpus · enrich.ts — DESIGN.md §5.4 + contract term D7.
//
// INTEGRATION: corpus enrich
// IN:  Supabase `companies` rows written by ingest-csv.ts (company_id, name,
//      aliases, careers_url) + the live careers page behind careers_url.
// OUT: summary_card (jsonb, Appendix C3 shape), summary_md, roles, source="enrich"
//      written back to the same row.
// CONSUMED BY: cortex ContextService/CorpusProvider — it reads summary_card and
//      renders it verbatim. Pre-generating these cards is a CONTRACT TERM, not an
//      optimization: it is what makes "banner stable -> first content < 5 s" (D7)
//      honest, because the hot path then costs a Postgres lookup, not an LLM call.
// WIRE: pnpm -F @wingman/corpus enrich   [--force] [--only <companyId>]
//
// House rules (DESIGN.md §2) applied here:
//   - model id EXACTLY "claude-opus-5" — never a date suffix
//   - adaptive thinking is the opus-5 default: the `thinking` param is OMITTED
//   - structured output via output_config.format (zodOutputFormat), effort "medium"
//   - refusal fallbacks: betas ["server-side-fallback-2026-07-01"] + fallbacks "default"
//   - stop_reason === "refusal" checked on every response (skip + log, never crash)
//   - byte-stable system prompt with a cache_control breakpoint; volatile page
//     text lives in the user turn, after it
//
// This package is standalone: it imports ONLY @wingman/shared, never cortex.

import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createClient } from "@supabase/supabase-js";
import { SUMMARY_CARD_RULES, SummaryCardSchema } from "@wingman/shared";
import { z } from "zod";

// --- env (same explicit-path pattern as cortex/src/index.ts) ----------------
const REPO_ROOT = new URL("../", import.meta.url);
dotenv.config({ path: fileURLToPath(new URL(".env", REPO_ROOT)) });
dotenv.config({ path: fileURLToPath(new URL("env.template", REPO_ROOT)) });

function requireEnv(name: string, why: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      [
        "",
        `[corpus/enrich] ${name} is not set — ${why}.`,
        "",
        "  Fix: put it in the repo-root .env (or env.template), see DESIGN.md Appendix A:",
        "    SUPABASE_URL=https://<project>.supabase.co",
        "    SUPABASE_SERVICE_ROLE_KEY=<service role key — server-side only>",
        "    ANTHROPIC_API_KEY=sk-ant-...",
        "",
        "  Then re-run:  pnpm -F @wingman/corpus enrich",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  return value;
}

// --- tuning ----------------------------------------------------------------
const MODEL = "claude-opus-5"; // EXACT id, no date suffix (DESIGN.md §2)
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PAGE_CHARS = 20_000;
const RATE_LIMIT_GAP_MS = 500; // sequential + friendly; this is a local batch job

// --- combined output schema ------------------------------------------------
// ONE opus-5 call produces both the prose summary and the C3 card. The card half
// reuses SummaryCardSchema from @wingman/shared verbatim — corpus must never
// fork the card contract, cortex renders exactly this shape.
const EnrichResultSchema = z.strictObject({
  summaryMd: z.string().min(1).max(600),
  roles: z.array(z.string().max(60)).max(8),
  card: SummaryCardSchema,
});
type EnrichResult = z.infer<typeof EnrichResultSchema>;

// The model sometimes overshoots character limits despite the prompt, and a
// strict rejection makes those rows fail deterministically on every re-run.
// So: LENIENT decode (structure only) + mechanical clamp + strict re-validation
// of the card, which is the only render contract. summaryMd/roles are
// dashboard prose — truncation is fine there.
const LenientResultSchema = z.object({
  summaryMd: z.string().min(1),
  roles: z.array(z.string()),
  card: z.object({
    title: z.string().min(1),
    subtitle: z.string().min(1),
    lines: z.array(z.string()).min(3),
  }),
});

function clampToContract(raw: z.infer<typeof LenientResultSchema>): EnrichResult {
  const clampLine = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
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

// Byte-stable — composed from module constants only; nothing interpolated per
// call (prompt caching). The card half is the ONE canonical rules block from
// @wingman/shared, also used by cortex ContextService's live path — the two
// paths cannot drift on card style (DESIGN.md Appendix C3: one schema, one prompt).
const ENRICH_SYSTEM = `You write the pre-generated employer card that Wingman shows in a 600x600 monocular heads-up display at a university career fair. The wearer is a student standing at this employer's booth, reading the lens while making eye contact with a recruiter. The card must be absorbed in under two seconds.

Produce all three fields in one response:

summaryMd — one plain-prose paragraph, 2 to 4 sentences, at most 600 characters. What the company does, the kind of technical work a student intern would actually do there, and why a student might stop at this booth. No markdown headings, no bullet points, no links, no first person.

roles — 0 to 8 concrete internship or new-grad role titles this employer recruits for, each at most 60 characters (for example "Software Engineer Intern", "New Grad Backend Engineer", "Hardware Design Intern"). Use the role titles the source text actually shows. Return an empty array rather than guessing.

card — the HUD summary card, built under the following rules.

${SUMMARY_CARD_RULES}`;

// --- careers-page fetch -----------------------------------------------------
function stripTags(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain fetch, 8 s ceiling. Any failure degrades to name+aliases only — a
 *  careers page that 403s a script must never block the corpus. */
async function fetchCareersText(url: string): Promise<string | null> {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "WingmanCorpusBot/0.1 (+HackRice 16 student project)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) {
      console.warn(`    careers page returned HTTP ${response.status} — falling back to name only`);
      return null;
    }
    const text = stripTags(await response.text()).slice(0, MAX_PAGE_CHARS);
    return text.length > 0 ? text : null;
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "timed out (8s)" : String(err);
    console.warn(`    careers page fetch failed: ${reason} — falling back to name only`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- the one LLM call -------------------------------------------------------
type CompanyRow = {
  company_id: string;
  name: string;
  aliases: string[] | null;
  careers_url: string | null;
  summary_card: unknown;
};

class RefusedError extends Error {
  constructor(public category: string | null) {
    super(`claude refused (category: ${category ?? "unknown"})`);
  }
}

async function generateCard(
  client: Anthropic,
  company: CompanyRow,
  pageText: string | null,
): Promise<EnrichResult> {
  const userTurn = [
    `Company: ${company.name}`,
    `Also known as: ${(company.aliases ?? []).join(", ") || "(no aliases on file)"}`,
    `Careers URL: ${company.careers_url || "(none on file)"}`,
    "",
    pageText
      ? `Careers page text (stripped of markup, may be partial or noisy):\n---\n${pageText}\n---`
      : "Careers page text: UNAVAILABLE — the page could not be fetched. Use well-known public facts about this company only.",
  ].join("\n");

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    // Refusal fallbacks on every opus-5 call (DESIGN.md §2).
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // `thinking` intentionally omitted: adaptive is the opus-5 default.
    system: [{ type: "text", text: ENRICH_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userTurn }],
    // Lenient schema on the wire: structure only. The char limits live in the
    // prompt as guidance and in clampToContract() as enforcement — a strict
    // format made length overshoots fail deterministically on every re-run.
    output_config: { format: zodOutputFormat(LenientResultSchema), effort: "medium" },
  });

  if (response.stop_reason === "refusal") {
    throw new RefusedError(response.stop_details?.category ?? null);
  }
  if (response.parsed_output == null) {
    throw new Error("structured output came back empty");
  }
  // Clamp to the render contract, then strict-validate (the DB column is a
  // contract, not a suggestion — but truncation beats rejection here).
  return clampToContract(LenientResultSchema.parse(response.parsed_output));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- main -------------------------------------------------------------------
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const onlyFlag = argv.indexOf("--only");
  const only = onlyFlag >= 0 ? argv[onlyFlag + 1] : undefined;
  if (onlyFlag >= 0 && (!only || only.startsWith("--"))) {
    console.error("[corpus/enrich] --only needs a companyId, e.g. --only stripe");
    process.exit(1);
  }

  const supabaseUrl = requireEnv("SUPABASE_URL", "cannot reach Supabase");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", "cannot write to Supabase");
  requireEnv("ANTHROPIC_API_KEY", "cannot call claude-opus-5");

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the env loaded above

  let query = supabase
    .from("companies")
    .select("company_id, name, aliases, careers_url, summary_card")
    .order("company_id");
  if (only) query = query.eq("company_id", only);

  const { data, error } = await query;
  if (error) {
    console.error(
      `[corpus/enrich] could not read the companies table: ${error.message}\n` +
        "  Has cortex/db/schema.sql been run, and has `pnpm -F @wingman/corpus ingest` been run?",
    );
    process.exit(1);
  }

  const all = (data ?? []) as CompanyRow[];
  if (only && all.length === 0) {
    console.error(`[corpus/enrich] no company with companyId "${only}" — run ingest first?`);
    process.exit(1);
  }

  // Resumable by construction: a row that already has a card is skipped, so a
  // crashed or rate-limited run is fixed by re-running the same command.
  const todo = force ? all : all.filter((row) => row.summary_card == null);
  const skipped = all.length - todo.length;

  console.log(
    `[corpus/enrich] ${all.length} compan${all.length === 1 ? "y" : "ies"} in scope · ` +
      `${todo.length} to enrich · ${skipped} already have a card${force ? " (ignored: --force)" : ""}`,
  );
  if (todo.length === 0) {
    console.log("[corpus/enrich] nothing to do.");
    return;
  }

  let done = 0;
  const failures: string[] = [];

  for (const [index, company] of todo.entries()) {
    const label = `${index + 1}/${todo.length} ${company.company_id}`;
    console.log(`[corpus/enrich] ${label} — ${company.name}`);
    try {
      const pageText = await fetchCareersText(company.careers_url ?? "");
      const result = await generateCard(anthropic, company, pageText);

      const { error: updateError } = await supabase
        .from("companies")
        .update({
          summary_card: result.card,
          summary_md: result.summaryMd,
          roles: result.roles,
          source: "enrich",
          updated_at: new Date().toISOString(),
        })
        .eq("company_id", company.company_id);

      if (updateError) throw new Error(`supabase update failed: ${updateError.message}`);

      done += 1;
      console.log(`    card: "${result.card.title}" · ${result.card.lines.length} lines`);
    } catch (err) {
      if (err instanceof RefusedError) {
        console.warn(`    SKIPPED — ${err.message}; this row keeps its previous state`);
      } else {
        console.warn(`    FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
      failures.push(company.company_id);
    }

    if (index < todo.length - 1) await sleep(RATE_LIMIT_GAP_MS);
  }

  console.log(`[corpus/enrich] enriched ${done}/${todo.length}`);
  if (failures.length > 0) {
    console.error(
      `[corpus/enrich] ${failures.length} not enriched: ${failures.join(", ")}\n` +
        "  Re-run the same command — enrich is resumable and skips rows that already have a card.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[corpus/enrich] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
