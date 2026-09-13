// The identify candidate list, read from Supabase. Same query cortex/src/index.ts
// runs at boot; kept here (not imported from index.ts) so the module stays
// self-contained and index.ts keeps its boot-time copy untouched.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IdentifyCorpusEntry } from "../identify/IdentifyService.js";

export async function loadIdentifyCorpus(supabase: SupabaseClient): Promise<IdentifyCorpusEntry[]> {
  const { data, error } = await supabase.from("companies").select("company_id,name,aliases");
  if (error) throw new Error(`corpus load failed: ${error.message}`);
  const rows = (data ?? []) as { company_id: string; name: string; aliases: string[] | null }[];
  return rows.map((r) => ({ companyId: r.company_id, name: r.name, aliases: r.aliases ?? [] }));
}
