# `corpus/` — employer corpus pipeline (DESIGN.md §5.4, D6, D7)

Runbook (from the repo root; needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` in the root `.env`, and `cortex/db/schema.sql` already run in Supabase):

1. Edit `companies.csv` by hand — `companyId,name,aliases(|-separated),tier,careersUrl`, no commas inside cells.
2. `pnpm -F @wingman/corpus ingest` — validates every row and upserts into `companies`; existing `summary_card` / `summary_md` / `roles` survive (add `--force` to wipe them).
3. `pnpm -F @wingman/corpus enrich` — for each company still missing a card: fetch `careersUrl` (8 s cap, falls back to name+aliases), then ONE `claude-opus-5` call writes `summary_md` + `roles` + the Appendix-C3 `summary_card` (D7: pre-generated cards are what make the `< 5 s` budget honest). Sequential, ~500 ms apart, resumable — just re-run it after any failure; `--only <companyId>` redoes one, `--force` redoes all.
4. When the **HackRice 16 sponsor list drops**: append those rows with `tier=sponsor` (a commented example sits at the top of the CSV), then re-run steps 2 and 3 — swapping the fair is swapping the CSV (D6).
5. Sanity check in the Supabase table editor: every row has a non-null `summary_card` with `title` ≤ 28, `subtitle` ≤ 48, and 3–5 `lines` ≤ 40 chars — that JSON is rendered verbatim on the lens.
