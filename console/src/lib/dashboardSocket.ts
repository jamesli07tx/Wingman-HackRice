"use client";

// INTEGRATION: Dashboard WebSocket consumer
// IN:  a Clerk session JWT (useCortexAuth().getToken()) + NEXT_PUBLIC_CORTEX_WS_URL
// OUT: a live stream of DashboardEvent (@wingman/shared) for /feed
// WIRE: useDashboardSocket() is called once, by FeedClient
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: the human debugging GlassBridge on the Mac — this feed is their window
//   into what Cortex thinks the glasses are seeing (render/status/gate/silenced_identify).
// CONTRACT: DESIGN.md §4.3 — wss://…/ws/dashboard?token=<Clerk JWT>, read-only mirror
//   of every render/status event plus gate telemetry.
// AT-INTEGRATION: none — observability window. Nothing to wire, nothing to fill in;
//   it starts showing glasses traffic the moment GlassBridge connects.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardEvent } from "@wingman/shared";
import { CORTEX_WS_URL } from "./env";
import { useCortexAuth } from "./auth";

export type ConnState = "idle" | "connecting" | "open" | "closed" | "unconfigured";

export interface FeedEntry {
  /** monotonic local id — the wire has no event id */
  id: number;
  at: number;
  event: DashboardEvent;
}

const MAX_ENTRIES = 400;

export function useDashboardSocket(enabled = true) {
  const { getToken } = useCortexAuth();
  const [state, setState] = useState<ConnState>("idle");
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);
  const idRef = useRef(0);
  // Held in a ref so a Clerk re-render (user loads, token refreshes) never tears
  // down a healthy socket.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const clear = useCallback(() => setEntries([]), []);

  useEffect(() => {
    aliveRef.current = true;
    if (!enabled) return;
    if (!CORTEX_WS_URL) {
      setState("unconfigured");
      return;
    }

    const connect = async () => {
      if (!aliveRef.current) return;
      setState("connecting");
      setError(null);
      let token: string | null = null;
      try {
        token = await getTokenRef.current();
      } catch {
        token = null;
      }
      if (!aliveRef.current) return;

      const url = `${CORTEX_WS_URL}/ws/dashboard${
        token ? `?token=${encodeURIComponent(token)}` : ""
      }`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        setState("closed");
        setError("Could not open the dashboard socket.");
        scheduleRetry();
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        setState("open");
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return; // §4 protocol is 100% JSON text frames
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        // Lenient decoding (merge contract §0.4): keep anything with a type, ignore
        // unknown fields; unknown event types are still shown as raw rows.
        if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
        const event = parsed as DashboardEvent;
        setEntries((prev) => {
          const next = prev.concat({ id: idRef.current++, at: Date.now(), event });
          return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
        });
      };

      ws.onerror = () => {
        setError("Cortex dashboard socket errored — is the backend deployed?");
      };

      ws.onclose = () => {
        socketRef.current = null;
        if (!aliveRef.current) return;
        setState("closed");
        scheduleRetry();
      };
    };

    const scheduleRetry = () => {
      if (!aliveRef.current) return;
      const attempt = Math.min(retryRef.current++, 5);
      const delay = Math.min(1000 * 2 ** attempt, 15000);
      timerRef.current = window.setTimeout(() => void connect(), delay);
    };

    void connect();

    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [enabled]);

  return { state, entries, error, clear };
}
