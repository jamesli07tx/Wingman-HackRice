// ContextService branching: corpus hit (instant, pre-generated card, D7) vs
// Tavily miss path (live search + condense + cache-back). Fake Supabase, fake
// fetch, fake summarizer — no network, no keys.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUMMARY_CARD_RULES } from "@wingman/shared";
import type { SummaryCardContent } from "@wingman/shared";
import {
  ContextService,
  SUMMARY_CARD_SYSTEM_PROMPT,
  rowToRecord,
  slugify,
} from "../../src/context/ContextService.js";
import { companyRow, makeFakeFetch, makeFakeSupabase } from "./fakes.js";
import type { FakeResult } from "./fakes.js";

const { opusParse } = vi.hoisted(() => ({ opusParse: vi.fn() }));
vi.mock("../../src/llm/anthropic.js", () => ({
  opusParse,
  haikuClassify: vi.fn(),
  opusVisionContent: vi.fn(),
  pdfContent: vi.fn(),
}));

const TAVILY_CARD: SummaryCardContent = {
  title: "Ramp",
  subtitle: "Corporate cards and spend management",
  lines: ["Hiring: SWE Intern (NYC)", "Stack: TypeScript, Go, Postgres", "Recently: launched Ramp AI"],
};

const EMPTY: FakeResult = { data: null, error: null };

beforeEach(() => {
  opusParse.mockReset();
  delete process.env.TAVILY_API_KEY;
});

describe("ContextService — corpus hit (instant path, D7)", () => {
  it("returns the pre-generated summary_card without searching or summarising", async () => {
    const supabase = makeFakeSupabase((table, ops) => {
      if (table === "companies" && ops.includes("maybeSingle")) {
        return { data: companyRow(), error: null };
      }
      return EMPTY;
    });
    const fetchFake = makeFakeFetch({});
    const summarize = vi.fn();

    const svc = new ContextService(supabase.client, fetchFake.fetchImpl, summarize, {
      tavilyApiKey: "unused",
    });
    const ctx = await svc.resolve({ corpusId: "stripe", nameGuess: "Stripe" });

    expect(ctx).not.toBeNull();
    expect(ctx!.companyId).toBe("stripe");
    expect(ctx!.displayName).toBe("Stripe");
    expect(ctx!.card).toEqual(companyRow().summary_card);
    expect(ctx!.record?.careersUrl).toBe("https://stripe.com/jobs");
    expect(fetchFake.calls).toHaveLength(0);
    expect(summarize).not.toHaveBeenCalled();
    expect(opusParse).not.toHaveBeenCalled();
  });

  it("maps snake_case columns onto CompanyRecord", () => {
    const rec = rowToRecord(companyRow() as never);
    expect(rec).toMatchObject({
      companyId: "stripe",
      aliases: ["Stripe Inc", "stripe.com"],
      summaryMd: "Payments infrastructure.",
      careersUrl: "https://stripe.com/jobs",
      factsJson: { hq: "SF" },
      source: "seed",
      updatedAt: "2026-09-12T00:00:00.000Z",
    });
  });
});

