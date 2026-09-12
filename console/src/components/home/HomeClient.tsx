"use client";

import { useCallback, useEffect, useState } from "react";
import type { DeviceInfo } from "@wingman/shared";
import { useCortexAuth } from "@/lib/auth";
import { CLERK_ENABLED, CORTEX_CONFIGURED } from "@/lib/env";
import { deviceStore, useMode } from "@/lib/mode";
import { DevicesCard } from "@/components/home/DevicesCard";
import { ModeToggle } from "@/components/home/ModeToggle";
import { ProfileCard } from "@/components/home/ProfileCard";
import { SessionCard } from "@/components/home/SessionCard";
import { Notice } from "@/components/ui";

export function HomeClient() {
  const [mode, setMode, modeHydrated] = useMode();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const { isLoaded, isSignedIn } = useCortexAuth();

  useEffect(() => {
    setSelectedDeviceId(deviceStore.get());
  }, []);

  const handleSelect = useCallback((deviceId: string | null, list: DeviceInfo[]) => {
    setDevices(list);
    setSelectedDeviceId(deviceId);
    deviceStore.set(deviceId);
  }, []);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Wingman</h1>
          <p className="text-xs text-zinc-500">
            Look at a booth. Say nothing. The card appears.
          </p>
        </div>
        <ModeToggle mode={mode} onChange={setMode} disabled={!modeHydrated} />
      </div>

      {!CORTEX_CONFIGURED ? (
        <div className="mb-4">
          <Notice tone="warn">
            <strong>Cortex URL not configured.</strong> Set{" "}
            <code className="font-mono">NEXT_PUBLIC_CORTEX_URL</code> and{" "}
            <code className="font-mono">NEXT_PUBLIC_CORTEX_WS_URL</code> — the console
            runs, but every call below will fail until the backend is deployed.
          </Notice>
        </div>
      ) : null}

      {CLERK_ENABLED && isLoaded && !isSignedIn ? (
        <div className="mb-4">
          <Notice tone="warn">
            You are signed out — <a className="underline" href="/sign-in">sign in</a> to
            reach Cortex.
          </Notice>
        </div>
      ) : null}

      {!CLERK_ENABLED ? (
        <div className="mb-4">
          <Notice tone="info">
            Clerk is not configured — auth is bypassed and no session JWT will be sent.
            Set <code className="font-mono">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> +{" "}
            <code className="font-mono">CLERK_SECRET_KEY</code>.
          </Notice>
        </div>
      ) : null}

      <DevicesCard selectedDeviceId={selectedDeviceId} onSelect={handleSelect} />
      <SessionCard mode={mode} devices={devices} selectedDeviceId={selectedDeviceId} />
      <ProfileCard />
    </div>
  );
}
