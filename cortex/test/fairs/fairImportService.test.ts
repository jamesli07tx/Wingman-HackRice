// FairImportService: link/image entry points, matching against what is on file,
// new-row shape (slug parity with ContextService, tier marquee, facts_json.fairs
// tag), per-company failure isolation, and exactly ONE corpus reload at the end.
// Fake Supabase, fake fetch, fake extractor/evidence/card writer — no network.

import { describe, expect, it, vi } from "vitest";
import { slugify } from "../../src/context/ContextService.js";
import type { ListExtraction } from "../../src/fairs/extract.js";
import {
  FairImportService,
  IMPORT_SOURCE_TAG,
  mergeFairTag,
  tagsOf,
} from "../../src/fairs/FairImportService.js";
import type { FairImportDeps } from "../../src/fairs/FairImportService.js";
import type { FetchLike } from "../../src/fairs/fetchPage.js";
import { companyRow, makeFakeSupabase } from "./fakeSupabase.js";

const NOW = 1_757_700_000_000;
const NOW_ISO = new Date(NOW).toISOString();

const CARD = {
  summaryMd: "Acme makes rockets.",
  roles: ["SWE Intern"],
  card: { title: "Acme Rockets", subtitle: "Rockets", lines: ["Hiring: SWE Intern", "Rockets", "Houston"] },
};

const PAGE_HTML = `<html><head><title>Fair page</title></head><body>
<section id="sponsors"><a aria-label="Acme Rockets — visit website"></a><a aria-label="Capital One — visit website"></a></section>
<p>${"filler ".repeat(30)}</p></body></html>`;

