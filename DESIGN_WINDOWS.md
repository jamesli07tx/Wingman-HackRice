# Wingman — Windows Build Plan (DESIGN_WINDOWS.md)

**You are the agent on the Windows laptop.** You implement this file. DESIGN.md (v2) is the normative spec for everything you build; DESIGN_MAC.md describes what the other agent — on a separate Mac, with whom you cannot communicate — is building in parallel. Read all three, implement only what this file assigns you.

---

## 0. Merge contract (identical section in DESIGN_MAC.md — the rules that make a clash impossible)

**Path ownership is absolute and disjoint.** Merging the two work products is a union of directories; a git conflict is structurally impossible if both sides obey this table:

| Path | Owner | The other side may |
|---|---|---|
| `/` root files (`pnpm-workspace.yaml`, `package.json`, `.gitignore`, `.env.example`, `README.md`, `DESIGN*.md`) | **Windows** | read only |
| `shared/` `cortex/` `console/` `corpus/` | **Windows** | read only |
| `glassbridge/` — everything inside, including `glassbridge/.gitignore`, `glassbridge/README.md`, `glassbridge/DevHarness/` | **Mac** | read only |

1. **NEVER create, modify, or delete any file inside `glassbridge/`.** Do not create the directory, do not "helpfully" scaffold it, do not add it to `pnpm-workspace.yaml` (it is not a JS package). If root `.gitignore` needs Xcode rules, don't add them — the Mac owns `glassbridge/.gitignore`.
2. **The wire contract is the only interface** between the two builds: the device WebSocket (§4.2), the `/api/devices/claim` REST endpoint (§4.1), `HudCard` + renderer constraints (§4.2), and the tuning constants (Appendix D, pushed at runtime via `armed.config`). **DESIGN.md is the ONLY copy of that contract.** No contract JSON is restated in this file or DESIGN_MAC.md, so there is exactly one document to drift from — and it is frozen.
3. **No unilateral protocol changes, ever.** If you believe a §4 / Appendix C / Appendix D change is necessary, STOP and surface it to the human. The counterpart agent cannot see your change; a "small fix" on one side is a broken demo. Additive, optional fields are the only change class the human should even consider mid-event.
4. **Lenient decoding, strict encoding.** Emit messages exactly as specified (field names stay camelCase on the wire). When decoding, ignore unknown fields rather than erroring — this is what makes additive evolution safe on both sides.
5. **Git flow:** the shared GitHub repo already exists — `https://github.com/jamesli07tx/Wingman-HackRice`, default branch `master`, founded by the human with the design docs in it. Windows pushes the monorepo skeleton first; Mac clones, then commits only inside `glassbridge/`. Both push to `master` freely — disjoint paths mean no conflicts. (Offline fallback: the Mac's `glassbridge/` folder is copied into the repo root by USB/AirDrop; same result.)
6. **Integration-day sequence** (human-driven, ~15 min): ① Windows side has Cortex deployed → gives the `wss://…fly.dev` URL to the human. ② Human sets it in `glassbridge/Config.local.xcconfig` and rebuilds GlassBridge on the phone. ③ Dashboard → "Link glasses" → 6-digit code → typed into GlassBridge → `/api/devices/claim`. ④ Start from either end → M2 checks (DESIGN.md §6).
7. **Cross-machine integration comments are mandatory.** Beyond DESIGN.md §7's per-module `// INTEGRATION:` blocks, every point where your code touches the cross-machine seam carries a greppable block in this exact format:
   ```
   // INTEGRATION(X-MACHINE):
   // COUNTERPART: <file/component on the other machine that connects here>
   // CONTRACT: DESIGN.md §<ref> — <message/endpoint name>
   // AT-INTEGRATION: <the exact action or check for integration day — fill this value / run this check / nothing, wired automatically>
   ```
   Anything deliberately deferred to integration day is additionally marked `INTEGRATION-DAY: <exact action>` at the deferred line. The integration agent (or human) works from `grep -rn "INTEGRATION"` output plus the three design docs and nothing else — write every block so that is sufficient. Each machine doc lists its required comment sites; missing sites are a build defect, not a style issue.

---

## 1. Your scope

Everything in DESIGN.md **except** `glassbridge/`:

- **Repo root**: pnpm workspace (`shared`, `cortex`, `console`, `corpus` — NOT `glassbridge`), `.env.example` (Appendix A verbatim), root `.gitignore` (node/Next/env rules only), `README.md` with a section "`glassbridge/` — built on the Mac, see `glassbridge/README.md` and DESIGN_MAC.md" (do not create that folder or file).
- **`shared/src/`** — `protocol.ts`, `constants.ts`, `schemas.ts`, transcribed **exactly** from DESIGN.md §4 + Appendices C/D. No renames, no "improvements": the Mac agent hand-mirrors the same doc into Swift, and the doc is the meeting point. Include the `armed.config` object type.
- **`cortex/`** — all modules per §5.3 with the DI + `// INTEGRATION:` rules of §7: `DeviceGateway` (device WS incl. `?token=` auth, dashboard WS with Clerk JWT), `SceneGate` (haiku gate + D13 stability/single-flight/cooldown), `IdentifyService`, `ContextService`, `PitchService`, `ScanService`, `ProfileService`, `SessionOrchestrator` (state machine §3.3 + rotation timer; sends `armed.config` from constants). Model house rules: DESIGN.md §2 (haiku gets **no** `thinking` param; opus-5 adaptive + refusal fallbacks). Deploy target: Fly.io region `dfw`, app name `wingman-cortex` (Railway fallback).
- **`cortex/fixtures/`** — the canned frame walk for `MockDeviceAdapter`: ~10 JPEGs (nothing ×3 → banner ×3 → nothing ×2 → document ×2) generated or hand-collected; this is the no-hardware test rig for the entire pipeline.
- **`console/`** — per §5.2: home (devices, profile upload, Start/Stop), `/capture` phone mode (auto-detect, no buttons — this is the demo-of-record fallback), `/feed` (live feed + gate telemetry + override picker), `/instructions`. Clerk throughout; one seeded demo account.
- **`corpus/`** — `companies.csv`, `ingest-csv.ts`, `enrich.ts` incl. `summaryCard` pre-generation (contract term D7).

### Required `INTEGRATION(X-MACHINE)` comment sites (§0.7) — Windows

| Site | COUNTERPART | AT-INTEGRATION says |
|---|---|---|
| `shared/src/protocol.ts` (file header) | `glassbridge/Wingman/Protocol.swift` (hand-mirror) | nothing — but any edit here after hour 2 requires human sign-off and a matching Swift change |
| `cortex/src/gateway/DeviceGateway.ts` — WS upgrade + `?token=` auth handler | `CortexSocket.swift` | verify a `hello` with `deviceType:"glasses_bridge"` arrives after link |
| `cortex/src/rest/routes.ts` — `/api/devices/link-code` + `/api/devices/claim` | GlassBridge link screen (`StatusView.swift`) | run the code→claim flow once; confirm device appears in `GET /api/devices` |
| `SessionOrchestrator` — construction of `armed.config` | `FrameSampler.swift` / `HudRenderer.swift` override points | confirm glasses cadence changes after editing `shared/constants.ts` + redeploy |
| Fly deploy config (`fly.toml`) | `glassbridge/Config.local.xcconfig` | hand the human the final `https://` + `wss://` URLs — keep them stable after M1 |
| `console` `/feed` page (dashboard WS consumer) | the human debugging GlassBridge | none — but note it is the Mac side's observability window |

## 2. Build order & self-contained acceptance checks (none require the Mac)

1. Scaffold + deploy hello-world Cortex to Fly and hello-world Console to Vercel. Push to GitHub — the Mac clones after this push.
2. `shared/` transcription. **Check:** every JSON example in DESIGN.md §4 validates against `schemas.ts`/`protocol.ts` types — write a small test that literally embeds the doc's examples.
3. `DeviceGateway` + `MockDeviceAdapter` + `SceneGate` + `IdentifyService` on fixtures. **Check:** fixture walk in → ack card, company card, pitch page, scan merge out, in order, with D13 rules observable (drop-while-in-flight, cooldown).
4. Phone mode E2E. **Check = M1 (DESIGN.md §6):** point the laptop/phone camera at a printed banner, touch nothing → card appears in the bubble.
5. Context/pitch/scan/profile/corpus + dashboard feed + override. **Check:** override forces a card with LLM calls disabled (outage drill, §8).
6. Prompt-cache verification: `cache_read_input_tokens > 0` on gate calls after warm-up.

## 3. What you hand the Mac side (via the human, at integration)

- The deployed Cortex base URLs (`https://…` and `wss://…`) — keep them stable after M1; the Mac bakes them into an xcconfig.
- A working `/api/devices/link-code` + `/api/devices/claim` flow and a dashboard that shows the code — the Mac's link screen is useless without it.
- A live `/feed` page — it is the Mac agent's main debugging window into what Cortex thinks the glasses are seeing.

## 4. Forbidden

Touching `glassbridge/**` in any way · changing any §4 / Appendix C / D name, type, or semantic · adding required fields to any wire message · renaming REST routes · moving the WS auth off `?token=` · "cleaning up" DESIGN.md. When blocked on any of these: stop, ask the human.
