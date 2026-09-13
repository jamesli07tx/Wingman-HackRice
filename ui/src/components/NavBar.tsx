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

/** Portal Sidebar grammar, laid horizontal: white bar on shadow-md, NavItem
    links (rounded-lg, 16px, navy; active = bold on pale blue #DFE7F5). */
export function NavBar() {
  const pathname = usePathname();
  const { isSignedIn, displayName } = useCortexAuth();

  return (
    <header className="sticky top-0 z-20 bg-white shadow-[var(--shadow-1)]">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-5 px-4 py-2.5">
        <Link href="/" className="shrink-0 text-[18px] font-bold text-[var(--fg)]">
          <span className="text-[var(--accent)]">◆</span> Wingman
        </Link>
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-[var(--sidebar-ink)]">
          {LINKS.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`pressable shrink-0 rounded-lg px-4 py-2 text-[15px] text-[var(--fg)] hover:bg-[var(--panel-2)] ${
                  active ? "bg-[var(--accent-deep)] font-bold hover:bg-[var(--accent-deep)]" : "font-normal"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        {CLERK_ENABLED && isSignedIn ? (
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden max-w-[10rem] truncate text-[13px] text-[var(--muted)] sm:inline">
              {displayName}
            </span>
            <SignOutButton>
              <button className="pressable rounded-full px-4 py-[8px] text-[12px] font-bold text-[#333333] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15)] hover:bg-[var(--panel-2)]">
                Sign out
              </button>
            </SignOutButton>
          </div>
        ) : null}
      </div>
    </header>
  );
}
