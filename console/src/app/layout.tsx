import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { CortexAuthProvider } from "@/lib/auth";
import { CLERK_ENABLED } from "@/lib/env";
import { NavBar } from "@/components/NavBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wingman Console",
  description: "Zero-touch career-fair copilot — mission control",
};

// Segment config inherited by EVERY route (including /capture, owned by the device
// track). The whole console is a live client of Cortex behind Clerk — nothing here
// benefits from a build-time prerender, and prerendering Clerk hooks without keys
// is exactly what would break `next build` on a clean checkout.
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#07090c",
};

function Shell({ children }: { children: ReactNode }) {
  return (
    <CortexAuthProvider>
      <div className="min-h-dvh">
        <NavBar />
        <main className="mx-auto w-full max-w-3xl px-4 pb-24 pt-4">{children}</main>
      </div>
    </CortexAuthProvider>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const body = <Shell>{children}</Shell>;
  return (
    <html lang="en">
      <body>
        {/* Clerk only mounts when a publishable key exists: `next build` (and a local
            checkout with no .env) must not require credentials. */}
        {CLERK_ENABLED ? <ClerkProvider>{body}</ClerkProvider> : body}
      </body>
    </html>
  );
}
