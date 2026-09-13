// INTEGRATION: FairImportService (fair list import — cortex/src/fairs/)
// IN:  routes.ts -> startFromLink(url, fairName?) / startFromImage(image, fairName?)
//      / get / list / settled / companiesOnFile / reload.
// OUT: rows in Supabase `companies` (new ones pre-carded, existing ones tagged
//      in facts_json.fairs) and, when an import finishes, ONE reloadCorpus()
//      call so the live identify candidate list includes the new names.
//      Everything downstream is unchanged: identify -> ContextService.byId hits
//      the pre-generated card (instant, D7); anything NOT on the list still
//      takes the untouched live-search path (design grill Q1).
// WIRE: createFairImportService({ supabase, tavilyApiKey, reloadCorpus, logger })
//       in cortex/src/index.ts (see fairs/index.ts).
//
// Zero-DDL by decision (grill Q7b): no fairs table. tier stays "marquee" (its
// fallback label is the neutral "Employer"); the fair is recorded as
// facts_json.fairs[] so one company row serves every fair it appears at, and
// the table simply grows over time (more instant hits, fewer live searches).

import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "../context/ContextService.js";
import type { Extractor, ImageMediaType, ListExtraction } from "./extract.js";
import { key } from "./extract.js";
import type { CardWriter, EvidenceSearch } from "./enrich.js";
import { errText, fetchPage, type FetchLike } from "./fetchPage.js";
import type {
  FairCompanyOnFile,
  FairImport,
  FairTag,
  ImportCompany,
  ImportSource,
  LinkFailure,
} from "./types.js";

export interface FairImportLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface FairImportDeps {
  supabase: SupabaseClient;
  fetchImpl: FetchLike;
  extract: Extractor;
  evidence: EvidenceSearch;
  writeCard: CardWriter;
  /** Rebuild the live identify candidate list; resolves to its size. */
  reloadCorpus: () => Promise<number>;
  concurrency?: number;
  /** Finished imports remembered in memory (the DB is the durable record). */
  keep?: number;
  logger?: FairImportLogger;
  now?: () => number;
}

export type StartFailure =
  | LinkFailure
  | { error: "image_failed" | "extract_failed"; message: string };

export type StartResult =
  | { ok: true; import: FairImport }
  | { ok: false; status: number; body: StartFailure };

interface ExistingRow {
  company_id: string;
  name: string;
  aliases: string[] | null;
  facts_json: Record<string, unknown> | null;
  summary_card: unknown;
}

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_KEEP = 20;
const FAIR_NAME_MAX = 80;
export const IMPORT_SOURCE_TAG = "fair-import";

export class FairImportService {
  readonly #imports: FairImport[] = []; // newest first
  readonly #runs = new Map<string, Promise<void>>();
  #counter = 0;

  constructor(private readonly deps: FairImportDeps) {}

  list(): FairImport[] {
    return this.#imports.map(snapshot);
  }

  get(importId: string): FairImport | null {
    const imp = this.#imports.find((i) => i.importId === importId);
    return imp ? snapshot(imp) : null;
  }

  /** Resolves once the import's background work is over (tests + the live tool). */
  async settled(importId: string): Promise<FairImport | null> {
    await this.#runs.get(importId);
    return this.get(importId);
  }

