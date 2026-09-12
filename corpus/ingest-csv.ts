// Wingman corpus · ingest-csv.ts — DESIGN.md §5.4, D6 ("swap-a-fair = swap the CSV").
//
// INTEGRATION: corpus ingest
// IN:  corpus/companies.csv (P3 hand-maintains it; columns companyId,name,
//      aliases,tier,careersUrl — aliases are |-separated)
// OUT: rows in the Supabase `companies` table (cortex/db/schema.sql, snake_case).
//      Existing summary_md / roles / deadlines / summary_card are PRESERVED so a
//      re-ingest after a CSV edit never throws away the pre-generated cards that
//      make the <5 s budget honest (D7). `--force` clears them so enrich.ts
//      regenerates from scratch.
// CONSUMED BY: corpus/enrich.ts (fills summary_card) and, at runtime,
//      cortex ContextService/CorpusProvider + IdentifyService (name/alias list).
// WIRE: pnpm -F @wingman/corpus ingest   [--force]
//
// This package is standalone: it talks to Supabase and Anthropic directly and
// imports ONLY @wingman/shared. It never imports from cortex.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// --- env -------------------------------------------------------------------
// Root .env when present (the normal path); fall back to the local key drop
// env.template. Same pattern as cortex/src/index.ts — explicit paths, because
// these scripts are run from the repo root via `pnpm -F`, not from corpus/.
const REPO_ROOT = new URL("../", import.meta.url);
dotenv.config({ path: fileURLToPath(new URL(".env", REPO_ROOT)) });
dotenv.config({ path: fileURLToPath(new URL("env.template", REPO_ROOT)) });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      [
        "",
        `[corpus/ingest] ${name} is not set — cannot reach Supabase.`,
        "",
        "  Fix: put it in the repo-root .env (or env.template), see DESIGN.md Appendix A:",
        "    SUPABASE_URL=https://<project>.supabase.co",
        "    SUPABASE_SERVICE_ROLE_KEY=<service role key — server-side only>",
        "",
        "  Then re-run:  pnpm -F @wingman/corpus ingest",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  return value;
}

// --- CSV -------------------------------------------------------------------
// Hand-rolled parser, deliberately: no quoted fields, no embedded commas (the
// CSV header says so). Keeping it dependency-free means P3 can edit the file in
// any spreadsheet and the failure mode is a loud column-count error, not a
// silently mangled row.

const COLUMNS = ["companyId", "name", "aliases", "tier", "careersUrl"] as const;

const RowSchema = z.strictObject({
  companyId: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "companyId must be lowercase letters, digits and dashes"),
  name: z.string().min(1),
  aliases: z.string(),
  tier: z.enum(["sponsor", "marquee"]),
  careersUrl: z.union([z.url(), z.literal("")]),
});
type CsvRow = z.infer<typeof RowSchema>;

function parseCsv(text: string): CsvRow[] {
  const numbered = text
    .split(/\r?\n/)
    .map((line, i) => ({ line: line.trim(), lineNo: i + 1 }))
    .filter(({ line }) => line.length > 0 && !line.startsWith("#"));

  if (numbered.length < 2) {
    throw new Error("companies.csv has a header but no data rows");
  }

  const header = numbered[0]!.line.split(",").map((h) => h.trim());
  if (header.join(",") !== COLUMNS.join(",")) {
    throw new Error(
      `companies.csv header must be exactly "${COLUMNS.join(",")}" — got "${header.join(",")}"`,
    );
  }

  const rows: CsvRow[] = [];
  const seen = new Map<string, number>();

  for (const { line, lineNo } of numbered.slice(1)) {
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length !== COLUMNS.length) {
      throw new Error(
        `companies.csv line ${lineNo}: expected ${COLUMNS.length} columns, got ${cells.length} ` +
          `(a cell probably contains a comma — commas are not allowed, use | inside aliases)`,
      );
    }
    const raw = Object.fromEntries(COLUMNS.map((col, i) => [col, cells[i]!]));
    const parsed = RowSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
        .join("; ");
      throw new Error(`companies.csv line ${lineNo}: ${issues}`);
    }
    const prev = seen.get(parsed.data.companyId);
    if (prev !== undefined) {
      throw new Error(
        `companies.csv line ${lineNo}: duplicate companyId "${parsed.data.companyId}" (first seen on line ${prev})`,
      );
    }
    seen.set(parsed.data.companyId, lineNo);
    rows.push(parsed.data);
  }
  return rows;
}

function splitAliases(raw: string): string[] {
  return [...new Set(raw.split("|").map((a) => a.trim()).filter((a) => a.length > 0))];
}

// --- main ------------------------------------------------------------------

type ExistingRow = {
  company_id: string;
  summary_md: string | null;
  roles: string[] | null;
  deadlines: string[] | null;
  summary_card: unknown;
  source: string | null;
};

async function main(): Promise<void> {
  const force = process.argv.slice(2).includes("--force");

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const csvPath = fileURLToPath(new URL("companies.csv", import.meta.url));
  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  console.log(`[corpus/ingest] parsed ${rows.length} companies from companies.csv`);

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existingRows, error: selectError } = await supabase
    .from("companies")
    .select("company_id, summary_md, roles, deadlines, summary_card, source");

  if (selectError) {
    console.error(
      `[corpus/ingest] could not read the companies table: ${selectError.message}\n` +
        "  Has cortex/db/schema.sql been run in the Supabase SQL editor yet?",
    );
    process.exit(1);
  }

  const existing = new Map<string, ExistingRow>(
    ((existingRows ?? []) as ExistingRow[]).map((r) => [r.company_id, r]),
  );

  const now = new Date().toISOString();
  const payload = rows.map((row) => {
    const prev = force ? undefined : existing.get(row.companyId);
    return {
      company_id: row.companyId,
      name: row.name,
      aliases: splitAliases(row.aliases),
      tier: row.tier,
      careers_url: row.careersUrl,
      // Enrichment-owned columns: carried forward untouched unless --force.
      summary_md: prev?.summary_md ?? "",
      roles: prev?.roles ?? [],
      deadlines: prev?.deadlines ?? [],
      summary_card: prev?.summary_card ?? null,
      source: prev?.source || "csv",
      updated_at: now,
    };
  });

  const { error: upsertError } = await supabase
    .from("companies")
    .upsert(payload, { onConflict: "company_id" });

  if (upsertError) {
    console.error(`[corpus/ingest] upsert failed: ${upsertError.message}`);
    process.exit(1);
  }

  const inserted = rows.filter((r) => !existing.has(r.companyId)).length;
  const updated = rows.length - inserted;
  const keptCards = force
    ? 0
    : rows.filter((r) => existing.get(r.companyId)?.summary_card != null).length;

  console.log(
    `[corpus/ingest] upserted ${rows.length} rows (${inserted} new, ${updated} updated)` +
      (force
        ? " — --force cleared summary_card/summary_md/roles/deadlines; re-run enrich"
        : `; preserved ${keptCards} pre-generated summary_card${keptCards === 1 ? "" : "s"}`),
  );
  const missing = rows.length - keptCards;
  if (missing > 0) {
    console.log(
      `[corpus/ingest] ${missing} compan${missing === 1 ? "y" : "ies"} still need a card — ` +
        "run: pnpm -F @wingman/corpus enrich",
    );
  }
}

main().catch((err) => {
  console.error(`[corpus/ingest] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
