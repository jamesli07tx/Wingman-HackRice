"use client";

import { useCortexAuth } from "@/lib/auth";
import { CLERK_ENABLED, CORTEX_CONFIGURED } from "@/lib/env";
import { useMode } from "@/lib/mode";
import { ProfileCard } from "@/components/home/ProfileCard";
import { SessionHero } from "@/components/home/SessionHero";
import { Notice, SegmentedControl } from "@/components/ui";

export function HomeClient() {
  const [mode, setMode, modeHydrated] = useMode();
  const { isLoaded, isSignedIn } = useCortexAuth();

  return (
    <div>
      <div className="anim-rise mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold text-[var(--fg)]">Wingman</h1>
          <p className="mt-1 text-[15px] text-[var(--muted)]">
            Look at a booth. Say nothing. The card appears.
          </p>
        </div>
        <SegmentedControl
          value={mode}
          options={[
            { value: "glasses", label: "Glasses" },
            { value: "phone", label: "Phone" },
          ]}
          onChange={setMode}
          disabled={!modeHydrated}
          ariaLabel="Device mode"
        />
      </div>

      {!CORTEX_CONFIGURED ? (
        <div className="mb-4">
          <Notice tone="warn">
            <strong>Cortex URL not configured.</strong> Set{" "}
            <code className="font-mono">NEXT_PUBLIC_CORTEX_URL</code> and{" "}
            <code className="font-mono">NEXT_PUBLIC_CORTEX_WS_URL</code>.
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
            Clerk is not configured — auth is bypassed. Set{" "}
            <code className="font-mono">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> +{" "}
            <code className="font-mono">CLERK_SECRET_KEY</code>.
          </Notice>
        </div>
      ) : null}

      <SessionHero mode={mode} />
      <ProfileCard />
    </div>
  );
}
