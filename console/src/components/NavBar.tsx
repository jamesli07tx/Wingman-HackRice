"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { CLERK_ENABLED } from "@/lib/env";
import { useCortexAuth } from "@/lib/auth";

const LINKS: Array<{ href: string; label: string }> = [
  { href: "/", label: "Home" },
  { href: "/feed", label: "Feed" },
  { href: "/instructions", label: "Instructions" },
];

export function NavBar() {
  const pathname = usePathname();
  const { isSignedIn, displayName } = useCortexAuth();

  return (
    <header className="sticky top-0 z-20 border-b border-[var(--color-edge)] bg-[var(--color-ink)]/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
        <Link href="/" className="shrink-0 text-sm font-semibold tracking-tight">
          <span className="text-[var(--color-accent)]">◆</span> Wingman
        </Link>
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {LINKS.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`shrink-0 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-[var(--color-surface-2)] text-white"
                    : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        {CLERK_ENABLED && isSignedIn ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden max-w-[10rem] truncate text-xs text-zinc-500 sm:inline">
              {displayName}
            </span>
            <SignOutButton>
              <button className="rounded-md border border-[var(--color-edge)] px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100">
                Sign out
              </button>
            </SignOutButton>
          </div>
        ) : null}
      </div>
    </header>
  );
}
