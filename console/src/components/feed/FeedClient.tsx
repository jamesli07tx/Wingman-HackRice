"use client";

// Mission control (DESIGN.md §4.3): put this on the judges' screen while the wearer
// walks the booth. It is also the Mac side's debugging window into what Cortex
// thinks the glasses are seeing.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HudCard } from "@wingman/shared";
import { FRAME_INTERVAL_MS } from "@wingman/shared";
import { HudCardView } from "@/components/HudCardView";
import { EventRow } from "@/components/feed/EventRow";
import { OverridePicker } from "@/components/feed/OverridePicker";
import { Button, Chip, Notice, Section } from "@/components/ui";
import { useDashboardSocket } from "@/lib/dashboardSocket";

type Filter = "all" | "cards" | "gate" | "silenced";

const CONN_LABEL: Record<string, { text: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  open: { text: "live", tone: "good" },
  connecting: { text: "connecting…", tone: "warn" },
  closed: { text: "reconnecting…", tone: "bad" },
  idle: { text: "idle", tone: "neutral" },
  unconfigured: { text: "no WS url", tone: "bad" },
};

export function FeedClient() {
  const { state, entries, error, clear } = useDashboardSocket();
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

  const visible = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => {
      if (filter === "cards") return e.event.type === "render";
      if (filter === "gate") return e.event.type === "gate";
      return e.event.type === "silenced_identify";
    });
  }, [entries, filter]);

  useEffect(() => {
    if (!follow) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow]);

  const conn = CONN_LABEL[state] ?? CONN_LABEL.idle;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Live feed</h1>
          <p className="text-xs text-zinc-500">
            Every render, every gate class, every silenced identification.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone={conn.tone}>{conn.text}</Chip>
          {silencedCount > 0 ? <Chip tone="warn">{silencedCount} silenced</Chip> : null}
        </div>
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

      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <Section
          title="Events"
          hint={`${entries.length} received`}
          right={
            <div className="flex flex-wrap items-center gap-1">
              {(["all", "cards", "gate", "silenced"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-md px-2 py-1 text-[11px] capitalize ${
                    filter === f
                      ? "bg-[var(--color-surface-2)] text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-200"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          }
        >
          <div
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
            }}
            className="scroll-thin h-[50vh] min-h-[280px] overflow-y-auto rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)]"
          >
            {visible.length === 0 ? (
              <p className="p-4 text-xs text-zinc-600">
                Nothing yet. Start a session from the home screen — gate telemetry
                appears about every {(FRAME_INTERVAL_MS / 1000).toFixed(2)}s while armed.
              </p>
            ) : (
              <ul>
                {visible.map((entry) => (
                  <EventRow key={entry.id} entry={entry} />
                ))}
              </ul>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button onClick={clear}>Clear</Button>
            <Button onClick={() => setFollow((f) => !f)}>
              {follow ? "Pause autoscroll" : "Resume autoscroll"}
            </Button>
          </div>
        </Section>

        <Section title="Lens preview" hint="Latest card, as the wearer sees it">
          {latestCard ? (
            <HudCardView card={latestCard} />
          ) : (
            <div className="flex aspect-square w-full max-w-[300px] items-center justify-center rounded-xl border border-dashed border-[var(--color-edge)] text-xs text-zinc-600">
              no card yet
            </div>
          )}
        </Section>
      </div>

      <div className="mt-4">
        <OverridePicker />
      </div>
    </div>
  );
}
