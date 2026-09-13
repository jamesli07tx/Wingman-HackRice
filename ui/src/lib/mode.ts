"use client";

// D2: glasses and phone are interchangeable device adapters. The console remembers
// which one the operator is driving, per browser.

import { useCallback, useEffect, useState } from "react";

export type Mode = "glasses" | "phone";

const MODE_KEY = "wingman.mode";
const SESSION_KEY = "wingman.sessionId";
const DEVICE_KEY = "wingman.deviceId";

function readLocal(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled — mode just won't persist */
  }
}

/**
 * Persisted mode toggle. Starts at "glasses" on the server and on the first client
 * render (so SSR markup matches), then adopts the stored value after hydration.
 */
export function useMode(): [Mode, (m: Mode) => void, boolean] {
  const [mode, setModeState] = useState<Mode>("glasses");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = readLocal(MODE_KEY);
    if (stored === "glasses" || stored === "phone") setModeState(stored);
    setHydrated(true);
  }, []);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    writeLocal(MODE_KEY, m);
  }, []);

  return [mode, setMode, hydrated];
}

/** Session id survives a dashboard reload (D10: the session outlives this page). */
export const sessionStore = {
  get: () => readLocal(SESSION_KEY),
  set: (id: string | null) => writeLocal(SESSION_KEY, id),
};

/** Last device the operator armed, so the home screen re-selects it. */
export const deviceStore = {
  get: () => readLocal(DEVICE_KEY),
  set: (id: string | null) => writeLocal(DEVICE_KEY, id),
};
