"use client";

// INTEGRATION: capture/useDeviceLink
// IN:  CortexToDeviceMsg JSON text frames on wss://<NEXT_PUBLIC_CORTEX_WS_URL>/ws/device?token=<deviceToken>
// OUT: DeviceToCortexMsg (hello, session_start, frame, photo, photo_error, status, session_stop);
//      exposes armed state + server-authoritative ArmedConfig to the page
// WIRE: page.tsx calls useDeviceLink({ onRender, onCapturePhoto }) once; everything else
//       (claim, reconnect/backoff, hello + session_start resend, clean session_stop) lives here.
//
// This is the console-side twin of glassbridge/Wingman/CortexSocket.swift — same protocol,
// same reconnect contract (DESIGN.md §4.2, §5.1 responsibility 2).

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ArmedConfig,
  CapturePhotoMsg,
  CortexToDeviceMsg,
  DeviceToCortexMsg,
  ErrorMsg,
  HudCard,
  SessionEndReason,
} from "@wingman/shared";
import { deviceConfig } from "@wingman/shared";
import type { DeviceClaim } from "./claim";
import { ClaimError, ensureClaim } from "./claim";
import { deviceWsUrl, envReady } from "./env";

export type ConnStatus =
  | "idle"
  | "claiming"
  | "connecting"
  | "online"
  | "reconnecting"
  | "ended"
  | "blocked";

export interface DeviceLinkState {
  status: ConnStatus;
  /** true once Cortex has sent `armed` (or the local arm fallback fired). */
  armed: boolean;
  /** ArmedMsg.config when present, else the compiled Appendix D defaults. */
  config: ArmedConfig;
  configSource: "server" | "default";
  sessionId: string | null;
  endReason: SessionEndReason | null;
  lastError: ErrorMsg | null;
  /** Non-protocol local failure (claim/env/websocket), shown in the status chip. */
  localError: string | null;
  deviceId: string | null;
  attempt: number;
}

export interface UseDeviceLinkOptions {
  enabled: boolean;
  getToken: () => Promise<string | null>;
  onRender: (card: HudCard) => void;
  onCapturePhoto: (msg: CapturePhotoMsg) => void;
}

export interface DeviceLink {
  state: DeviceLinkState;
  /** Returns false when the socket is not open (caller should just drop the frame). */
  send: (msg: DeviceToCortexMsg) => boolean;
  /** Re-run the whole claim → connect → session_start sequence (used after session_end). */
  restart: () => void;
}

const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;
/** If Cortex never sends `armed`, arm locally on Appendix D defaults rather than stall the demo. */
const LOCAL_ARM_FALLBACK_MS = 6000;

/** Close codes we read as "this deviceToken is no longer valid" → force a re-claim. */
const AUTH_CLOSE_CODES = new Set<number>([1008, 4401, 4403, 4001]);

function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS) + Math.random() * 250;
}

/** Lenient decode (merge contract §0.4): unknown shapes are ignored, never thrown on. */
function decode(raw: unknown): CortexToDeviceMsg | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const t = (parsed as { type?: unknown }).type;
  if (t === "armed" || t === "capture_photo" || t === "render" || t === "session_end" || t === "error") {
    return parsed as CortexToDeviceMsg;
  }
  return null;
}

