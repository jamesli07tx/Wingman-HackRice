// INTEGRATION: Console REST client
// IN:  a Clerk session JWT (from useCortexAuth().getToken()) + typed request bodies
//      from @wingman/shared
// OUT: fetch calls to Cortex per DESIGN.md §4.1, all with Authorization: Bearer <JWT>
// WIRE: every console page calls these helpers; nothing else in the app calls fetch()
//
// Cortex may not be deployed yet — every call either resolves with typed data or
// throws CortexError, whose `unreachable` flag drives a calm "backend offline"
// state in the UI instead of a crash. No call runs at build time (all callers are
// client components under force-dynamic routes).

import type {
  CompanySearchItem,
  DeviceInfo,
  LinkCodeResponse,
  OverrideRequest,
  ProfileLinks,
  ProfileSummary,
  SessionStartRequest,
  SessionStartResponse,
  SessionStopRequest,
} from "@wingman/shared";
import { CORTEX_URL } from "./env";

export class CortexError extends Error {
  readonly status: number;
  /** true = never reached Cortex (offline, DNS, CORS, or URL not configured) */
  readonly unreachable: boolean;

  constructor(message: string, status: number, unreachable = false) {
    super(message);
    this.name = "CortexError";
    this.status = status;
    this.unreachable = unreachable;
  }
}

export type TokenGetter = () => Promise<string | null>;

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  json?: unknown;
  body?: BodyInit;
  signal?: AbortSignal;
}

async function request<T>(
  path: string,
  getToken: TokenGetter,
  opts: RequestOptions = {},
): Promise<T> {
  if (!CORTEX_URL) {
    throw new CortexError("NEXT_PUBLIC_CORTEX_URL is not set", 0, true);
  }

  const headers: Record<string, string> = {};
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }

  let res: Response;
  try {
    res = await fetch(`${CORTEX_URL}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: opts.signal,
      cache: "no-store",
    });
  } catch {
    throw new CortexError("Cortex is unreachable", 0, true);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new CortexError(
      detail.slice(0, 200) || `Cortex responded ${res.status}`,
      res.status,
    );
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

// --- DESIGN.md §4.1 ---------------------------------------------------------

export function getProfile(getToken: TokenGetter, signal?: AbortSignal) {
  return request<{ profile: ProfileSummary | null; links: ProfileLinks }>(
    "/api/profile",
    getToken,
    { signal },
  );
}

/** multipart PDF → parsed ProfileSummary (resume parse happens server-side at upload). */
export function uploadResume(getToken: TokenGetter, file: File) {
  const form = new FormData();
  form.append("file", file, file.name);
  return request<{ profile: ProfileSummary }>("/api/profile/resume", getToken, {
    method: "POST",
    body: form,
  });
}

export function putProfileLinks(getToken: TokenGetter, links: ProfileLinks) {
  return request<void>("/api/profile/links", getToken, { method: "PUT", json: links });
}

export function listDevices(getToken: TokenGetter, signal?: AbortSignal) {
  return request<DeviceInfo[]>("/api/devices", getToken, { signal });
}

// INTEGRATION(X-MACHINE):
// COUNTERPART: glassbridge/Wingman/StatusView.swift — the link screen where the wearer
//   types this 6-digit code, which GlassBridge then POSTs to /api/devices/claim.
// CONTRACT: DESIGN.md §4.1 — POST /api/devices/link-code → { code, expiresAt }
// AT-INTEGRATION: run the code→claim flow once; confirm the phone appears in GET /api/devices.
export function createLinkCode(getToken: TokenGetter) {
  return request<LinkCodeResponse>("/api/devices/link-code", getToken, { method: "POST" });
}

export function startSession(getToken: TokenGetter, body: SessionStartRequest) {
  return request<SessionStartResponse>("/api/session/start", getToken, {
    method: "POST",
    json: body,
  });
}

export function stopSession(getToken: TokenGetter, body: SessionStopRequest) {
  return request<void>("/api/session/stop", getToken, { method: "POST", json: body });
}

/** Demo safety (D3/D13): force a company, bypassing gate, cooldown and confidence. */
export function overrideCompany(getToken: TokenGetter, body: OverrideRequest) {
  return request<void>("/api/session/override", getToken, { method: "POST", json: body });
}

export function searchCompanies(getToken: TokenGetter, q: string, signal?: AbortSignal) {
  return request<CompanySearchItem[]>(
    `/api/companies?q=${encodeURIComponent(q)}`,
    getToken,
    { signal },
  );
}

export function describeError(err: unknown): string {
  if (err instanceof CortexError) {
    if (err.unreachable) {
      return CORTEX_URL
        ? "Cortex is unreachable — is the backend deployed?"
        : "Cortex URL is not configured (NEXT_PUBLIC_CORTEX_URL).";
    }
    if (err.status === 401 || err.status === 403) return "Not authorized — sign in again.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
