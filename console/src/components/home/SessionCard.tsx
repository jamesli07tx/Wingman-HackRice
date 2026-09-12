"use client";

// Start/Stop tracking (DESIGN.md §4.1: POST /api/session/start|stop).
//
// Glasses mode arms the selected GlassBridge device from here — the wearer touches
// nothing (D3). Phone mode instead sends the operator to /capture, which self-claims
// the phone as a device and opens its own device WS (that page is owned by the
// device track; this button only routes to it).

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { DeviceInfo } from "@wingman/shared";
import { describeError, startSession, stopSession } from "@/lib/api";
import { useCortexAuth } from "@/lib/auth";
import { sessionStore, type Mode } from "@/lib/mode";
import { Button, Chip, Notice, Section } from "@/components/ui";

export function SessionCard({
  mode,
  devices,
  selectedDeviceId,
}: {
  mode: Mode;
  devices: DeviceInfo[];
  selectedDeviceId: string | null;
}) {
  const router = useRouter();
  const { getToken } = useCortexAuth();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A session survives closing the dashboard (D10) — recover the id from storage.
  useEffect(() => {
    setSessionId(sessionStore.get());
  }, []);

  const selected = devices.find((d) => d.deviceId === selectedDeviceId) ?? null;

  const start = async () => {
    if (mode === "phone") {
      router.push("/capture");
      return;
    }
    if (!selectedDeviceId) {
      setError("Pick a linked device first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await startSession(getToken, { deviceId: selectedDeviceId });
      const id = res?.sessionId ?? null;
      setSessionId(id);
      sessionStore.set(id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await stopSession(getToken, { sessionId });
      setSessionId(null);
      sessionStore.set(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Tracking"
      hint={
        mode === "glasses"
          ? "Arms the glasses: continuous frames up, cards down. The wearer does nothing."
          : "Phone mode runs the same pipeline from the browser camera."
      }
      right={
        sessionId ? (
          <Chip tone="good">armed · {sessionId}</Chip>
        ) : (
          <Chip>idle</Chip>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={() => void start()}
          disabled={busy || (mode === "glasses" && Boolean(sessionId))}
        >
          {mode === "phone" ? "Open phone capture" : busy ? "Starting…" : "Start tracking"}
        </Button>
        <Button variant="danger" onClick={() => void stop()} disabled={busy || !sessionId}>
          Stop
        </Button>
        <Button onClick={() => router.push("/feed")}>Open live feed</Button>
      </div>

      {mode === "glasses" ? (
        <p className="mt-3 text-xs text-zinc-500">
          {selected
            ? `Will arm: ${selected.name}`
            : "No device selected — link the glasses above."}
        </p>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">
          /capture claims this phone as a device, opens the camera, and auto-detects —
          no buttons on that page.
        </p>
      )}

      <p className="mt-2 text-xs text-zinc-500">
        The capture LED stays lit the whole time a session is armed. That is the honest
        signal, by design (D14) — see{" "}
        <a className="underline underline-offset-2" href="/instructions">
          instructions
        </a>
        .
      </p>

      {error ? (
        <div className="mt-3">
          <Notice tone="warn">{error}</Notice>
        </div>
      ) : null}
    </Section>
  );
}