describe("ContextService — miss -> Tavily live path", () => {
  it("searches Tavily, condenses to a C3 card, and caches it back as marquee/tavily", async () => {
    const supabase = makeFakeSupabase(() => EMPTY); // nothing in the corpus
    const fetchFake = makeFakeFetch({
      answer: "Ramp is a corporate card and spend management company.",
      results: [
        { title: "Ramp careers", url: "https://ramp.com/careers", content: "SWE Intern, New York." },
      ],
    });
    const summarize = vi.fn().mockResolvedValue(TAVILY_CARD);

    const svc = new ContextService(supabase.client, fetchFake.fetchImpl, summarize, {
      tavilyApiKey: "tvly-test",
    });
    const ctx = await svc.resolve({ corpusId: null, nameGuess: "Ramp" });

    // Tavily REST contract
    expect(fetchFake.calls).toHaveLength(1);
    expect(fetchFake.calls[0].url).toBe("https://api.tavily.com/search");
    const init = fetchFake.calls[0].init as { method: string; body: string };
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body) as { api_key: string; query: string };
    expect(body.api_key).toBe("tvly-test");
    expect(body.query).toBe("Ramp company overview hiring university recruiting");

    // Condensed from the flattened evidence
    expect(summarize).toHaveBeenCalledTimes(1);
    const arg = summarize.mock.calls[0][0] as { name: string; evidence: string };
    expect(arg.name).toBe("Ramp");
    expect(arg.evidence).toContain("corporate card and spend management");
    expect(arg.evidence).toContain("SWE Intern, New York.");

    // Result + cache-back
    expect(ctx!.companyId).toBe("ramp");
    expect(ctx!.card).toEqual(TAVILY_CARD);
    const upsert = supabase.calls.find((c) => c.op === "upsert");
    expect(upsert).toBeDefined();
    expect(upsert!.args[0]).toMatchObject({
      company_id: "ramp",
      name: "Ramp",
      tier: "marquee",
      source: "tavily",
      summary_card: TAVILY_CARD,
    });
  });

  it("takes the instant path when identify missed the id but the name is already in the corpus", async () => {
    const supabase = makeFakeSupabase((table, ops) => {
      if (table === "companies" && ops.includes("or")) return { data: [companyRow()], error: null };
      return EMPTY;
    });
    const fetchFake = makeFakeFetch({});
    const summarize = vi.fn();

    const svc = new ContextService(supabase.client, fetchFake.fetchImpl, summarize, {
      tavilyApiKey: "tvly-test",
    });
    const ctx = await svc.resolve({ corpusId: null, nameGuess: "Stripe" });

    expect(ctx!.companyId).toBe("stripe");
    expect(fetchFake.calls).toHaveLength(0);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("returns null (orchestrator stays silent) when there is no id and no name", async () => {
    const supabase = makeFakeSupabase(() => EMPTY);
    const fetchFake = makeFakeFetch({});
    const svc = new ContextService(supabase.client, fetchFake.fetchImpl, vi.fn(), {
      tavilyApiKey: "tvly-test",
    });

    expect(await svc.resolve({ corpusId: null, nameGuess: null })).toBeNull();
    expect(fetchFake.calls).toHaveLength(0);
  });

  it("throws on a Tavily HTTP failure (search_down), and does not retry a status", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const supabase = makeFakeSupabase(() => EMPTY);
    const fetchFake = makeFakeFetch({}, { ok: false, status: 401 });
    const summarize = vi.fn();
    const svc = new ContextService(supabase.client, fetchFake.fetchImpl, summarize, {
      tavilyApiKey: "tvly-test",
    });

    // A dead key used to read as "No match" on the lens — it is a search outage.
    await expect(svc.resolve({ corpusId: null, nameGuess: "Ramp" })).rejects.toThrow("tavily HTTP 401");
    expect(fetchFake.calls).toHaveLength(1);
    expect(summarize).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toContain("tavily HTTP 401");
    warn.mockRestore();
  });

  it("retries a dropped connection exactly once, inside the same budget", async () => {
    const supabase = makeFakeSupabase(() => EMPTY);
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return {
        ok: true,
        status: 200,
        json: async () => ({ answer: "Ramp does corporate cards.", results: [] }),
      };
    };
    const summarize = vi.fn().mockResolvedValue(TAVILY_CARD);
    const svc = new ContextService(supabase.client, fetchImpl, summarize, {
      tavilyApiKey: "tvly-test",
    });

    const ctx = await svc.resolve({ corpusId: null, nameGuess: "Ramp" });
    expect(calls).toBe(2);
    expect(ctx!.card).toEqual(TAVILY_CARD);
  });

  it("renders the raw evidence degraded (not no_match) when the condense fails", async () => {
    const supabase = makeFakeSupabase(() => EMPTY);
    const fetchFake = makeFakeFetch({
      answer: "Ramp is a corporate card and spend management company.",
      results: [],
    });
    const summarize = vi.fn().mockRejectedValue(new Error("opus down"));
    const svc = new ContextService(supabase.client, fetchFake.fetchImpl, summarize, {
      tavilyApiKey: "tvly-test",
    });

    const ctx = await svc.resolve({ corpusId: null, nameGuess: "Ramp" });
    expect(ctx!.card.subtitle).toBe("Pulling details…");
    expect(ctx!.card.lines[0]).toContain("corporate card");
    // a bad card must never become the cached instant path for this booth
    expect(supabase.calls.find((c) => c.op === "upsert")).toBeUndefined();
  });

  it("throws instead of silently skipping the live path with no TAVILY_API_KEY", async () => {
    const supabase = makeFakeSupabase(() => EMPTY);
    const fetchFake = makeFakeFetch({});
    const svc = new ContextService(supabase.client, fetchFake.fetchImpl, vi.fn());

    await expect(svc.resolve({ corpusId: null, nameGuess: "Ramp" })).rejects.toThrow("tavily key missing");
    expect(fetchFake.calls).toHaveLength(0);
  });
});

describe("ContextService — byId / search / degraded card", () => {
  it("byId synthesises a zero-LLM card when summary_card is null (outage drill)", async () => {
    const supabase = makeFakeSupabase(() => ({
      data: companyRow({ summary_card: null, tier: "sponsor" }),
      error: null,
    }));
    const svc = new ContextService(supabase.client, makeFakeFetch({}).fetchImpl, vi.fn());

    const ctx = await svc.byId("stripe");
    expect(ctx).not.toBeNull();
    expect(ctx!.card.title).toBe("Stripe");
    expect(ctx!.card.lines.length).toBeGreaterThanOrEqual(3);
    expect(ctx!.card.lines.every((l) => l.length <= 40)).toBe(true);
  });

  it("search() maps rows and filters on name/aliases", async () => {
    const supabase = makeFakeSupabase(() => ({
      data: [{ company_id: "stripe", name: "Stripe" }],
      error: null,
    }));
    const svc = new ContextService(supabase.client, makeFakeFetch({}).fetchImpl, vi.fn());

    expect(await svc.search("stri")).toEqual([{ companyId: "stripe", name: "Stripe" }]);
    const or = supabase.calls.find((c) => c.op === "or");
    expect(or!.args[0]).toBe("name.ilike.%stri%,aliases.cs.{stri}");
  });
});

describe("C3 prompt constant", () => {
  it("embeds the ONE canonical card-rules block from @wingman/shared (corpus enrich composes the same block)", () => {
    expect(SUMMARY_CARD_SYSTEM_PROMPT).toContain(SUMMARY_CARD_RULES);
    expect(SUMMARY_CARD_RULES).toContain("At most 28 characters");
    expect(SUMMARY_CARD_RULES).toContain("At most 48 characters");
    expect(SUMMARY_CARD_RULES).toContain("3 to 5 bullets, each at most 40 characters");
    expect(SUMMARY_CARD_RULES).toContain("Ground every claim in the source material provided");
  });

  it("slugify makes a deterministic company_id", () => {
    expect(slugify("Ramp")).toBe("ramp");
    expect(slugify("Goldman Sachs & Co.")).toBe("goldman-sachs-co");
  });
});

