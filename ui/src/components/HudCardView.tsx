"use client";

// Faithful-ish preview of what the 600x600 monocular lens shows (DESIGN.md §4.2):
// title + subtitle + max 5 lines (~40 chars) + footer. Never wraps-scrolls — the
// renderer contract is enforced by Cortex at generation time, so if something
// overflows here it is a contract violation worth seeing.
// Deliberately stays dark inside a bezel: this is a device screen, not page UI.

import type { HudCard } from "@wingman/shared";

const KIND_TONE: Record<HudCard["kind"], string> = {
  ack: "text-zinc-400",
  company: "text-teal-300",
  pitch: "text-sky-300",
  scan: "text-violet-300",
  hint: "text-amber-300",
  error: "text-red-300",
};

export function HudCardView({ card, compact = false }: { card: HudCard; compact?: boolean }) {
  return (
    <div
      className={`w-full max-w-[320px] rounded-[26px] bg-[#1b2026] p-2.5 shadow-[var(--shadow-2)] ${
        compact ? "max-w-[230px] p-2" : ""
      }`}
    >
      <div className={`aspect-square w-full rounded-[18px] bg-black p-4 font-mono ${compact ? "p-3" : ""}`}>
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-2">
            <div className={`truncate text-base font-semibold ${KIND_TONE[card.kind]}`}>
              {card.title}
            </div>
            {card.streaming ? (
              <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-teal-300" />
            ) : null}
          </div>
          {card.subtitle ? (
            <div className="mt-1 line-clamp-2 text-[11px] text-zinc-400">{card.subtitle}</div>
          ) : null}
          <ul className="mt-3 flex-1 space-y-1.5 overflow-hidden text-[11px] leading-snug text-zinc-200">
            {(card.lines ?? []).slice(0, 5).map((line, i) => (
              <li key={i} className="truncate">
                <span className="text-zinc-600">·</span> {line}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-600">
            <span className="truncate">{card.footer ?? "Wingman"}</span>
            {card.page ? (
              <span className="shrink-0">
                {card.page.index}/{card.page.count}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
