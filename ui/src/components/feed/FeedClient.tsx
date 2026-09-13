"use client";

// Mission control (DESIGN.md §4.3): put this on the judges' screen while the wearer
// walks the booth. Demo view = lens preview + identification moments only; the raw
// firehose (gate telemetry, seq/ids, gate_debug) lives behind the Details segment.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HudCard } from "@wingman/shared";
import { FRAME_INTERVAL_MS } from "@wingman/shared";
import { HudCardView } from "@/components/HudCardView";
import { EventRow } from "@/components/feed/EventRow";
import { OverridePicker } from "@/components/feed/OverridePicker";
import {
  Button,
  Chip,
  Notice,
  SegmentedControl,
  Section,
  useCountUp,
} from "@/components/ui";
import { useDashboardSocket, type FeedEntry } from "@/lib/dashboardSocket";

type Filter = "all" | "cards" | "gate" | "silenced";
type View = "demo" | "details";

const CONN_LABEL: Record<string, { text: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  open: { text: "live", tone: "good" },
  connecting: { text: "connecting…", tone: "warn" },
  closed: { text: "reconnecting…", tone: "bad" },
  idle: { text: "idle", tone: "neutral" },
  unconfigured: { text: "no WS url", tone: "bad" },
};

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}

/** Renders + silenced identifications, newest first — the demo storyline. */
function Moments({ entries }: { entries: FeedEntry[] }) {
  const moments = useMemo(
    () =>
      entries
        .filter((e) => e.event.type === "render" || e.event.type === "silenced_identify")
        .slice(-30)
        .reverse(),
    [entries],
  );

  if (moments.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-[var(--muted)]">
        Nothing yet — start a session from the home screen and look at a booth.
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {moments.map((m, i) => {
        const e = m.event;
        return (
          <li
            key={m.id}
            className="anim-swap flex items-baseline justify-between gap-3 rounded-xl px-3 py-2 transition-colors duration-150 hover:bg-[var(--panel-2)]/60"
            style={{ animationDelay: `${Math.min(i, 6) * 30}ms` }}
          >
            {e.type === "render" ? (
              <>
                <span className="min-w-0">
                  <span className="block truncate text-[16px] font-bold">
                    {e.card.title}
                  </span>
                  {e.card.subtitle ? (
                    <span className="block truncate text-[12px] text-[var(--muted)]">
                      {e.card.subtitle}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Chip tone={e.card.kind === "error" ? "bad" : "accent"}>{e.card.kind}</Chip>
                  <span className="tnum font-mono text-[12px] text-[var(--faint)]">
                    {clock(m.at)}
                  </span>
                </span>
              </>
            ) : e.type === "silenced_identify" ? (
              <>
                <span className="min-w-0">
                  <span className="block truncate text-[16px] font-bold text-[var(--muted)]">
                    {e.nameGuess ?? "unknown"}
                  </span>
                  <span className="block text-[12px] text-[var(--muted)]">
                    held back at {e.confidence.toFixed(2)} — override if this is right
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Chip tone="warn">silenced</Chip>
                  <span className="tnum font-mono text-[12px] text-[var(--faint)]">
                    {clock(m.at)}
                  </span>
                </span>
              </>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function FeedClient() {
  const { state, entries, error, clear } = useDashboardSocket();
  const [view, setView] = useState<View>("demo");
  const [filter, setFilter] = useState<Filter>("all");
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const latestCard: HudCard | null = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i].event;
      if (e.type === "render") return e.card;
    }
    return null;
  }, [entries]);

  const silencedCount = useMemo(
    () => entries.filter((e) => e.event.type === "silenced_identify").length,
    [entries],
  );
  const eventCount = useCountUp(entries.length);

  const visible = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => {
      if (filter === "cards") return e.event.type === "render";
      if (filter === "gate") return e.event.type === "gate" || e.event.type === "gate_debug";
      return e.event.type === "silenced_identify";
    });
  }, [entries, filter]);

  useEffect(() => {
    if (!follow || view !== "details") return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow, view]);

  const conn = CONN_LABEL[state] ?? CONN_LABEL.idle;

  return (
    <div>
      <div className="anim-rise mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-[28px] font-bold">Live feed</h1>
          <Chip tone={conn.tone}>{conn.text}</Chip>
          {silencedCount > 0 ? <Chip tone="warn">{silencedCount} silenced</Chip> : null}
        </div>
        <SegmentedControl
          value={view}
          options={[
            { value: "demo", label: "Demo" },
            { value: "details", label: "Details" },
          ]}
          onChange={setView}
          ariaLabel="Feed view"
        />
      </div>

      {state === "unconfigured" ? (
        <div className="mb-4">
          <Notice tone="warn">
            <code className="font-mono">NEXT_PUBLIC_CORTEX_WS_URL</code> is not set — no
            feed to connect to yet.
          </Notice>
        </div>
      ) : null}
      {error && state !== "open" ? (
        <div className="mb-4">
          <Notice tone="warn">{error}</Notice>
        </div>
      ) : null}

      {view === "demo" ? (
        <div key="demo" className="anim-swap grid gap-5 md:grid-cols-[auto_1fr]">
          <div className="mx-auto md:mx-0">
            {latestCard ? (
              <div key={latestCard.cardId} className="anim-swap">
                <HudCardView card={latestCard} />
              </div>
            ) : (
              <div className="flex aspect-square w-[280px] max-w-full items-center justify-center rounded-lg border-2 border-dashed border-[var(--rule)] text-[12px] text-[var(--faint)]">
                the lens is blank
              </div>
            )}
            <p className="mt-2 text-center text-[12px] text-[var(--faint)]">
              Latest card, as the wearer sees it
            </p>
          </div>
          <Section
            title="Moments"
            hint="Every card shown and every identification held back"
            animate={false}
          >
            <Moments entries={entries} />
          </Section>
        </div>
      ) : (
        <div key="details" className="anim-swap">
          <Section
            title="Telemetry"
            hint={`${eventCount} events · gate telemetry about every ${(FRAME_INTERVAL_MS / 1000).toFixed(2)}s while armed`}
            animate={false}
            right={
              <SegmentedControl
                size="sm"
                value={filter}
                options={[
                  { value: "all", label: "All" },
                  { value: "cards", label: "Cards" },
                  { value: "gate", label: "Gate" },
                  { value: "silenced", label: "Silenced" },
                ]}
                onChange={setFilter}
                ariaLabel="Event filter"
              />
            }
          >
            <div
              ref={listRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
              }}
              className="scroll-thin h-[50vh] min-h-[280px] overflow-y-auto rounded-xl bg-[var(--ground)]"
            >
              {visible.length === 0 ? (
                <p className="p-4 text-[13px] text-[var(--muted)]">
                  Nothing yet. Start a session from the home screen.
                </p>
              ) : (
                <ul>
                  {visible.map((entry) => (
                    <EventRow key={entry.id} entry={entry} />
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" onClick={clear}>
                Clear
              </Button>
              <Button size="sm" onClick={() => setFollow((f) => !f)}>
                {follow ? "Pause autoscroll" : "Resume autoscroll"}
              </Button>
            </div>
          </Section>
        </div>
      )}

      <div className="mt-5">
        <OverridePicker />
      </div>
    </div>
  );
}
