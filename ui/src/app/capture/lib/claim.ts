// INTEGRATION: capture/claim
// IN:  a Clerk session JWT (from useAuth().getToken) + NEXT_PUBLIC_CORTEX_URL
// OUT: { deviceId, deviceToken } from POST /api/devices/self-claim (DESIGN.md §4.1, D9),
//      cached in localStorage so a reload does not mint a new device
// WIRE: useDeviceLink calls ensureClaim() immediately before every WS connect attempt.

import type { ClaimResponse, SelfClaimRequest } from "@wingman/shared";
import { CORTEX_URL, SELF_CLAIM_PATH, platformLabel } from "./env";

const STORAGE_KEY = "wingman.capture.device.v1";

export interface DeviceClaim {
  deviceId: string;
  deviceToken: string;
}

function readCache(): DeviceClaim | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ClaimResponse).deviceId === "string" &&
      typeof (parsed as ClaimResponse).deviceToken === "string"
    ) {
      return { deviceId: (parsed as ClaimResponse).deviceId, deviceToken: (parsed as ClaimResponse).deviceToken };
    }
  } catch {
    /* private mode / corrupt entry — fall through to a fresh claim */
  }
  return null;
}

function writeCache(claim: DeviceClaim): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(claim));
  } catch {
    /* non-fatal: we just re-claim next load */
  }
}

export function clearCachedClaim(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export class ClaimError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ClaimError";
    this.status = status;
  }
}

/** POST /api/devices/self-claim — idempotent per user (D9). */
async function selfClaim(jwt: string): Promise<DeviceClaim> {
  const body: SelfClaimRequest = { name: `${platformLabel()} (phone mode)` };
  const res = await fetch(`${CORTEX_URL}${SELF_CLAIM_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ClaimError(`self-claim failed (${res.status})`, res.status);
  }
  const json: unknown = await res.json();
  const claim = json as Partial<ClaimResponse>;
  if (typeof claim.deviceId !== "string" || typeof claim.deviceToken !== "string") {
    throw new ClaimError("self-claim returned a malformed body", 500);
  }
  return { deviceId: claim.deviceId, deviceToken: claim.deviceToken };
}

/**
 * Returns a usable device claim.
 * `force` skips (and clears) the cache — used when Cortex rejects the cached
 * deviceToken on the WS upgrade (401-equivalent close code), which is the phone's
 * only signal that a token went stale.
 * A 401 from self-claim itself means the Clerk JWT was stale: we retry once with
 * a freshly-minted token before giving up.
 */
export async function ensureClaim(
  getToken: () => Promise<string | null>,
  force: boolean,
): Promise<DeviceClaim> {
  if (!force) {
    const cached = readCache();
    if (cached) return cached;
  } else {
    clearCachedClaim();
  }

  const jwt = await getToken();
  if (!jwt) throw new ClaimError("not signed in", 401);

  try {
    const claim = await selfClaim(jwt);
    writeCache(claim);
    return claim;
  } catch (err) {
    if (err instanceof ClaimError && err.status === 401) {
      const fresh = await getToken();
      if (fresh && fresh !== jwt) {
        const claim = await selfClaim(fresh);
        writeCache(claim);
        return claim;
      }
    }
    throw err;
  }
}
