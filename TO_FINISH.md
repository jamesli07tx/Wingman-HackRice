# TO_FINISH — Windows-side remaining work

Written for James + the coding agent continuing on the next machine. Mac/GlassBridge work is excluded (that track runs independently; its only dependency on us is §4's URLs). Normative docs: DESIGN.md (frozen v2), DESIGN_WINDOWS.md. Everything below assumes a fresh clone of `https://github.com/jamesli07tx/Wingman-HackRice` (branch `master`).

## State snapshot (as of 2026-09-12, commit `bdc5e2b`+)

**Done and verified:**
- All Windows code complete: `shared/` (9/9 contract tests) · `cortex/` (64/64 tests, full DI wiring, CORS incl. PUT) · `console/` (builds with/without env) · `corpus/` (33/33 companies ingested AND enriched in Supabase — pre-generated cards exist).
- Supabase live: schema applied, 4 tables. Clerk live: app + seeded account working (sign-in, resume upload, links all tested in-browser).
- **Fixture E2E green vs live APIs**: ack +1.4s, corpus Stripe card +4.2s (D7 <5s ✅), scan +3.2s. Laptop-webcam manual test ran through step 5+ of the runbook (banner → card works; pitch rotation requires an uploaded resume — see gotchas).
- Vercel: logged in (`jamesjli2025-4902`), project **wingman-console** exists with `CLERK_SECRET_KEY` + `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` already set for production.
- Deploy configs committed: `Dockerfile`, `.dockerignore`, `fly.toml` (Fly = fallback path, see §6).

**Decision made: deploy cortex on AWS (EC2 + CloudFront)** — team has an AWS account, no domain. CloudFront provides the trusted `https://…cloudfront.net` + WebSocket pass-through that the phone camera (HTTPS-only) and `wss://` chain require. Nothing AWS-side has been started.

## 0. Bootstrap the new machine (~15 min)

1. Clone the repo; install Node 24+, then `npm i -g pnpm@12` (corepack needs admin on Windows); `pnpm install` at root.
2. **Recreate `/.env` at the repo root** — it is gitignored and did NOT travel. Transfer values from the old machine via password manager/AirDrop/USB, never by committing. Required keys (see `env.example`): `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, plus `SUPABASE_ACCESS_TOKEN` (the sbp_ PAT) if further schema work is needed.
3. Smoke the local stack: `pnpm -F @wingman/shared test` (9 green) → `pnpm -F @wingman/cortex start` (expect "identify corpus loaded {companies: 33}") → `node scripts/dev-console.mjs` → browser `http://localhost:3000`, sign in, `/capture` webcam test per the 10-step runbook (in the session transcript; abbreviated: banner image to webcam → card ≤5s).
4. Agent note: `scripts/pipe-env.mjs` pipes secret values into CLIs without displaying them — use it for every secret-bearing command below.

## 1. Security must-dos (10 min, before demo day)

- [ ] **Verify the Anthropic + Tavily keys were actually rotated.** The originals were exposed in git commit `dc9a5c4` (later untracked, but still in history). If not rotated: rotate now, update `.env`.
- [ ] Optional: scrub history (`git rebase`/`filter-repo` on the two commits touching `env.template`, force-push) — James must explicitly approve any force-push.
- [ ] After the hackathon: revoke the Supabase PAT and the AWS access key created in §2.

## 2. Deploy cortex on AWS — EC2 + CloudFront (~60 min)

**Human steps first:**
1. Install AWS CLI v2 (winget `Amazon.AWSCLI` or the MSI). 
2. AWS console → IAM → Users → create user `wingman-deploy` → attach `AdministratorAccess` (hackathon pragmatism; delete the user after the event) → create access key → run `aws configure` (region: `us-east-1`). Also check Billing → Credits for free credits.
3. Tell the agent "aws is configured".

**Agent steps — ALREADY SCRIPTED, one command:** `node scripts/aws/provision.mjs` does everything below end-to-end (idempotent; re-run safe) and prints the final URLs. `node scripts/aws/redeploy.mjs` ships code updates to the instance afterwards. The AWS CLI is already installed on the original Windows machine. Reference sequence the script implements:
1. Security group `wingman-cortex-sg`: inbound TCP 8080 from 0.0.0.0/0 (CloudFront→origin; fine for a hackathon), TCP 22 from the current IP only (or skip SSH and rely on SSM Session Manager — preferred: attach instance profile with `AmazonSSMManagedInstanceCore`).
2. Secrets → SSM Parameter Store as SecureStrings via `scripts/pipe-env.mjs --value KEY | aws ssm put-parameter --name /wingman/KEY --type SecureString --value file:///dev/stdin` (on Windows pipe via stdin equivalent; do NOT put secrets in user-data).
3. EC2 `t3.micro` (free tier) or `t3.small`, Amazon Linux 2023, IAM role allowing `ssm:GetParameter` on `/wingman/*` + SSM core. User-data: install git+Node 24+pnpm, clone the repo, write `/opt/wingman/.env` by reading the SSM parameters at boot, `pnpm install --filter @wingman/cortex...`, run `pnpm -F @wingman/cortex start` under a systemd unit (restart=always) with `PORT=8080`.
4. Verify origin directly: `curl http://<ec2-public-dns>:8080/healthz` → `{"ok":true…}`.
5. CloudFront distribution: origin `<ec2-public-dns>` port 8080 (protocol: HTTP only) · viewer protocol redirect-to-https · **allowed methods: ALL** · cache policy **CachingDisabled** · origin request policy **AllViewer** (headers/query/cookies forwarded — the WS `?token=` auth and `Authorization` header depend on this) · default cert. Wait for deploy (~10 min).
6. Acceptance: `https://<dist>.cloudfront.net/healthz` 200 · a `wss://<dist>.cloudfront.net/ws/device?token=x` attempt reaches cortex (expect auth rejection, not a connection failure) · CORS preflight for PUT still passes through.
7. **Redeploy story** (needed repeatedly during the event): document the one-liner — SSM Run Command / Session Manager: `cd /opt/wingman && git pull && pnpm install --filter @wingman/cortex... && systemctl restart wingman-cortex`.

## 3. Deploy console on Vercel (~10 min, after §2 gives the URL)

**Scripted:** `vercel login` (jamesjli2025 account), then `node scripts/vercel-deploy.mjs https://<dist>.cloudfront.net` — it links the existing `wingman-console` project, pulls settings, bakes the cortex URLs into a local prebuilt build (the monorepo-safe flow; a plain `vercel --prod` can't see the pnpm workspace), and deploys to production. Clerk vars are already on the project.

Acceptance: the production URL loads → sign in on a **phone** → `/capture` gets camera permission (HTTPS!) → banner test passes over the public internet.

## 4. Post-deploy integration + demo prep

- [ ] **M1 on the actual phone** (the milestone): phone → production console → `/capture` → printed banner → card ≤5s, rotation to pitch (resume must be uploaded first — see gotchas), pamphlet scan, `/feed` mission control on a laptop, override drill.
- [ ] Hand the Mac side its two `Config.local.xcconfig` values: `CORTEX_URL=https://<dist>.cloudfront.net`, `CORTEX_WS_URL=wss://<dist>.cloudfront.net`. (That, plus the dashboard link-code flow, is the entire Windows→Mac handoff — DESIGN_WINDOWS.md §0.6.)
- [ ] When HackRice 16 publishes its sponsor list: append rows to `corpus/companies.csv` → `pnpm -F @wingman/corpus ingest` → `enrich` → restart cortex (identify corpus loads at boot).
- [ ] M3 dress rehearsal on a phone hotspot; record the backup demo video; Devpost writeup.
- [ ] Print 2 test banners + 1 fake pamphlet for the venue.

## 5. Known gotchas (learned the hard way — don't relearn)

- **No resume ⇒ no pitch page ⇒ no rotation.** By design. Upload the PDF, then refresh `/capture` (profile loads at session start, and re-showing the same company within 10 min is cooldown-suppressed; a fresh session clears both).
- The console's "Cortex is unreachable" message also fires on CORS failures — check the browser devtools network tab before assuming the server is down.
- `pnpm start` scripts run with cwd = the package dir; only root-aware loaders (`scripts/dev-console.mjs`, cortex's index.ts) find the root `.env`.
- Windows PowerShell eats a bare `--` in native commands and needs `"--"` quoted; prefer `cmd /c "..."` for tricky CLIs.
- Corpus enrich clamps over-length model output rather than rejecting (deterministic-failure lesson); re-running enrich is always safe (resumable, skips carded rows).

## 6. Fallback: Fly.io (fully scripted, if AWS stalls)

`fly.toml` + `Dockerfile` are committed and correct (app `wingman-cortex`, region `dfw`, scale-to-zero disabled for WebSockets). Blocked only on payment for the logged-in Fly account (was Avaneesh's — `fly.io/dashboard/avaneesh-411/billing`; ~$0.35 for the weekend, or buy $5 credit). Resume with: `flyctl apps create wingman-cortex` → `node scripts/pipe-env.mjs ANTHROPIC_API_KEY TAVILY_API_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY CLERK_SECRET_KEY | flyctl secrets import -a wingman-cortex` → `flyctl deploy` → URLs are `https://wingman-cortex.fly.dev` / `wss://…` and §3–4 proceed identically.
