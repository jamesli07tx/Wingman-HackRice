import { SignIn } from "@clerk/nextjs";
import { CLERK_ENABLED } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      {CLERK_ENABLED ? (
        // D8: one seeded demo account — created by hand in the Clerk dashboard.
        <SignIn
          routing="hash"
          appearance={{
            variables: {
              colorPrimary: "#4472C4",
              colorBackground: "#ffffff",
              borderRadius: "0.75rem",
            },
          }}
        />
      ) : (
        <div className="anim-rise max-w-sm rounded-lg bg-[var(--panel)] p-6 text-sm shadow-[var(--shadow-2)]">
          <p className="font-bold">Clerk is not configured.</p>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">
            Set <code className="font-mono">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> and{" "}
            <code className="font-mono">CLERK_SECRET_KEY</code>, then seed the single demo
            account in the Clerk dashboard. Until then every route is open and no session
            JWT is attached to Cortex calls.
          </p>
        </div>
      )}
    </div>
  );
}
