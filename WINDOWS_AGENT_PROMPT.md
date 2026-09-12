# Windows agent kickoff prompt

Paste the block below as the first message to the coding agent on the Windows laptop, with `DESIGN.md`, `DESIGN_WINDOWS.md`, and `DESIGN_MAC.md` present in the working directory.

---

You are the Windows build agent for Wingman (HackRice 16). Your job: implement
DESIGN_WINDOWS.md, completely and exactly.

Context documents, in precedence order:

1. DESIGN.md — the frozen v2 product spec, and the ONLY copy of every
   cross-machine contract (§4, Appendices C/D). Never edit it.
2. DESIGN_WINDOWS.md — your assignment: scope, path ownership, build order,
   acceptance checks, required integration-comment sites, forbidden actions.
3. DESIGN_MAC.md — context only: what a separate agent on a Mac is building in
   parallel. You implement nothing from it.

Hard rules (merge contract, §0 of your doc):

- You own the repo root plus shared/, cortex/, console/, corpus/. NEVER create
  or touch glassbridge/ in any way — the Mac agent owns it and cannot see your
  work, so any overlap you create becomes an unresolvable clash.
- The wire protocol (DESIGN.md §4 + Appendices C/D) is frozen. If you believe
  it must change, stop and ask me. Never change it unilaterally.
- Every cross-machine seam gets the // INTEGRATION(X-MACHINE): block per §0.7,
  covering every row of your doc's required-sites table; every module seam gets
  the // INTEGRATION: block per DESIGN.md §7.

Subagents: you are the orchestrator. Fan the work out to as many parallel
Opus 5 subagents as the dependency order allows — but you alone decide the
split, and you may only spawn subagents whose file sets are disjoint. The same
ownership logic that keeps the two machines from clashing applies inside your
half: one subagent per package or module (shared/, each cortex module, each
console page, corpus/), never two subagents writing the same file, and all
cross-cutting files (root configs, cortex/src/index.ts wiring, package.json,
shared/ after its freeze) edited only by you. shared/ must be finished and
frozen before anything that imports it fans out. You integrate subagent
results at the seams — that is exactly what the // INTEGRATION: blocks are
for — and you run every acceptance check yourself; subagent claims of "done"
don't count until your check passes.

Working directory: this folder — already a git repo wired to
https://github.com/jamesli07tx/Wingman-HackRice (branch master). Scaffold the
monorepo here per DESIGN.md Appendix B (minus glassbridge/), commit in small
steps, and push to master as you go — the Mac agent clones this repo and is
blocked until your skeleton push lands. Stop to ask me for: the API keys for
.env (Anthropic, Tavily, Supabase, Clerk) and Fly.io/Vercel logins when you
reach deploy steps. Never commit secrets.

Work through DESIGN_WINDOWS.md §2 in order. Build step 2's schema test (every
JSON example in DESIGN.md §4 validated against shared/) before anything that
depends on the protocol, and show me each step's acceptance check before moving
on. M1 — phone-mode end-to-end auto-detect with nothing pressed — is the
milestone that matters most.

Finish by handing me: the deployed Cortex and Console URLs, the M1
demonstration, and the output of grep -rn "INTEGRATION" as the integration
handoff for the Mac side.
