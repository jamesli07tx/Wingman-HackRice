"use client";

// D9: glasses link with a TV-style 6-digit code shown here; the phone self-claims
// from /capture. Past links are cached server-side and listed here.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceInfo, LinkCodeResponse } from "@wingman/shared";
import { createLinkCode, describeError, listDevices } from "@/lib/api";
import { useCortexAuth } from "@/lib/auth";
import { Button, Chip, Notice, Section, Spinner } from "@/components/ui";

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function DevicesCard({
  selectedDeviceId,
  onSelect,
}: {
  selectedDeviceId: string | null;
  onSelect: (deviceId: string | null, devices: DeviceInfo[]) => void;
}) {
  const { getToken } = useCortexAuth();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState<LinkCodeResponse | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listDevices(getToken);
      const safe = Array.isArray(list) ? list : [];
      setDevices(safe);
      setError(null);
      onSelectRef.current(
        safe.some((d) => d.deviceId === selectedDeviceId)
          ? selectedDeviceId
          : (safe[0]?.deviceId ?? null),
        safe,
      );
    } catch (err) {
      setDevices([]);
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [getToken, selectedDeviceId]);

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

  return (
    <Section
      title="Devices"
      hint="Glasses link with a 6-digit code. The phone claims itself when /capture opens."
      right={
        <Button onClick={() => void refresh()} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </Button>
      }
    >
      {error ? (
        <div className="mb-3">
          <Notice tone="warn">{error}</Notice>
        </div>
      ) : null}

      {loading && devices === null ? (
        <Spinner label="Loading devices…" />
      ) : devices && devices.length > 0 ? (
        <ul className="mb-3 space-y-2">
          {devices.map((d) => {
            const active = d.deviceId === selectedDeviceId;
            return (
              <li key={d.deviceId}>
                <button
                  onClick={() => onSelect(d.deviceId, devices)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                    active
                      ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
                      : "border-[var(--color-edge)] hover:border-zinc-600"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-zinc-100">{d.name}</span>
                    <span className="block truncate text-[11px] text-zinc-500">
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
        <p className="mb-3 text-xs text-zinc-500">
          No devices linked yet.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void requestCode()}>Link glasses</Button>
        {code ? (
          <div className="flex items-center gap-3 rounded-lg border border-[var(--color-accent-dim)] bg-[var(--color-surface-2)] px-3 py-2">
            <span className="font-mono text-2xl tracking-[0.3em] text-[var(--color-accent)]">
              {code.code}
            </span>
            <span className="text-[11px] text-zinc-500">
              expires in {Math.floor(secondsLeft / 60)}:
              {String(secondsLeft % 60).padStart(2, "0")}
            </span>
          </div>
        ) : null}
      </div>
      {code ? (
        <p className="mt-2 text-[11px] text-zinc-500">
          Type this into GlassBridge on the phone (Link screen) while it is open.
        </p>
      ) : null}
      {codeError ? (
        <div className="mt-2">
          <Notice tone="warn">{codeError}</Notice>
        </div>
      ) : null}
    </Section>
  );
}
