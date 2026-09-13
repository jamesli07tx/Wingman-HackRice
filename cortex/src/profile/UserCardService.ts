// UserCardService — per-user company briefs (cortex/db/schema.sql user_company_cards).
// A user's own edit of a company's lens card; applied by SessionOrchestrator right before a
// present, so it overrides the shared corpus card (or a live-researched card with the same slug)
// for THAT user's sessions only. Shared corpus rows are never modified from here.
//
// INTEGRATION: UserCardService
// IN:  rest/companyRoutes.ts (list / put / delete as the signed-in user), SessionOrchestrator.getUserCard
// OUT: rows in user_company_cards
import type { SupabaseClient } from "@supabase/supabase-js";
import { SummaryCardSchema, type SummaryCardContent } from "@wingman/shared";
import { slugify } from "../context/ContextService.js";

export interface MyCompany {
  companyId: string;
  name: string;
  card: SummaryCardContent | null;
  /** true when `card` is this user's own version */
  custom: boolean;
}

export class UserCardService {
  constructor(private readonly supabase: SupabaseClient) {}

  /** Every company on file plus the user's own entries, the user's card winning where both exist. */
  async list(userId: string): Promise<MyCompany[]> {
    const [shared, mine] = await Promise.all([
      this.supabase.from("companies").select("company_id, name, summary_card").limit(500),
      this.supabase.from("user_company_cards").select("company_id, name, card").eq("user_id", userId),
    ]);
    if (shared.error) throw new Error(shared.error.message);
    if (mine.error) throw new Error(mine.error.message);
    const out = new Map<string, MyCompany>();
    for (const r of (shared.data ?? []) as { company_id: string; name: string; summary_card: SummaryCardContent | null }[]) {
      out.set(r.company_id, { companyId: r.company_id, name: r.name, card: r.summary_card, custom: false });
    }
    for (const r of (mine.data ?? []) as { company_id: string; name: string; card: SummaryCardContent }[]) {
      out.set(r.company_id, { companyId: r.company_id, name: r.name, card: r.card, custom: true });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(userId: string, companyId: string): Promise<SummaryCardContent | null> {
    const { data, error } = await this.supabase
      .from("user_company_cards")
      .select("card")
      .eq("user_id", userId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const parsed = SummaryCardSchema.safeParse((data as { card?: unknown } | null)?.card);
    return parsed.success ? parsed.data : null;
  }

  /** Upsert; `companyId` null = a company not on file, keyed by slugify(name) so a live-researched
   *  card for the same name is overridden too. Throws on a card outside the C3 limits. */
  async set(userId: string, companyId: string | null, name: string, card: unknown): Promise<MyCompany> {
    const clean = SummaryCardSchema.parse(card);
    const id = companyId ?? slugify(name);
    const { error } = await this.supabase.from("user_company_cards").upsert(
      { user_id: userId, company_id: id, name, card: clean, updated_at: new Date().toISOString() },
      { onConflict: "user_id,company_id" },
    );
    if (error) throw new Error(error.message);
    return { companyId: id, name, card: clean, custom: true };
  }

  async remove(userId: string, companyId: string): Promise<void> {
    const { error } = await this.supabase
      .from("user_company_cards")
      .delete()
      .eq("user_id", userId)
      .eq("company_id", companyId);
    if (error) throw new Error(error.message);
  }
}
