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
