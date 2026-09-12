"use client";

// INTEGRATION: capture/ArBubble
// IN:  the HudCard currently presented + a BubbleAnchor in container CSS px
// OUT: DOM only — the floating AR-style bubble over the camera preview
// WIRE: page.tsx renders <ArBubble card={presenter.card} anchor={anchor} .../> inside the
//       overlay container whose ref is handed to useFaceAnchor.
//
// It renders the SAME HudCard JSON the glasses render (DESIGN.md §4.2) — the phone is a
// device adapter, not a second product. Unthrottled here (the >=500 ms coalescing rule is
// a DAT full-screen-replace constraint, not a protocol rule).

import { useEffect, useRef, useState } from "react";
import type { HudCard } from "@wingman/shared";
import type { BubbleAnchor } from "../lib/useFaceAnchor";
import { MAX_LINES, kindTheme, pageMarker } from "./CardTheme";

const GAP = 14;
const EDGE = 12;

export interface ArBubbleProps {
  card: HudCard;
  anchor: BubbleAnchor;
  containerWidth: number;
  containerHeight: number;
}

export function ArBubble({ card, anchor, containerWidth, containerHeight }: ArBubbleProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (): void => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [card.cardId, card.seq]);

  const maxWidth = Math.min(360, Math.max(220, containerWidth - EDGE * 2));

  // Prefer above the anchor (above the nearest face); flip below when there is no room;
  // clamp to the viewport so the bubble is never half off-screen.
  let top = anchor.aboveY - GAP - size.h;
  let tail: "down" | "up" = "down";
  if (top < EDGE) {
    top = anchor.belowY + GAP;
    tail = "up";
  }
  if (size.h > 0 && top + size.h > containerHeight - EDGE) {
    top = Math.max(EDGE, containerHeight - EDGE - size.h);
  }

  const halfW = (size.w || maxWidth) / 2;
  const left = Math.min(Math.max(anchor.cx, EDGE + halfW), Math.max(EDGE + halfW, containerWidth - EDGE - halfW));

  const theme = kindTheme(card.kind);
  const lines = (card.lines ?? []).slice(0, MAX_LINES);
  const marker = pageMarker(card.page);

  return (
    <div
      ref={ref}
      data-card-id={card.cardId}
      style={{
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        transform: "translateX(-50%)",
        width: `${maxWidth}px`,
        maxWidth: `calc(100% - ${EDGE * 2}px)`,
        boxSizing: "border-box",
        padding: "14px 16px 12px",
        borderRadius: 18,
        border: `1px solid ${theme.accent}55`,
        borderLeft: `3px solid ${theme.accent}`,
        background: "rgba(11,14,19,0.78)",
        backdropFilter: "blur(14px) saturate(1.2)",
        WebkitBackdropFilter: "blur(14px) saturate(1.2)",
        boxShadow: "0 18px 44px rgba(0,0,0,0.5)",
        color: "#f2f5f8",
        pointerEvents: "none",
        transition: "top 260ms cubic-bezier(.22,.61,.36,1), left 260ms cubic-bezier(.22,.61,.36,1)",
        willChange: "top, left",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            fontSize: 17,
            fontWeight: 650,
            letterSpacing: "-0.01em",
            lineHeight: 1.2,
            flex: 1,
            minWidth: 0,
            overflowWrap: "anywhere",
          }}
        >
          {card.title}
        </span>
        {card.streaming ? (
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: theme.accent,
              animation: "wm-pulse 1.1s ease-in-out infinite",
              flex: "0 0 auto",
            }}
          />
        ) : null}
        {marker ? (
          <span
            style={{
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
              color: theme.accent,
              border: `1px solid ${theme.accent}66`,
              borderRadius: 999,
              padding: "1px 7px",
              flex: "0 0 auto",
            }}
          >
            {marker}
          </span>
        ) : null}
      </div>

      {card.subtitle ? (
        <div style={{ marginTop: 3, fontSize: 12.5, color: "#a9b4c0", lineHeight: 1.35 }}>
          {card.subtitle}
        </div>
      ) : null}

      {lines.length > 0 ? (
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
          {lines.map((line, i) => (
            <li
              key={`${card.cardId}-${i}`}
              style={{
                display: "flex",
                gap: 8,
                fontSize: 13,
                lineHeight: 1.4,
                marginTop: i === 0 ? 0 : 5,
                color: "#e6ebf1",
              }}
            >
              <span style={{ color: theme.accent, flex: "0 0 auto" }}>·</span>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {card.footer ? (
        <div
          style={{
            marginTop: 10,
            paddingTop: 8,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            fontSize: 10.5,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "#7d8894",
          }}
        >
          {card.footer}
        </div>
      ) : null}

      {/* tail pointing at the anchored face */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          bottom: tail === "down" ? -6 : undefined,
          top: tail === "up" ? -6 : undefined,
          marginLeft: -6,
          width: 12,
          height: 12,
          background: "rgba(11,14,19,0.78)",
          borderRight: tail === "down" ? `1px solid ${theme.accent}55` : undefined,
          borderBottom: tail === "down" ? `1px solid ${theme.accent}55` : undefined,
          borderLeft: tail === "up" ? `1px solid ${theme.accent}55` : undefined,
          borderTop: tail === "up" ? `1px solid ${theme.accent}55` : undefined,
          transform: "rotate(45deg)",
        }}
      />
    </div>
  );
}
