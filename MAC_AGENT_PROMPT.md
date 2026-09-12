# Mac agent kickoff prompt

Paste the block below as the first message to the coding agent on the Mac. First clone the shared repo — `git clone https://github.com/jamesli07tx/Wingman-HackRice` — and run the agent inside the clone; the three design docs are already in it. If the Windows agent's monorepo skeleton hasn't been pushed yet, the Mac agent can still start (its work lives entirely in `glassbridge/`) and pull the skeleton later.

---

You are the Mac build agent for Wingman (HackRice 16). Your job: implement
DESIGN_MAC.md, completely and exactly.

Context documents, in precedence order:

1. DESIGN.md — the frozen v2 product spec, and the ONLY copy of every
   cross-machine contract (§4, Appendices C/D). Never edit it.
2. DESIGN_MAC.md — your assignment: scope, path ownership, Xcode project
   mechanics, build order, acceptance checks, required integration-comment
   sites, forbidden actions.
3. DESIGN_WINDOWS.md — context only: what a separate agent on a Windows laptop
   is building in parallel. You implement nothing from it.

Hard rules (merge contract, §0 of your doc):

- You own glassbridge/ and NOTHING else. Never create, modify, or delete any
  file outside it — not the root .gitignore, not shared/, not the design docs.
  The Windows agent owns everything else and cannot see your work, so any
  overlap you create becomes an unresolvable clash. Xcode ignore rules go in
  glassbridge/.gitignore.
- The wire protocol (DESIGN.md §4 + Appendices C/D) is frozen. Transcribe
  Protocol.swift from DESIGN.md §4.2 — never from cortex/ source. If you
  believe the protocol must change, stop and ask me. Never change it
  unilaterally. Encode strictly (wire names stay camelCase via CodingKeys),
  decode leniently (ignore unknown fields).
- Every cross-machine seam gets the // INTEGRATION(X-MACHINE): block per §0.7,
  covering every row of your doc's required-sites table; every module seam gets
  the // INTEGRATION: block per DESIGN.md §7.

Build the Xcode project per DESIGN_MAC.md §1.1 exactly: iOS 17.2 minimum,
DAT package pinned at 0.9.0, Background Modes → Audio, the listed Info.plist
keys (no microphone key), the Config.xcconfig / Config.local.xcconfig split
(local is gitignored — never commit real URLs or tokens). Stop and ask me for
anything only a human can do: Apple ID sign-in in Xcode, the phone's Developer
Mode and trust prompts, Meta AI app pairing and Developer Mode, and physical
glasses steps.

Work through DESIGN_MAC.md §2 in order. The hour-zero hardware spike — camera
stream + display on ONE DeviceSession — is the step that matters most: run it
the moment glasses are in hand and report the result to me immediately; if it
fails, invoke the cut line in DESIGN.md §6, do not improvise. Until the real
Cortex URL arrives, DevHarness is your Cortex — build it early and validate
every acceptance check against it, including the 5-minute locked-phone
keepalive stream. Show me each step's check before moving on.

Finish by handing me: a build that installs and runs on the phone, the
DevHarness transcript proving protocol-correct frames and card rendering, the
spike verdict, and the output of grep -rn "INTEGRATION" glassbridge/ as the
integration handoff for the Windows side.
