"use client";

// One row per DashboardEvent (DESIGN.md §4.3). Three things matter to the operator:
//   render            — what the lens is actually showing
//   gate              — per-frame class telemetry (banner|document|nothing)
//   silenced_identify — a sub-threshold ID the lens deliberately hid (D13). This is
//                       the cue to reach for the override picker.

import type { DashboardEvent } from "@wingman/shared";
import { CONF_THRESHOLD } from "@wingman/shared";
import { Chip } from "@/components/ui";
import type { FeedEntry } from "@/lib/dashboardSocket";

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}

const GATE_TONE = {
  banner: "accent",
  document: "warn",
  nothing: "neutral",
} as const;

function Body({ event }: { event: DashboardEvent }) {
  switch (event.type) {
    case "render": {
      const c = event.card;
      return (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone="accent">render · {c.kind}</Chip>
            {c.page ? (
              <Chip>
                page {c.page.index}/{c.page.count}
              </Chip>
            ) : null}
            {c.streaming ? <Chip tone="warn">streaming</Chip> : null}
            {c.company ? (
              <Chip tone={c.company.confidence >= CONF_THRESHOLD ? "good" : "warn"}>
                {c.company.companyId} · {c.company.confidence.toFixed(2)}
              </Chip>
            ) : null}
            <span className="text-[11px] text-zinc-600">
              seq {c.seq} · {c.cardId}
            </span>
          </div>
          <div className="mt-1 truncate text-sm text-zinc-100">{c.title}</div>
          {c.subtitle ? (
            <div className="truncate text-xs text-zinc-500">{c.subtitle}</div>
          ) : null}
          {c.lines?.length ? (
            <ul className="mt-1 space-y-0.5 text-xs text-zinc-400">
              {c.lines.slice(0, 5).map((l, i) => (
                <li key={i} className="truncate">
                  · {l}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    }
    case "gate":
      return (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip tone={GATE_TONE[event.class]}>gate · {event.class}</Chip>
          <span className="text-[11px] text-zinc-600">frame {event.frameSeq}</span>
          {event.orgHint ? (
            <span className="truncate text-xs text-zinc-400">hint: {event.orgHint}</span>
          ) : null}
        </div>
      );
    case "silenced_identify":
      return (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone="bad">silenced</Chip>
            <span className="text-xs text-amber-200">
              {event.nameGuess ?? "unknown"} · {event.confidence.toFixed(2)} &lt;{" "}
              {CONF_THRESHOLD}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            Below threshold — nothing rendered on the lens. Override if this is right.
          </div>
        </div>
      );
    case "status":
      return (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip>status</Chip>
          {typeof event.battery === "number" ? (
            <Chip tone={event.battery < 0.2 ? "bad" : "neutral"}>
              battery {Math.round(event.battery * 100)}%
            </Chip>
          ) : null}
          {event.note ? (
            <span className="truncate text-xs text-zinc-400">{event.note}</span>
          ) : null}
        </div>
      );
    case "session":
      return (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip tone={event.state === "started" ? "good" : "neutral"}>
            session {event.state}
          </Chip>
          {event.reason ? (
            <span className="text-xs text-zinc-500">{event.reason}</span>
          ) : null}
        </div>
      );
    default:
      return (
        <pre className="min-w-0 overflow-x-auto text-[11px] text-zinc-500">
          {JSON.stringify(event)}
        </pre>
      );
  }
}

export function EventRow({ entry }: { entry: FeedEntry }) {
  const sessionId =
    typeof entry.event === "object" && entry.event && "sessionId" in entry.event
      ? String((entry.event as { sessionId?: string }).sessionId ?? "")
      : "";
  return (
    <li className="flex gap-3 border-b border-[var(--color-edge)]/60 px-3 py-2 last:border-b-0">
      <div className="w-14 shrink-0 pt-0.5 font-mono text-[11px] text-zinc-600">
        {clock(entry.at)}
      </div>
      <div className="min-w-0 flex-1">
        <Body event={entry.event} />
        {sessionId ? (
          <div className="mt-0.5 font-mono text-[10px] text-zinc-700">{sessionId}</div>
        ) : null}
      </div>
    </li>
  );
}
