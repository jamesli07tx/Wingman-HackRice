"use client";

// One source of truth for "how does a Clerk session JWT reach Cortex".
//
// REST (DESIGN.md §4.1): Authorization: Bearer <token>
// Dashboard WS (DESIGN.md §4.3): wss://…/ws/dashboard?token=<token>
//
// Pages never import Clerk hooks directly — they call useCortexAuth(). That keeps
// every page renderable when Clerk is unconfigured (no publishable key ⇒ no
// <ClerkProvider> ⇒ Clerk hooks would throw), which is what makes `next build`
// work without env vars.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth, useUser } from "@clerk/nextjs";
import { CLERK_ENABLED } from "./env";

export interface CortexAuth {
  /** Resolves the current Clerk session JWT, or null when unauthenticated/unconfigured. */
  getToken: () => Promise<string | null>;
  isLoaded: boolean;
  isSignedIn: boolean;
  displayName: string | null;
  enabled: boolean;
}

const AuthContext = createContext<CortexAuth>({
  getToken: async () => null,
  isLoaded: true,
  isSignedIn: false,
  displayName: null,
  enabled: false,
});

function ClerkAuthBridge({ children }: { children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const value = useMemo<CortexAuth>(
    () => ({
      getToken: async () => {
        try {
          return await getToken();
        } catch {
          return null;
        }
      },
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      displayName: user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? null,
      enabled: true,
    }),
    [getToken, isLoaded, isSignedIn, user],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function NoAuthBridge({ children }: { children: ReactNode }) {
  const value = useMemo<CortexAuth>(
    () => ({
      getToken: async () => null,
      isLoaded: true,
      isSignedIn: false,
      displayName: null,
      enabled: false,
    }),
    [],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function CortexAuthProvider({ children }: { children: ReactNode }) {
  // Component choice, not a conditional hook — both branches call hooks unconditionally.
  return CLERK_ENABLED ? (
    <ClerkAuthBridge>{children}</ClerkAuthBridge>
  ) : (
    <NoAuthBridge>{children}</NoAuthBridge>
  );
}

export function useCortexAuth(): CortexAuth {
  return useContext(AuthContext);
}
