// REST client for cortex/src/fairs/routes.ts. Deliberately its own file: the
// shared client in @/lib/api is untouched (UI redesign in flight), but it reuses
// that file's CortexError so error states render the same way everywhere.

import { CortexError } from "@/lib/api";
import { CORTEX_URL } from "@/lib/env";
import type { FairCompanyOnFile, FairImport } from "./types";

/** The link could not be used (dead, gated, or no list on it): the page disables
 *  the link field for the rest of the visit and asks for an image. */
export class LinkFailedError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LinkFailedError";
  }
}

type TokenGetter = () => Promise<string | null>;

interface CallOptions {
  method?: "GET" | "POST";
  json?: unknown;
  body?: BodyInit;
  signal?: AbortSignal;
}

async function call<T>(path: string, getToken: TokenGetter, opts: CallOptions = {}): Promise<T> {
  if (!CORTEX_URL) throw new CortexError("NEXT_PUBLIC_CORTEX_URL is not set", 0, true);

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

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const p = (parsed ?? {}) as { error?: string; reason?: string; message?: string };
    if (p.error === "link_failed") {
      throw new LinkFailedError(p.reason ?? "unknown", p.message ?? "That link did not work");
    }
    throw new CortexError(p.message ?? (text.slice(0, 200) || `Cortex responded ${res.status}`), res.status);
  }
  return parsed as T;
}

export function importFromLink(getToken: TokenGetter, body: { url: string; fairName?: string }) {
  return call<{ import: FairImport }>("/api/fairs/imports/link", getToken, { method: "POST", json: body });
}

export function importFromImage(getToken: TokenGetter, file: File, fairName?: string) {
  const form = new FormData();
  // Text fields must precede the file part: cortex reads them off the file stream.
  if (fairName) form.append("fairName", fairName);
  form.append("file", file, file.name);
  return call<{ import: FairImport }>("/api/fairs/imports/image", getToken, { method: "POST", body: form });
}

export function getImport(getToken: TokenGetter, importId: string, signal?: AbortSignal) {
  return call<{ import: FairImport }>(`/api/fairs/imports/${encodeURIComponent(importId)}`, getToken, {
    signal,
  });
}

export function listImports(getToken: TokenGetter, signal?: AbortSignal) {
  return call<{ imports: FairImport[] }>("/api/fairs/imports", getToken, { signal });
}

export function listCompaniesOnFile(getToken: TokenGetter, signal?: AbortSignal) {
  return call<{ companies: FairCompanyOnFile[] }>("/api/fairs/companies", getToken, { signal });
}
