// INTEGRATION: capture/env
// IN:  NEXT_PUBLIC_CORTEX_URL, NEXT_PUBLIC_CORTEX_WS_URL (DESIGN.md Appendix A)
// OUT: normalized base URLs + the device WS URL builder used by useDeviceLink
// WIRE: nothing to wire — module-level constants, inlined by Next at build time.
//
// NOTE: these must be referenced as literal `process.env.NEXT_PUBLIC_*` member
// expressions for Next's client-side inlining to work. Do not make them dynamic.

const stripSlash = (s: string): string => s.replace(/\/+$/, "");

export const CORTEX_URL: string = stripSlash(process.env.NEXT_PUBLIC_CORTEX_URL ?? "");
export const CORTEX_WS_URL: string = stripSlash(process.env.NEXT_PUBLIC_CORTEX_WS_URL ?? "");

/** DESIGN.md §4.1 — phone mode mints its own device token (D9). */
export const SELF_CLAIM_PATH = "/api/devices/self-claim";

/** DESIGN.md §4.2 — device WS auth rides on `?token=`, never a header. */
export function deviceWsUrl(deviceToken: string): string {
  return `${CORTEX_WS_URL}/ws/device?token=${encodeURIComponent(deviceToken)}`;
}

export function envReady(): boolean {
  return CORTEX_URL.length > 0 && CORTEX_WS_URL.length > 0;
}

/** Short human label for the device name sent to self-claim. */
export function platformLabel(): string {
  if (typeof navigator === "undefined") return "phone";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  return "phone";
}
