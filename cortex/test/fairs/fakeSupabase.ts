// Fake PostgREST builder for the fairs tests: records every chained call with
// its args and routes the terminal `then` through a test-provided router.
// Own copy (not an edit of test/services/fakes.ts): this feature adds files only,
// and FairImportService needs `update`, which that fake does not model.

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

/** Sees the whole chain of ONE query (ops in order, args per op). */
export type FakeRouter = (q: { table: string; ops: string[]; calls: QueryCall[] }) => FakeResult;

class FakeQuery implements PromiseLike<FakeResult> {
  readonly calls: QueryCall[] = [];

  constructor(
    private readonly table: string,
    private readonly router: FakeRouter,
    private readonly log: QueryCall[],
  ) {}

  private record(op: string, args: unknown[]): this {
    const call = { table: this.table, op, args };
    this.calls.push(call);
    this.log.push(call);
    return this;
  }

  select(...args: unknown[]): this {
    return this.record("select", args);
  }
  eq(...args: unknown[]): this {
    return this.record("eq", args);
  }
  in(...args: unknown[]): this {
    return this.record("in", args);
  }
  not(...args: unknown[]): this {
    return this.record("not", args);
  }
  or(...args: unknown[]): this {
    return this.record("or", args);
  }
  limit(...args: unknown[]): this {
    return this.record("limit", args);
  }
  order(...args: unknown[]): this {
    return this.record("order", args);
  }
  maybeSingle(): this {
    return this.record("maybeSingle", []);
  }
  single(): this {
    return this.record("single", []);
  }
  upsert(...args: unknown[]): this {
    return this.record("upsert", args);
  }
  update(...args: unknown[]): this {
    return this.record("update", args);
  }
  insert(...args: unknown[]): this {
    return this.record("insert", args);
  }

  then<R1 = FakeResult, R2 = never>(
    onfulfilled?: ((value: FakeResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    let result: FakeResult;
    try {
      result = this.router({ table: this.table, ops: this.calls.map((c) => c.op), calls: this.calls });
    } catch (err) {
      return Promise.reject(err).then(onfulfilled, onrejected);
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

export interface FakeSupabase {
  client: SupabaseClient;
  calls: QueryCall[];
  ops(table: string): string[];
  /** first arg of every `op` call on `table` (e.g. every upsert / update payload) */
  payloads(table: string, op: string): unknown[];
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
    ops: (table) => calls.filter((c) => c.table === table).map((c) => c.op),
    payloads: (table, op) => calls.filter((c) => c.table === table && c.op === op).map((c) => c.args[0]),
  };
}

/** A companies row exactly as cortex/db/schema.sql spells it (Stripe, carded). */
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
