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
            variables: { colorPrimary: "#5eead4", colorBackground: "#0e1116" },
          }}
        />
      ) : (
        <div className="max-w-sm rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-4 text-sm text-zinc-300">
          <p className="font-medium text-zinc-100">Clerk is not configured.</p>
          <p className="mt-2 text-xs text-zinc-500">
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
