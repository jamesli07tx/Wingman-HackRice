# @wingman/ui — redesigned console

The redesigned Wingman web console (Confidanz product brand: white cards, navy
titles, product-blue rounded buttons, Roboto), as a second workspace app next
to `console/`. Same routes and the same Cortex contracts (DESIGN.md §4.1/§4.3),
different look and interaction grammar. It shares `@wingman/shared` through the
workspace link like everything else in this repo.

Snapshot of the `ui-redesign` branch work taken 2026-09-12; `console/` remains
the app the deploy scripts publish until this one is adopted.

## Run

```
node scripts/dev-ui.mjs        # :3001, env from the root .env (cortex defaults to localhost:8080)
pnpm -F @wingman/ui typecheck
pnpm -F @wingman/ui build
```

It runs side by side with `node scripts/dev-console.mjs` (:3000).

## Routes

- `/` — session hero (Start/Stop), device linking, profile
- `/feed` — live feed: every card, gate telemetry, silenced identifications, override picker
- `/fair` — drop in a fair's exhibitor list (public link or roster screenshot) before the event
- `/instructions` — wearer instructions
- `/capture` — phone mode (camera + AR bubble), the hardware-free fallback demo
- `/sign-in` — Clerk

Environment variables are the ones in `console/README.md`; the build needs none of them.
