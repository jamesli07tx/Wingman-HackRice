# Wingman

Zero-touch career-fair copilot for Meta Ray-Ban Display. HackRice 16.

**Read first:** `DESIGN.md` (frozen v2 spec — the only copy of every cross-machine
contract), then `DESIGN_WINDOWS.md` / `DESIGN_MAC.md` (per-machine build plans and
the merge contract).

## Layout

| Path | What | Built on |
|---|---|---|
| `shared/` | Wire protocol types, LLM output schemas, tuning constants | Windows |
| `cortex/` | Backend — WS hub, scene gate, identify/context/pitch/scan, sessions (Fly.io) | Windows |
| `console/` | Next.js web app — onboarding, dashboard, phone capture mode (Vercel) | Windows |
| `corpus/` | Employer corpus ingest + enrichment scripts | Windows |
| `ui/` | Redesigned Next.js console, a second workspace app (`node scripts/dev-ui.mjs` on :3001) | Windows |
| `glassbridge/` | Swift iOS app bridging the glasses (camera stream + HUD render) — see `glassbridge/README.md` and DESIGN_MAC.md | **Mac** |

## Quickstart (Windows side)

```
pnpm install
cp env.example .env    # fill in keys
pnpm -F @wingman/shared test    # protocol contract tests
pnpm -F @wingman/cortex dev     # backend on :8080
```

`glassbridge/` is not a JS workspace package and is never touched from this side
(merge contract, DESIGN_WINDOWS.md §0).