export function useDeviceLink(opts: UseDeviceLinkOptions): DeviceLink {
  const { enabled } = opts;

  const [state, setState] = useState<DeviceLinkState>(() => ({
    status: "idle",
    armed: false,
    config: deviceConfig(),
    configSource: "default",
    sessionId: null,
    endReason: null,
    lastError: null,
    localError: null,
    deviceId: null,
    attempt: 0,
  }));

  // Callbacks live in refs so re-renders never tear down the socket.
  const cbRef = useRef(opts);
  cbRef.current = opts;

  const wsRef = useRef<WebSocket | null>(null);
  const forceReclaimRef = useRef(false);
  const [nonce, setNonce] = useState(0);

  const send = useCallback((msg: DeviceToCortexMsg): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }, []);

  const restart = useCallback(() => {
    setState((s) => ({ ...s, status: "idle", armed: false, endReason: null, localError: null }));
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    if (!envReady()) {
      setState((s) => ({
        ...s,
        status: "blocked",
        localError: "NEXT_PUBLIC_CORTEX_URL / NEXT_PUBLIC_CORTEX_WS_URL are not set",
      }));
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let armTimer: ReturnType<typeof setTimeout> | undefined;
    let everConnected = false;

    const clearTimers = (): void => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (armTimer !== undefined) clearTimeout(armTimer);
      retryTimer = undefined;
      armTimer = undefined;
    };

    const scheduleRetry = (): void => {
      if (cancelled) return;
      const delay = backoffMs(attempt);
      attempt += 1;
      setState((s) => ({ ...s, status: "reconnecting", armed: false, attempt }));
      retryTimer = setTimeout(() => {
        void connect();
      }, delay);
    };

    const connect = async (): Promise<void> => {
      if (cancelled) return;
      setState((s) => ({ ...s, status: attempt === 0 ? "claiming" : "reconnecting" }));

      let claim: DeviceClaim;
      try {
        claim = await ensureClaim(cbRef.current.getToken, forceReclaimRef.current);
        forceReclaimRef.current = false;
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof ClaimError
            ? `device claim failed: ${err.message}`
            : `device claim failed: ${String(err)}`;
        setState((s) => ({ ...s, localError: msg }));
        scheduleRetry();
        return;
      }
      if (cancelled) return;

      setState((s) => ({ ...s, status: "connecting", deviceId: claim.deviceId }));

      let ws: WebSocket;
      try {
        ws = new WebSocket(deviceWsUrl(claim.deviceToken));
      } catch (err) {
        setState((s) => ({ ...s, localError: `websocket open failed: ${String(err)}` }));
        scheduleRetry();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) {
          ws.close(1000, "cancelled");
          return;
        }
        attempt = 0;
        setState((s) => ({ ...s, status: "online", localError: null, attempt: 0 }));

        // Every (re)connect resends hello + session_start — Cortex treats the socket
        // as the session's lifeline, so a reconnect must re-announce both.
        send({ type: "hello", deviceType: "phone_web", caps: { video: true, photoHiRes: true } });
        send({ type: "session_start" });
        if (everConnected) send({ type: "status", note: "reconnected" });
        everConnected = true;

        // Optional battery telemetry (DESIGN.md §4.2 status message). Best effort only.
        void reportBattery(send);

        if (armTimer !== undefined) clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          setState((s) => (s.armed ? s : { ...s, armed: true, configSource: "default" }));
        }, LOCAL_ARM_FALLBACK_MS);
      };

      ws.onmessage = (ev: MessageEvent) => {
        const msg = decode(ev.data);
        if (!msg) return;
        switch (msg.type) {
          case "armed": {
            if (armTimer !== undefined) clearTimeout(armTimer);
            setState((s) => ({
              ...s,
              armed: true,
              sessionId: msg.sessionId,
              endReason: null,
              // config is OPTIONAL and server-authoritative (DESIGN.md §4.2):
              // apply it when present, else keep the compiled Appendix D defaults.
              config: msg.config ?? deviceConfig(),
              configSource: msg.config ? "server" : "default",
            }));
            break;
          }
          case "render":
            cbRef.current.onRender(msg.card);
            break;
          case "capture_photo":
            cbRef.current.onCapturePhoto(msg);
            break;
          case "session_end":
            setState((s) => ({ ...s, status: "ended", armed: false, endReason: msg.reason }));
            cancelled = true;
            clearTimers();
            try {
              ws.close(1000, "session_end");
            } catch {
              /* ignore */
            }
            break;
          case "error":
            setState((s) => ({ ...s, lastError: msg }));
            break;
        }
      };

      ws.onerror = () => {
        // onclose always follows; reconnect logic lives there.
      };

      ws.onclose = (ev: CloseEvent) => {
        if (wsRef.current === ws) wsRef.current = null;
        if (armTimer !== undefined) clearTimeout(armTimer);
        if (cancelled) return;
        if (AUTH_CLOSE_CODES.has(ev.code)) {
          // Cortex rejected the cached deviceToken — mint a new one via self-claim.
          forceReclaimRef.current = true;
          setState((s) => ({ ...s, localError: "device token rejected — re-claiming" }));
        }
        setState((s) => ({ ...s, armed: false }));
        scheduleRetry();
      };
    };

    void connect();

    // Clean stop: session_stop then a normal close (DESIGN.md §5.2 phone mode).
    const stop = (): void => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "session_stop" } satisfies DeviceToCortexMsg));
        } catch {
          /* ignore */
        }
      }
    };
    const onPageHide = (): void => stop();
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      clearTimers();
      window.removeEventListener("pagehide", onPageHide);
      stop();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close(1000, "unmount");
        } catch {
          /* ignore */
        }
      }
    };
  }, [enabled, nonce, send]);

  return { state, send, restart };
}

interface BatteryLike {
  level: number;
}

async function reportBattery(send: (msg: DeviceToCortexMsg) => boolean): Promise<void> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
  if (typeof nav.getBattery !== "function") return;
  try {
    const b = await nav.getBattery();
    if (typeof b.level === "number") send({ type: "status", battery: b.level });
  } catch {
    /* battery API is optional */
  }
}