  /** Link entry point. Extraction runs inline so a dead link is reported to the
   *  caller (and the console disables the link field); enrichment runs after. */
  async startFromLink(url: string, fairName: string | null): Promise<StartResult> {
    const page = await fetchPage(url, { fetchImpl: this.deps.fetchImpl });
    if (!page.ok) {
      return { ok: false, status: 422, body: { error: "link_failed", reason: page.reason, message: page.message } };
    }
    let extraction: ListExtraction;
    try {
      extraction = await this.deps.extract({
        kind: "text",
        text: page.text,
        sourceUrl: page.url,
        title: page.title,
      });
    } catch (err) {
      return {
        ok: false,
        status: 502,
        body: { error: "extract_failed", message: `Could not read that page: ${errText(err)}` },
      };
    }
    if (extraction.companies.length === 0) {
      return {
        ok: false,
        status: 422,
        body: {
          error: "link_failed",
          reason: "no_companies",
          message: "No exhibitor or sponsor list was found on that page (it may need a login)",
        },
      };
    }
    const name = fairName ?? extraction.fairName ?? page.title ?? "Untitled fair";
    return { ok: true, import: this.#begin("link", page.url, name, extraction) };
  }

  async startFromImage(
    image: { buffer: Buffer; mediaType: ImageMediaType; filename: string },
    fairName: string | null,
  ): Promise<StartResult> {
    let extraction: ListExtraction;
    try {
      extraction = await this.deps.extract({
        kind: "image",
        base64: image.buffer.toString("base64"),
        mediaType: image.mediaType,
      });
    } catch (err) {
      return {
        ok: false,
        status: 502,
        body: { error: "extract_failed", message: `Could not read that image: ${errText(err)}` },
      };
    }
    if (extraction.companies.length === 0) {
      return {
        ok: false,
        status: 422,
        body: { error: "image_failed", message: "No exhibitor or sponsor list was found in that image" },
      };
    }
    const name = fairName ?? extraction.fairName ?? "Untitled fair";
    return { ok: true, import: this.#begin("image", image.filename, name, extraction) };
  }

  reload(): Promise<number> {
    return this.deps.reloadCorpus();
  }

  /** Every companies row carrying a fair tag — the durable "who is expected" list. */
  async companiesOnFile(): Promise<FairCompanyOnFile[]> {
    const { data, error } = await this.deps.supabase
      .from("companies")
      .select("company_id,name,facts_json,summary_card,updated_at");
    if (error) throw new Error(`companies read failed: ${error.message}`);
    const rows = (data ?? []) as {
      company_id: string;
      name: string;
      facts_json: Record<string, unknown> | null;
      summary_card: unknown;
      updated_at: string | null;
    }[];
    const out: FairCompanyOnFile[] = [];
    for (const r of rows) {
      const fairs = tagsOf(r.facts_json);
      if (fairs.length === 0) continue;
      out.push({
        companyId: r.company_id,
        name: r.name,
        fairs,
        hasCard: r.summary_card != null,
        updatedAt: r.updated_at ?? "",
      });
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return out;
  }

  // -------------------------------------------------------------------------

  #begin(source: ImportSource, sourceRef: string, fairName: string, extraction: ListExtraction): FairImport {
    const createdAt = new Date(this.#now()).toISOString();
    this.#counter += 1;
    const imp: FairImport = {
      importId: `imp_${this.#counter.toString(36)}_${this.#now().toString(36)}`,
      fairName: fairName.trim().slice(0, FAIR_NAME_MAX) || "Untitled fair",
      source,
      sourceRef,
      status: "enriching",
      createdAt,
      finishedAt: null,
      companies: extraction.companies.map((c) => ({
        name: c.name,
        aliases: c.aliases,
        companyId: null,
        status: "pending",
        note: null,
      })),
      done: 0,
      total: extraction.companies.length,
      reloaded: false,
      corpusSize: null,
      error: null,
    };
    this.#imports.unshift(imp);
    const keep = this.deps.keep ?? DEFAULT_KEEP;
    if (this.#imports.length > keep) this.#imports.length = keep;
    this.deps.logger?.info("fair import started", {
      importId: imp.importId,
      fairName: imp.fairName,
      source,
      companies: imp.total,
    });
    const run = this.#run(imp).catch((err: unknown) => {
      imp.status = "failed";
      imp.error = errText(err);
      imp.finishedAt = new Date(this.#now()).toISOString();
      this.deps.logger?.warn("fair import failed", { importId: imp.importId, err: imp.error });
    });
    this.#runs.set(imp.importId, run);
    return snapshot(imp);
  }

  async #run(imp: FairImport): Promise<void> {
    const existing = await this.#loadExisting();
    const byKey = new Map<string, ExistingRow>();
    const byId = new Map<string, ExistingRow>();
    for (const r of existing) {
      byId.set(r.company_id, r);
      byKey.set(key(r.name), r);
      for (const a of r.aliases ?? []) byKey.set(key(a), r);
    }
    const tag: FairTag = { name: imp.fairName, source: imp.source, importedAt: imp.createdAt };
    const claimed = new Set<string>();

    await runPool(imp.companies, this.deps.concurrency ?? DEFAULT_CONCURRENCY, async (c) => {
      try {
        await this.#processOne(c, tag, byKey, byId, claimed);
      } catch (err) {
        c.status = "failed";
        c.companyId = null;
        c.note = errText(err);
        this.deps.logger?.warn("fair import: company failed", { importId: imp.importId, name: c.name, err: c.note });
      } finally {
        imp.done += 1;
      }
    });

    imp.status = "done";
    imp.finishedAt = new Date(this.#now()).toISOString();
    try {
      imp.corpusSize = await this.deps.reloadCorpus();
      imp.reloaded = true;
      this.deps.logger?.info("fair import done; identify list reloaded", {
        importId: imp.importId,
        corpusSize: imp.corpusSize,
        failed: imp.companies.filter((c) => c.status === "failed").length,
      });
    } catch (err) {
      imp.error = `identify list not reloaded: ${errText(err)}`;
      this.deps.logger?.warn("fair import: reload failed", { importId: imp.importId, err: errText(err) });
    }
  }

  async #processOne(
    c: ImportCompany,
    tag: FairTag,
    byKey: Map<string, ExistingRow>,
    byId: Map<string, ExistingRow>,
    claimed: Set<string>,
  ): Promise<void> {
    // 1. Already on file under this name or one of its aliases (either side)?
    const hit =
      byKey.get(key(c.name)) ??
      c.aliases.map((a) => byKey.get(key(a))).find((r): r is ExistingRow => r !== undefined) ??
      null;
    if (hit) return this.#attach(c, hit, tag);

    // 2. Same slug as an existing id (ContextService's live path names rows the
    //    same way, so a Tavily-learned row is found even if its name differs).
    const companyId = slugify(c.name);
    const collision = byId.get(companyId);
    if (collision) return this.#attach(c, collision, tag);

    if (claimed.has(companyId)) {
      c.companyId = companyId;
      c.status = "matched";
      c.note = "Duplicate of another entry in this list";
      return;
    }
    claimed.add(companyId);

    // 3. New company: evidence -> card -> row.
    const evidence = await this.deps.evidence(c.name);
    const result = await this.deps.writeCard({ name: c.name, aliases: c.aliases, fairName: tag.name, evidence });
    const nowIso = new Date(this.#now()).toISOString();
    const { error } = await this.deps.supabase.from("companies").upsert(
      {
        company_id: companyId,
        name: c.name,
        aliases: c.aliases,
        tier: "marquee",
        summary_md: result.summaryMd,
        roles: result.roles,
        deadlines: [],
        careers_url: "",
        facts_json: { fairs: [tag] },
        summary_card: result.card,
        source: IMPORT_SOURCE_TAG,
        updated_at: nowIso,
      },
      { onConflict: "company_id" },
    );
    if (error) throw new Error(`supabase upsert failed: ${error.message}`);
    // Later entries in this import (or a later import) find it by name/alias.
    const row: ExistingRow = {
      company_id: companyId,
      name: c.name,
      aliases: c.aliases,
      facts_json: { fairs: [tag] },
      summary_card: result.card,
    };
    byId.set(companyId, row);
    byKey.set(key(c.name), row);
    for (const a of c.aliases) byKey.set(key(a), row);
    c.companyId = companyId;
    c.status = "enriched";
    c.note = evidence ? "Card built from web search" : "Card built from public knowledge";
  }

  /** Existing row: tag it with the fair; build its card only if it never had one. */
  async #attach(c: ImportCompany, row: ExistingRow, tag: FairTag): Promise<void> {
    c.companyId = row.company_id;
    const facts = mergeFairTag(row.facts_json, tag);
    const nowIso = new Date(this.#now()).toISOString();

    if (row.summary_card != null) {
      const { error } = await this.deps.supabase
        .from("companies")
        .update({ facts_json: facts, updated_at: nowIso })
        .eq("company_id", row.company_id);
      if (error) throw new Error(`supabase update failed: ${error.message}`);
      row.facts_json = facts;
      c.status = "matched";
      c.note = `Already on file as ${row.name}`;
      return;
    }

    const evidence = await this.deps.evidence(row.name);
    const result = await this.deps.writeCard({
      name: row.name,
      aliases: row.aliases ?? [],
      fairName: tag.name,
      evidence,
    });
    const { error } = await this.deps.supabase
      .from("companies")
      .update({
        summary_md: result.summaryMd,
        roles: result.roles,
        summary_card: result.card,
        facts_json: facts,
        source: IMPORT_SOURCE_TAG,
        updated_at: nowIso,
      })
      .eq("company_id", row.company_id);
    if (error) throw new Error(`supabase update failed: ${error.message}`);
    row.facts_json = facts;
    row.summary_card = result.card;
    c.status = "enriched";
    c.note = `Card built for the existing row ${row.name}`;
  }

  async #loadExisting(): Promise<ExistingRow[]> {
    const { data, error } = await this.deps.supabase
      .from("companies")
      .select("company_id,name,aliases,facts_json,summary_card");
    if (error) throw new Error(`companies read failed: ${error.message}`);
    return (data ?? []) as ExistingRow[];
  }

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ---------------------------------------------------------------------------

function isTag(x: unknown): x is FairTag {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as FairTag).name === "string" &&
    typeof (x as FairTag).importedAt === "string"
  );
}

export function tagsOf(facts: Record<string, unknown> | null | undefined): FairTag[] {
  const raw = facts?.fairs;
  return Array.isArray(raw) ? raw.filter(isTag) : [];
}

/** Append the tag to facts_json.fairs (once per fair name), keeping everything else. */
export function mergeFairTag(
  facts: Record<string, unknown> | null | undefined,
  tag: FairTag,
): Record<string, unknown> {
  const base: Record<string, unknown> = facts && typeof facts === "object" ? { ...facts } : {};
  const fairs = tagsOf(base);
  if (!fairs.some((f) => f.name === tag.name)) fairs.push(tag);
  base.fairs = fairs;
  return base;
}

function snapshot(imp: FairImport): FairImport {
  return { ...imp, companies: imp.companies.map((c) => ({ ...c, aliases: [...c.aliases] })) };
}

async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const width = Math.max(1, Math.min(n, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await fn(item);
      }
    }),
  );
}
