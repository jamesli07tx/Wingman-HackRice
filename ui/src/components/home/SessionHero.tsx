"use client";

// The one action on the home screen (DESIGN.md §4.1: POST /api/session/start|stop).
// Absorbs the old Devices + Tracking cards: mode picks what Start drives (D2),
// glasses mode arms a linked GlassBridge device, phone mode routes to /capture
// (that page self-claims the phone and needs no buttons, D3). Link codes are
// TV-style 6-digit (D9); a session survives closing the dashboard (D10).
// Selected device row = the portal's pale-blue selected state with a product-blue inset bar.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceInfo, LinkCodeResponse } from "@wingman/shared";
import { createLinkCode, describeError, listDevices, startSession, stopSession } from "@/lib/api";
import { useCortexAuth } from "@/lib/auth";
import { deviceStore, sessionStore, type Mode } from "@/lib/mode";
import { Button, Chip, Notice, SkeletonRows } from "@/components/ui";

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function SessionHero({ mode }: { mode: Mode }) {
  const router = useRouter();
  const { getToken } = useCortexAuth();

  // --- devices (old DevicesCard logic, unchanged) ---------------------------
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState<LinkCodeResponse | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const selectedRef = useRef<string | null>(null);

  useEffect(() => {
    selectedRef.current = deviceStore.get();
    setSelectedDeviceId(selectedRef.current);
  }, []);

  const select = (deviceId: string | null) => {
    selectedRef.current = deviceId;
    setSelectedDeviceId(deviceId);
    deviceStore.set(deviceId);
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listDevices(getToken);
      const safe = Array.isArray(list) ? list : [];
      setDevices(safe);
      setDevicesError(null);
      const keep = safe.some((d) => d.deviceId === selectedRef.current)
        ? selectedRef.current
        : (safe[0]?.deviceId ?? null);
      selectedRef.current = keep;
      setSelectedDeviceId(keep);
      deviceStore.set(keep);
    } catch (err) {
      setDevices([]);
      setDevicesError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  // Mount fetch only — refresh is otherwise explicit (no polling storm on a dead backend).
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Link-code expiry countdown.
  useEffect(() => {
    if (!code) return;
    const tick = () => {
      const left = Math.max(0, Math.round((Date.parse(code.expiresAt) - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setCode(null);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [code]);

  const requestCode = async () => {
    setCodeError(null);
    try {
      setCode(await createLinkCode(getToken));
    } catch (err) {
      setCodeError(describeError(err));
    }
  };

  // --- session (old SessionCard logic, unchanged) ---------------------------
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    setSessionId(sessionStore.get());
  }, []);

  const start = async () => {
    if (mode === "phone") {
      router.push("/capture");
      return;
    }
    if (!selectedDeviceId) {
      setSessionError("Pick a linked device first.");
      return;
    }
    setBusy(true);
    setSessionError(null);
    try {
      const res = await startSession(getToken, { deviceId: selectedDeviceId });
      const id = res?.sessionId ?? null;
      setSessionId(id);
      sessionStore.set(id);
    } catch (err) {
      setSessionError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!sessionId) return;
    setBusy(true);
    setSessionError(null);
    try {
      await stopSession(getToken, { sessionId });
      setSessionId(null);
      sessionStore.set(null);
    } catch (err) {
      setSessionError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const armed = Boolean(sessionId);
  const selected = (devices ?? []).find((d) => d.deviceId === selectedDeviceId) ?? null;

  return (
    <section
      className="anim-rise mb-6 rounded-lg bg-[var(--panel)] p-6 shadow-[var(--shadow-2)]"
      style={{ animationDelay: "40ms" }}
    >
      {/* status line */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold">
          {armed ? "Tracking" : "Ready"}
        </h2>
        {armed ? <Chip tone="good">armed · {sessionId}</Chip> : <Chip>idle</Chip>}
      </div>

      {/* the one action */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="lg"
          onClick={() => void start()}
          disabled={busy || (mode === "glasses" && armed)}
        >
          {mode === "phone" ? "Open phone capture" : busy ? "Starting…" : "Start tracking"}
        </Button>
        {armed ? (
          <span className="anim-swap">
            <Button variant="danger" size="lg" onClick={() => void stop()} disabled={busy}>
              Stop
            </Button>
          </span>
        ) : null}
        <Button variant="ghost" size="lg" onClick={() => router.push("/feed")}>
          Live feed
        </Button>
      </div>

      <p className="mt-3 text-[13px] text-[var(--muted)]">
        {mode === "glasses"
          ? selected
            ? `Arms ${selected.name} — the wearer touches nothing.`
            : "Link the glasses below, then Start."
          : "Opens the camera on this phone and auto-detects."}
      </p>

      {sessionError ? (
        <div className="mt-3">
          <Notice tone="warn">{sessionError}</Notice>
        </div>
      ) : null}

      {/* device picker — glasses mode only */}
      {mode === "glasses" ? (
        <div className="anim-swap mt-6 border-t border-[var(--rule)] pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm text-[var(--muted)]">
              Device
            </h3>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
                {loading ? "…" : "Refresh"}
              </Button>
              <Button size="sm" onClick={() => void requestCode()}>
                Link glasses
              </Button>
            </div>
          </div>

          <div className="reveal" data-open={Boolean(code)}>
            <div>
              {code ? (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-[var(--accent-deep)] px-4 py-3">
                  <span className="tnum font-mono text-2xl font-semibold tracking-[0.3em] text-[var(--accent)]">
                    {code.code}
                  </span>
                  <span className="tnum text-[12px] text-[var(--accent)]">
                    enter in GlassBridge · {Math.floor(secondsLeft / 60)}:
                    {String(secondsLeft % 60).padStart(2, "0")}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          {codeError ? (
            <div className="mb-3">
              <Notice tone="warn">{codeError}</Notice>
            </div>
          ) : null}
          {devicesError ? (
            <div className="mb-3">
              <Notice tone="warn">{devicesError}</Notice>
            </div>
          ) : null}

          {loading && devices === null ? (
            <SkeletonRows rows={3} height={52} />
          ) : devices && devices.length > 0 ? (
            <ul className="space-y-1.5">
              {devices.map((d) => {
                const active = d.deviceId === selectedDeviceId;
                return (
                  <li key={d.deviceId}>
                    <button
                      onClick={() => select(d.deviceId)}
                      className={`pressable relative flex w-full items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-left ${
                        active
                          ? "bg-[var(--panel-2)] shadow-[var(--shadow-1)]"
                          : "hover:bg-[var(--panel-2)]/60"
                      }`}
                    >
                      {/* selection gold inset bar */}
                      <span
                        aria-hidden
                        className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-[var(--sel)] transition-opacity duration-150 ${
                          active ? "opacity-100" : "opacity-0"
                        }`}
                      />
                      <span className="min-w-0 pl-1.5">
                        <span className="block truncate text-[14px] font-medium text-[var(--fg)]">
                          {d.name}
                        </span>
                        <span className="block truncate text-[12px] text-[var(--muted)]">
                          {d.deviceType === "glasses_bridge" ? "GlassBridge" : "Phone web"} ·{" "}
                          {relTime(d.lastSeen)}
                        </span>
                      </span>
                      {active ? <Chip tone="accent">selected</Chip> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[13px] text-[var(--muted)]">No devices linked yet.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