const okFetch =
  (html = PAGE_HTML): FetchLike =>
  async () => ({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

const EXTRACTION: ListExtraction = {
  fairName: "HackRice 16",
  companies: [
    { name: "Acme Rockets", aliases: ["Acme"] },
    { name: "STRIPE INC", aliases: [] },
  ],
};

function makeService(over: Partial<FairImportDeps> & { rows?: unknown[] } = {}) {
  const rows = over.rows ?? [companyRow()]; // Stripe on file, carded
  const supabase = makeFakeSupabase(({ table, ops }) => {
    if (table !== "companies") return { data: null, error: null };
    if (ops[0] === "select") return { data: rows, error: null };
    return { data: null, error: null }; // update / upsert succeed
  });
  const extract = vi.fn(async (): Promise<ListExtraction> => EXTRACTION);
  const evidence = vi.fn(async () => "evidence text");
  const writeCard = vi.fn(async () => CARD);
  const reloadCorpus = vi.fn(async () => 35);
  const { rows: _rows, ...rest } = over;
  const svc = new FairImportService({
    supabase: supabase.client,
    fetchImpl: okFetch(),
    extract,
    evidence,
    writeCard,
    reloadCorpus,
    concurrency: 2,
    now: () => NOW,
    ...rest,
  });
  return { svc, supabase, extract, evidence, writeCard, reloadCorpus };
}

describe("startFromLink — the link must be usable", () => {
  it("dead link -> 422 link_failed, and nothing is extracted", async () => {
    const dead: FetchLike = async () => {
      throw new Error("ENOTFOUND");
    };
    const { svc, extract } = makeService({ fetchImpl: dead });
    const r = await svc.startFromLink("https://nope.test", null);
    expect(r).toMatchObject({ ok: false, status: 422, body: { error: "link_failed", reason: "fetch_failed" } });
    expect(extract).not.toHaveBeenCalled();
  });

  it("gated page (200 but no list) -> link_failed no_companies", async () => {
    const { svc } = makeService({ extract: async () => ({ fairName: null, companies: [] }) });
    const r = await svc.startFromLink("https://gated.test/roster", null);
    expect(r).toMatchObject({ ok: false, status: 422, body: { error: "link_failed", reason: "no_companies" } });
  });

  it("extractor failure is NOT a link failure (502 extract_failed; the console keeps the link enabled)", async () => {
    const { svc } = makeService({
      extract: async () => {
        throw new Error("opus down");
      },
    });
    const r = await svc.startFromLink("https://hackrice.com", null);
    expect(r).toMatchObject({ ok: false, status: 502, body: { error: "extract_failed" } });
  });
});

describe("startFromLink — happy path", () => {
  it("creates a new carded row, tags the existing one, reloads the corpus once", async () => {
    const { svc, supabase, evidence, writeCard, reloadCorpus, extract } = makeService();
    const r = await svc.startFromLink("https://hackrice.com", null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.import.fairName).toBe("HackRice 16"); // from the extraction
    expect(r.import.sourceRef).toBe("https://hackrice.com/");
    expect(r.import.status).toBe("enriching");
    expect(r.import.companies.map((c) => c.status)).toEqual(["pending", "pending"]);
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "text", sourceUrl: "https://hackrice.com/", title: "Fair page" }),
    );

    const done = await svc.settled(r.import.importId);
    expect(done).not.toBeNull();
    expect(done!.status).toBe("done");
    expect(done!.done).toBe(2);
    expect(done!.reloaded).toBe(true);
    expect(done!.corpusSize).toBe(35);
    expect(reloadCorpus).toHaveBeenCalledTimes(1);

    // New company: evidence -> card -> upsert with the contract row shape.
    const acme = done!.companies.find((c) => c.name === "Acme Rockets")!;
    expect(acme.status).toBe("enriched");
    expect(acme.companyId).toBe(slugify("Acme Rockets"));
    expect(evidence).toHaveBeenCalledWith("Acme Rockets");
    expect(writeCard).toHaveBeenCalledWith({
      name: "Acme Rockets",
      aliases: ["Acme"],
      fairName: "HackRice 16",
      evidence: "evidence text",
    });
    const upserts = supabase.payloads("companies", "upsert") as Record<string, unknown>[];
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      company_id: "acme-rockets",
      name: "Acme Rockets",
      aliases: ["Acme"],
      tier: "marquee",
      summary_md: CARD.summaryMd,
      roles: CARD.roles,
      summary_card: CARD.card,
      source: IMPORT_SOURCE_TAG,
      facts_json: { fairs: [{ name: "HackRice 16", source: "link", importedAt: NOW_ISO }] },
      updated_at: NOW_ISO,
    });

    // Existing company matched case-insensitively through its alias: tagged only.
    const stripe = done!.companies.find((c) => c.name === "STRIPE INC")!;
    expect(stripe.status).toBe("matched");
    expect(stripe.companyId).toBe("stripe");
    expect(writeCard).toHaveBeenCalledTimes(1);
    const updates = supabase.payloads("companies", "update") as Record<string, unknown>[];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      facts_json: { hq: "SF", fairs: [{ name: "HackRice 16", source: "link", importedAt: NOW_ISO }] },
      updated_at: NOW_ISO,
    });
    const eqArgs = supabase.calls.find((c) => c.table === "companies" && c.op === "eq")!.args;
    expect(eqArgs).toEqual(["company_id", "stripe"]);
  });

  it("an explicit fair name wins over the extracted one", async () => {
    const { svc } = makeService();
    const r = await svc.startFromLink("https://hackrice.com", "My Fair");
    expect(r.ok && r.import.fairName).toBe("My Fair");
  });

  it("an existing row WITHOUT a card gets one now (update, not upsert)", async () => {
    const { svc, supabase, writeCard } = makeService({
      rows: [companyRow({ summary_card: null, facts_json: null })],
    });
    const r = await svc.startFromLink("https://hackrice.com", null);
    const done = await svc.settled(r.ok ? r.import.importId : "");
    const stripe = done!.companies.find((c) => c.name === "STRIPE INC")!;
    expect(stripe.status).toBe("enriched");
    expect(writeCard).toHaveBeenCalledWith(expect.objectContaining({ name: "Stripe", aliases: ["Stripe Inc", "stripe.com"] }));
    const updates = supabase.payloads("companies", "update") as Record<string, unknown>[];
    expect(updates[0]).toMatchObject({ summary_card: CARD.card, source: IMPORT_SOURCE_TAG });
    expect((updates[0]!.facts_json as { fairs: unknown[] }).fairs).toHaveLength(1);
  });

  it("one company failing does not sink the import; the reload still happens", async () => {
    const writeCard = vi.fn(async (input: { name: string }) => {
      if (input.name === "Acme Rockets") throw new Error("refused");
      return CARD;
    });
    const { svc, reloadCorpus, supabase } = makeService({ writeCard });
    const r = await svc.startFromLink("https://hackrice.com", null);
    const done = await svc.settled(r.ok ? r.import.importId : "");
    expect(done!.status).toBe("done");
    const acme = done!.companies.find((c) => c.name === "Acme Rockets")!;
    expect(acme.status).toBe("failed");
    expect(acme.note).toContain("refused");
    expect(acme.companyId).toBeNull();
    expect(supabase.payloads("companies", "upsert")).toHaveLength(0);
    expect(done!.companies.find((c) => c.name === "STRIPE INC")!.status).toBe("matched");
    expect(reloadCorpus).toHaveBeenCalledTimes(1);
  });

  it("a failed reload is reported on the import without failing it", async () => {
    const { svc } = makeService({
      reloadCorpus: async () => {
        throw new Error("db gone");
      },
    });
    const r = await svc.startFromLink("https://hackrice.com", null);
    const done = await svc.settled(r.ok ? r.import.importId : "");
    expect(done!.status).toBe("done");
    expect(done!.reloaded).toBe(false);
    expect(done!.error).toContain("db gone");
  });

  it("two list entries collapsing to one slug produce one row", async () => {
    const { svc, supabase } = makeService({
      extract: async () => ({
        fairName: "F",
        companies: [
          { name: "Acme Rockets", aliases: [] },
          { name: "Acme-Rockets!", aliases: [] },
        ],
      }),
    });
    const r = await svc.startFromLink("https://hackrice.com", null);
    const done = await svc.settled(r.ok ? r.import.importId : "");
    expect(supabase.payloads("companies", "upsert")).toHaveLength(1);
    expect(done!.companies.map((c) => c.status).sort()).toEqual(["enriched", "matched"]);
  });
});

