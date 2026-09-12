# Gate prompt A/B on real glasses frames (2026-09-12)

**Symptom:** with the live Cortex, the in-app Feed showed `nothing` for every frame while the wearer looked at
company logos on a laptop screen. Frames, WebSocket and dashboard telemetry all worked; the gate's *definition*
of `banner` excluded screens.

**Method:** claude-haiku-4-5, same structured-output schema as Cortex (C1), same user text "Classify this frame.",
six real frames captured by the Ray-Ban Display through GlassBridge (432×768 JPEG, ~50 KB) plus one 1080×1440
document photo. Current prompt = `GATE_SYSTEM_PROMPT` in `cortex/src/gate/SceneGate.ts` (DESIGN.md Appendix C).

| frame | content | current prompt | proposed prompt |
|---|---|---|---|
| frame-00149 | laptop screen showing STRIPE, ~1 m | `document` / "STRIPE" | **`banner` / "Stripe"** |
| frame-00130 | laptop showing a terminal, no logo | `nothing` | `nothing` |
| frame-00110 | table scene, no logo | `nothing` | `nothing` |
| frame-00090 | blurred person, no logo | `nothing` | `nothing` |
| frame-00070 | table scene, no logo | `nothing` | `nothing` |
| photo-r_18 | conference room, Rice University banner at room distance | `banner` / "Rice University" | `banner` / "Rice University" |

No false positives introduced; the one miss is fixed.

**Proposed `GATE_SYSTEM_PROMPT` (byte-stable after the change — it is prompt-cached):**

```
You classify a single first-person frame from smart glasses at a career fair. `banner` = an employer's name or logo is readable somewhere in the view — on a booth banner, sign, poster, table cloth, tote, or a screen/laptop/phone display — at typical booth distance (1–3 m); it does not need to fill the frame, only to be legible. `document` = a pamphlet/flyer/one-pager held close to the camera filling much of the frame. `nothing` = no readable employer name or logo (too small, blurred, or cut off). If banner, put the most legible organization name in orgHint.
```

Owner: Cortex (Windows side) — edit `cortex/src/gate/SceneGate.ts` (and DESIGN.md Appendix C for the record), redeploy.
Verification: the wearer's Feed tab flips to `banner · <name>` on the next frame that shows a logo.
