// DESIGN.md Appendix D — tuning constants. Cut lines tune THESE, not code.
// Runtime authority: Cortex pushes the device subset via ArmedMsg.config, so a
// constants edit + Cortex redeploy retunes the glasses without a Swift rebuild.
// Compiled Swift values are fallback defaults only.

import type { ArmedConfig } from "./protocol.js";

export const FRAME_INTERVAL_MS = 1750; // device sampling cadence
export const FRAME_MAX_EDGE_PX = 1280; // full DAT .high frame (720×1280) — no downscale; banner text legibility for the gate
export const DOC_MAX_EDGE_PX = 2048; // document photo (JPEG q ~ 0.8)
export const STABILITY_N = 2; // consecutive gate hits before acting
export const COOLDOWN_MIN = 1; // per-company re-identify suppression (minutes) — a booth revisit inside a demo should re-fire
export const CONF_THRESHOLD = 0.25; // below -> research the name instead of trusting the corpus guess (D13)
export const RENDER_MIN_GAP_MS = 500; // GlassBridge full-screen-replace coalescing
export const PAGE1_MIN_SEC = 5; // summary page hold before first rotation AND before a different company may replace the set
export const ROTATE_SEC = 12; // page alternation interval
export const NO_MATCH_BACKOFF_SEC = 20; // after no_match/timeout: same orgHint is not re-identified (stops the ack/hint loop)

// per-stage timeouts -> degraded card, never a hang:
export const T_GATE_MS = 8000; // opus-5 gate: real p90 overran 4 s and a timed-out frame scores "nothing"
export const T_IDENTIFY_MS = 5000;
export const T_SEARCH_MS = 8000; // Tavily REST leg of the live path (4000 could not fit Tavily + condense)
export const T_RESEARCH_MS = 15000; // whole live research path (Tavily -> opus condense), behind the "Researching…" card
export const T_PITCH_MS = 10000;
export const T_PHOTO_MS = 5000;

// INTEGRATION: deviceConfig()
// IN:  the constants above
// OUT: the ArmedConfig subset Cortex embeds in every ArmedMsg (DESIGN.md §4.2)
// WIRE: SessionOrchestrator calls deviceConfig() when arming a session
export function deviceConfig(): ArmedConfig {
  return {
    frameIntervalMs: FRAME_INTERVAL_MS,
    frameMaxEdgePx: FRAME_MAX_EDGE_PX,
    docMaxEdgePx: DOC_MAX_EDGE_PX,
    renderMinGapMs: RENDER_MIN_GAP_MS,
  };
}
