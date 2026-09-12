// Public env, read once. NEXT_PUBLIC_* values are inlined at build time, so these
// must be referenced as full literal property accesses (no dynamic indexing).
//
// Everything here is optional: the console builds and renders with none of it set,
// and degrades to a visible "not configured" state instead of throwing (the backend
// may not be deployed yet).

export const CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
export const CORTEX_URL = (process.env.NEXT_PUBLIC_CORTEX_URL ?? "").replace(/\/+$/, "");
export const CORTEX_WS_URL = (process.env.NEXT_PUBLIC_CORTEX_WS_URL ?? "").replace(/\/+$/, "");

/** Clerk is only mounted when a publishable key exists (keeps `next build` green). */
export const CLERK_ENABLED = CLERK_PUBLISHABLE_KEY.length > 0;
export const CORTEX_CONFIGURED = CORTEX_URL.length > 0;
export const CORTEX_WS_CONFIGURED = CORTEX_WS_URL.length > 0;