describe("startFromImage", () => {
  it("passes the image to the extractor and names the fair from it", async () => {
    const { svc, extract } = makeService();
    const r = await svc.startFromImage(
      { buffer: Buffer.from("png-bytes"), mediaType: "image/png", filename: "roster.png" },
      null,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.import.source).toBe("image");
    expect(r.import.sourceRef).toBe("roster.png");
    expect(r.import.fairName).toBe("HackRice 16");
    expect(extract).toHaveBeenCalledWith({
      kind: "image",
      base64: Buffer.from("png-bytes").toString("base64"),
      mediaType: "image/png",
    });
    const done = await svc.settled(r.import.importId);
    expect(done!.status).toBe("done");
  });

  it("an image with no list -> 422 image_failed", async () => {
    const { svc } = makeService({ extract: async () => ({ fairName: null, companies: [] }) });
    const r = await svc.startFromImage({ buffer: Buffer.from("x"), mediaType: "image/jpeg", filename: "a.jpg" }, null);
    expect(r).toMatchObject({ ok: false, status: 422, body: { error: "image_failed" } });
  });
});

describe("bookkeeping", () => {
  it("list() is newest first and get() snapshots (mutation-safe)", async () => {
    const { svc } = makeService();
    const a = await svc.startFromLink("https://a.test", "A");
    const b = await svc.startFromLink("https://b.test", "B");
    expect(svc.list().map((i) => i.fairName)).toEqual(["B", "A"]);
    const snap = svc.get(a.ok ? a.import.importId : "")!;
    snap.companies[0]!.name = "mutated";
    expect(svc.get(snap.importId)!.companies[0]!.name).not.toBe("mutated");
    await svc.settled(b.ok ? b.import.importId : "");
  });

  it("companiesOnFile keeps only tagged rows, newest first", async () => {
    const rows = [
      companyRow({ company_id: "old", name: "Old", facts_json: { fairs: [{ name: "F1", source: "link", importedAt: "2026-01-01" }] }, updated_at: "2026-01-01T00:00:00Z" }),
      companyRow({ company_id: "untagged", name: "Untagged", facts_json: {} }),
      companyRow({ company_id: "new", name: "New", summary_card: null, facts_json: { fairs: [{ name: "F2", source: "image", importedAt: "2026-09-12" }] }, updated_at: "2026-09-12T00:00:00Z" }),
      companyRow({ company_id: "junk", name: "Junk", facts_json: { fairs: "nope" } }),
    ];
    const { svc } = makeService({ rows });
    const out = await svc.companiesOnFile();
    expect(out.map((c) => c.companyId)).toEqual(["new", "old"]);
    expect(out[0]).toMatchObject({ name: "New", hasCard: false, fairs: [{ name: "F2" }] });
  });

  it("mergeFairTag appends once per fair name and keeps other facts; tagsOf ignores junk", () => {
    const tag = { name: "HackRice 16", source: "link", importedAt: NOW_ISO };
    const once = mergeFairTag({ hq: "SF" }, tag);
    expect(once).toEqual({ hq: "SF", fairs: [tag] });
    const twice = mergeFairTag(once, { ...tag, importedAt: "later" });
    expect((twice.fairs as unknown[]).length).toBe(1);
    expect(mergeFairTag(null, tag)).toEqual({ fairs: [tag] });
    expect(tagsOf({ fairs: [tag, { bogus: true }, "x"] })).toEqual([tag]);
    expect(tagsOf(null)).toEqual([]);
  });
});
