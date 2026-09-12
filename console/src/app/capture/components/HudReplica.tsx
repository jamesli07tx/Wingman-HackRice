"use client";

// INTEGRATION: capture/HudReplica
// IN:  the same HudCard the AR bubble draws
// OUT: DOM only — a faithful 600x600 monocular-lens replica (dev toggle)
// WIRE: page.tsx swaps <ArBubble/> for <HudReplica/> when the corner dev toggle is on.
//
// Purpose: check card typography against the GLASSES renderer contract (DESIGN.md §4.2)
// without the hardware — title + subtitle + max 5 lines (~40 chars) + footer, drawn into a
// 600x600 dark square, no wrap-scrolling, whole screen replaced on every render.
// Layout is authored at exactly 600x600 and uniformly scaled to fit the phone, so what you
// see here is geometrically what the lens shows.

import { useEffect, useRef, useState } from "react";
import type { HudCard } from "@wingman/shared";
import { MAX_LINES, kindTheme, pageMarker } from "./CardTheme";

const LENS = 600;

export interface HudReplicaProps {
  card: HudCard | null;
  /** shown inside the square when no card is on the lens */
  idleNote: string;
}

export function HudReplica({ card, idleNote }: HudReplicaProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = (): void => {
      const r = el.getBoundingClientRect();
      const avail = Math.min(r.width, window.innerHeight - 140);
      setScale(Math.max(0.25, Math.min(1, avail / LENS)));
    };
    update();
    window.addEventListener("resize", update);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => {
        ro.disconnect();
        window.removeEventListener("resize", update);
      };
    }
    return () => window.removeEventListener("resize", update);
  }, []);

  const theme = card ? kindTheme(card.kind) : { accent: "#9aa6b2", label: "Idle" };
  const lines = (card?.lines ?? []).slice(0, MAX_LINES);
  const marker = pageMarker(card?.page);

  return (
    <div
      ref={wrapRef}
      style={{
        width: "100%",
        height: `${LENS * scale}px`,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: LENS,
          height: LENS,
          transform: `scale(${scale})`,
          transformOrigin: "top center",
          flex: "0 0 auto",
          boxSizing: "border-box",
          background: "#000",
          border: "1px solid #1c2128",
          borderRadius: 8,
          padding: 36,
          display: "flex",
          flexDirection: "column",
          color: "#ffffff",
          fontFamily:
            'ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif',
          overflow: "hidden",
        }}
      >
        {!card ? (
          <div
            style={{
              margin: "auto",
              color: "#6b7682",
              fontSize: 26,
              textAlign: "center",
              padding: "0 40px",
            }}
          >
            {idleNote}
          </div>
        ) : (
          <>
            <div
              style={{
                fontSize: 46,
                fontWeight: 700,
                lineHeight: 1.1,
                letterSpacing: "-0.02em",
                color: theme.accent,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {card.title}
            </div>
            {card.subtitle ? (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 24,
                  lineHeight: 1.25,
                  color: "#b9c3cd",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {card.subtitle}
              </div>
            ) : null}

            <div style={{ marginTop: 26, flex: 1, minHeight: 0 }}>
              {lines.map((line, i) => (
                <div
                  key={`${card.cardId}-${i}`}
                  style={{
                    display: "flex",
                    gap: 14,
                    fontSize: 26,
                    lineHeight: 1.25,
                    marginTop: i === 0 ? 0 : 16,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                  }}
                >
                  <span style={{ color: theme.accent, flex: "0 0 auto" }}>•</span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {line}
                  </span>
                </div>
              ))}
            </div>

            <div
              style={{
                marginTop: 20,
                paddingTop: 16,
                borderTop: "1px solid #23292f",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 20,
                color: "#7d8894",
              }}
            >
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {card.footer ?? "Wingman"}
              </span>
              {marker ? (
                <span style={{ color: theme.accent, fontVariantNumeric: "tabular-nums" }}>
                  {marker}
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
