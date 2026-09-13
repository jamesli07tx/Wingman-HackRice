"use client";

// INTEGRATION: capture/StatusChip
// IN:  ConnStatus + armed flag + last ErrorMsg (DESIGN.md §4.2 error codes)
// OUT: DOM only — the single status affordance on an otherwise button-free page (D3)
// WIRE: page.tsx renders it top-left over the camera preview.

import type { ErrorCode, ErrorMsg } from "@wingman/shared";
import type { ConnStatus } from "../lib/useDeviceLink";

const DOT: Record<ConnStatus, string> = {
  idle: "#9aa6b2",
  claiming: "#f5c451",
  connecting: "#f5c451",
  online: "#6ee7a8",
  reconnecting: "#f5a451",
  ended: "#9aa6b2",
  blocked: "#ff7a7a",
};

const LABEL: Record<ConnStatus, string> = {
  idle: "idle",
  claiming: "claiming device",
  connecting: "connecting",
  online: "connected",
  reconnecting: "reconnecting",
  ended: "session ended",
  blocked: "not configured",
};

/** DESIGN.md §4.2 — closed enum, rendered in plain words for the operator. */
const ERROR_LABEL: Record<ErrorCode, string> = {
  gate_down: "Frame gate unavailable",
  identify_timeout: "Identification timed out",
  no_match: "No company matched",
  search_down: "Live search unavailable",
  llm_down: "Model unavailable",
  rate_limited: "Rate limited",
  photo_failed: "Photo capture failed",
};

export interface StatusChipProps {
  status: ConnStatus;
  armed: boolean;
  configSource: "server" | "default";
  cameraNote: string | null;
  localError: string | null;
  lastError: ErrorMsg | null;
  framesSent: number;
}

export function StatusChip(props: StatusChipProps) {
  const { status, armed, configSource, cameraNote, localError, lastError, framesSent } = props;
  const detail = armed ? `armed · ${framesSent} frames` : LABEL[status];

  return (
    <div
      style={{
        position: "absolute",
        top: "calc(env(safe-area-inset-top, 0px) + 10px)",
        left: 10,
        right: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        alignItems: "flex-start",
        pointerEvents: "none",
        zIndex: 20,
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 11px",
          borderRadius: 999,
          background: "rgba(11,14,19,0.66)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          border: "1px solid rgba(255,255,255,0.1)",
          color: "#e6ebf1",
          fontSize: 12,
          lineHeight: 1,
          maxWidth: "100%",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: DOT[status],
            boxShadow: `0 0 8px ${DOT[status]}`,
            animation:
              status === "connecting" || status === "claiming" || status === "reconnecting"
                ? "wm-pulse 1.1s ease-in-out infinite"
                : undefined,
            flex: "0 0 auto",
          }}
        />
        <span style={{ fontWeight: 600 }}>Wingman</span>
        <span style={{ color: "#9aa6b2" }}>{detail}</span>
        {armed && configSource === "server" ? (
          <span style={{ color: "#5ad1ff", fontSize: 10.5 }}>cfg</span>
        ) : null}
      </div>

      {cameraNote ? <Notice tone="warn" text={cameraNote} /> : null}
      {localError ? <Notice tone="warn" text={localError} /> : null}
      {lastError ? (
        <Notice
          tone={lastError.recoverable ? "warn" : "bad"}
          text={`${ERROR_LABEL[lastError.code] ?? lastError.code}: ${lastError.message}`}
        />
      ) : null}
    </div>
  );
}

function Notice({ tone, text }: { tone: "warn" | "bad"; text: string }) {
  const color = tone === "bad" ? "#ff7a7a" : "#f5c451";
  return (
    <div
      style={{
        padding: "5px 10px",
        borderRadius: 10,
        background: "rgba(11,14,19,0.7)",
        border: `1px solid ${color}55`,
        color,
        fontSize: 11.5,
        lineHeight: 1.35,
        maxWidth: "100%",
        overflowWrap: "anywhere",
      }}
    >
      {text}
    </div>
  );
}
