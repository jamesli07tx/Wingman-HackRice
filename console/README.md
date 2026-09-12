# @wingman/console

Next.js 15 (app router, TS, Tailwind v4) — onboarding/home, live feed, instructions,
and the phone-mode `/capture` page (owned separately, see DESIGN.md §5.2).

Deploy target: Vercel. Root directory = `console/`.

## Environment variables (subset of DESIGN.md Appendix A)

| Var | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | client + middleware | absent ⇒ auth is bypassed (see below) |
| `CLERK_SECRET_KEY` | middleware (server) | absent ⇒ auth is bypassed |
| `NEXT_PUBLIC_CORTEX_URL` | client REST (`https://wingman-cortex.fly.dev`) | absent ⇒ UI shows "Cortex URL not configured" |
| `NEXT_PUBLIC_CORTEX_WS_URL` | `/feed` + `/capture` (`wss://wingman-cortex.fly.dev`) | absent ⇒ feed shows a disconnected banner |

**Build never requires any of them.** `src/middleware.ts` falls back to a pass-through
when the Clerk keys are missing, and `src/app/layout.tsx` only mounts `<ClerkProvider>`
when the publishable key is present, so `next build` works on a clean checkout. Every
data-fetching page is `force-dynamic`; nothing is fetched at build time.

## Auth

All REST calls carry `Authorization: Bearer <Clerk session JWT>`; the dashboard
WebSocket carries the same JWT as `?token=`. Both come from one place —
`useCortexAuth().getToken()` in `src/lib/auth.tsx` — which wraps Clerk's `useAuth()`
behind a context so pages never import Clerk directly and so the app still renders
when Clerk is unconfigured.

Single seeded demo account (D8) is a human step: create the user in the Clerk dashboard.

## Routes

- `/` — mode toggle (Glasses/Phone), device list + link-code flow, profile, Start/Stop
- `/feed` — dashboard WS: card feed, gate telemetry, silenced-identify warnings, HUD preview, override picker
- `/instructions` — wearer instructions (DESIGN.md §5.2)
- `/sign-in/[[...sign-in]]` — Clerk sign-in
- `/capture` — phone mode, owned by the device track (not built here)
