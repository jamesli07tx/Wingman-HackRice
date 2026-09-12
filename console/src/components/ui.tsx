"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Section({
  title,
  hint,
  right,
  children,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-4 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-zinc-100">{title}</h2>
          {hint ? <p className="mt-0.5 text-xs text-zinc-500">{hint}</p> : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
};

export function Button({ variant = "ghost", className = "", ...rest }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  const styles: Record<string, string> = {
    primary: "bg-[var(--color-accent)] text-[#04211d] hover:brightness-95",
    ghost:
      "border border-[var(--color-edge)] bg-[var(--color-surface-2)] text-zinc-200 hover:border-zinc-500",
    danger: "border border-red-900/70 bg-red-950/40 text-red-200 hover:border-red-700",
  };
  return <button className={`${base} ${styles[variant]} ${className}`} {...rest} />;
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-[var(--color-accent)] focus:outline-none ${className}`}
      {...rest}
    />
  );
}

export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "border-[var(--color-edge)] bg-[var(--color-surface-2)] text-zinc-400",
    good: "border-emerald-900 bg-emerald-950/50 text-emerald-300",
    warn: "border-amber-900 bg-amber-950/50 text-amber-300",
    bad: "border-red-900 bg-red-950/50 text-red-300",
    accent: "border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/60 text-[var(--color-accent)]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone = "warn",
  children,
}: {
  tone?: "warn" | "bad" | "info";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    info: "border-[var(--color-edge)] bg-[var(--color-surface-2)] text-zinc-300",
    warn: "border-amber-900/70 bg-amber-950/30 text-amber-200",
    bad: "border-red-900/70 bg-red-950/30 text-red-200",
  };
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-zinc-500">
      <span className="h-3 w-3 animate-spin rounded-full border border-zinc-600 border-t-transparent" />
      {label}
    </span>
  );
}
