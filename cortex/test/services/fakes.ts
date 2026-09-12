// Test doubles for the cortex service modules. NO network, NO keys, no real
// Supabase client — just enough of the PostgREST builder surface that
// ContextService / ProfileService actually use.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface QueryCall {
  table: string;
  op: string;
  args: unknown[];
}

export interface FakeResult {
  data: unknown;
  error: unknown;
}

/** (table, ops) -> result. `ops` is the chain, e.g. ["select","eq","maybeSingle"]. */
export type FakeRouter = (table: string, ops: string[], calls: QueryCall[]) => FakeResult;

class FakeQuery implements PromiseLike<FakeResult> {
  private ops: string[] = [];

  constructor(
    private readonly table: string,
    private readonly router: FakeRouter,
    private readonly log: QueryCall[],
  ) {}

  private record(op: string, args: unknown[]): this {
    this.ops.push(op);
    this.log.push({ table: this.table, op, args });
    return this;
  }

  select(...args: unknown[]): this {
    return this.record("select", args);
  }
  eq(...args: unknown[]): this {
    return this.record("eq", args);
  }
  or(...args: unknown[]): this {
    return this.record("or", args);
  }
  limit(...args: unknown[]): this {
    return this.record("limit", args);
  }
  maybeSingle(): this {
    return this.record("maybeSingle", []);
  }
  upsert(...args: unknown[]): this {
    return this.record("upsert", args);
  }

  then<R1 = FakeResult, R2 = never>(
    onfulfilled?: ((value: FakeResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    let result: FakeResult;
    try {
      result = this.router(this.table, this.ops, this.log);
    } catch (err) {
      return Promise.reject(err).then(onfulfilled, onrejected);
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

export interface FakeSupabase {
  client: SupabaseClient;
  calls: QueryCall[];
  opsFor(table: string): string[];
}

export function makeFakeSupabase(router: FakeRouter): FakeSupabase {
  const calls: QueryCall[] = [];
  const client = {
    from(table: string) {
      return new FakeQuery(table, router, calls);
    },
  } as unknown as SupabaseClient;
  return {
    client,
    calls,
    opsFor: (table: string) => calls.filter((c) => c.table === table).map((c) => c.op),
  };
}

/** A companies row exactly as cortex/db/schema.sql spells it. */
export function companyRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    company_id: "stripe",
    name: "Stripe",
    aliases: ["Stripe Inc", "stripe.com"],
    tier: "marquee",
    summary_md: "Payments infrastructure.",
    roles: ["SWE Intern"],
    deadlines: ["Oct 31"],
    careers_url: "https://stripe.com/jobs",
    facts_json: { hq: "SF" },
    summary_card: {
      title: "Stripe",
      subtitle: "Payments infrastructure for the internet",
      lines: ["Hiring: SWE Intern", "Stack: Ruby, Go, ML infra", "Recently: usage-based billing"],
    },
    source: "seed",
    updated_at: "2026-09-12T00:00:00.000Z",
    ...over,
  };
}

/** Deterministic fake Tavily endpoint. */
export function makeFakeFetch(
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): {
  fetchImpl: (input: string, init?: unknown) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
  calls: { url: string; init: unknown }[];
} {
  const calls: { url: string; init: unknown }[] = [];
  return {
    calls,
    fetchImpl: async (url: string, init?: unknown) => {
      calls.push({ url, init });
      return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        json: async () => body,
      };
    },
  };
}
