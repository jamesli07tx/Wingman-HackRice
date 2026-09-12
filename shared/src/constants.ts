// DESIGN.md Appendix D — tuning constants. Cut lines tune THESE, not code.
// Runtime authority: Cortex pushes the device subset via ArmedMsg.config, so a
// constants edit + Cortex redeploy retunes the glasses without a Swift rebuild.
// Compiled Swift values are fallback defaults only.

import type { ArmedConfig } from "./protocol.js";

export const FRAME_INTERVAL_MS = 1750; // device sampling cadence
export const FRAME_MAX_EDGE_PX = 768; // frame downscale (JPEG q ~ 0.6)
export const DOC_MAX_EDGE_PX = 2048; // document photo (JPEG q ~ 0.8)
export const STABILITY_N = 2; // consecutive gate hits before acting
export const COOLDOWN_MIN = 10; // per-company re-identify suppression (minutes)
export const CONF_THRESHOLD = 0.6; // below -> silence on lens, log to dashboard
export const RENDER_MIN_GAP_MS = 500; // GlassBridge full-screen-replace coalescing
export const PAGE1_MIN_SEC = 15; // summary page hold before first rotation
export const ROTATE_SEC = 12; // page alternation interval

// per-stage timeouts -> degraded card, never a hang:
export const T_GATE_MS = 3000;
export const T_IDENTIFY_MS = 5000;
export const T_SEARCH_MS = 4000;
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
