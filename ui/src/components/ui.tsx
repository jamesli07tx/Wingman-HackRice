"use client";

import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

/* Confidanz product control grammar (clinician portal): white cards on
   shadow-lg with text-xl bold navy titles, rounded-full bold buttons in
   product blue, pale-blue #DFE7F5 pills for selected states (NavItem +
   FilterBubble), gray-200 pulse skeletons. Motion: the portal's
   transition-colors duration-200 vocabulary plus a sliding segmented thumb,
   press feedback and entrance rises. Everything respects reduced motion. */

export function Section({
  title,
  hint,
  right,
  children,
  animate = true,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
  animate?: boolean;
}) {
  return (
    <section
      className={`mb-6 rounded-lg bg-[var(--panel)] p-6 shadow-[var(--shadow-2)] ${animate ? "anim-rise" : ""}`}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-[var(--fg)]">{title}</h2>
          {hint ? <p className="mt-0.5 text-sm text-[var(--muted)]">{hint}</p> : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
};

/** Portal Button: rounded-full, bold, leading-none; primary #4472C4 → #2B5797,
    secondary = transparent with a 1px inset ring, outline = white with a 2px
    blue border (the sidebar's "Add User"). */
export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...rest
}: ButtonProps) {
  const base =
    "pressable inline-flex items-center justify-center gap-2 rounded-full font-bold leading-none disabled:cursor-not-allowed disabled:opacity-70";
  const sizes: Record<string, string> = {
    sm: "px-4 py-[10px] text-[12px]",
    md: "px-5 py-[11px] text-[14px]",
    lg: "px-6 py-[12px] text-[16px]",
  };
  const styles: Record<string, string> = {
    primary: "bg-[var(--accent)] text-white hover:bg-[var(--accent-strong)]",
    secondary:
      "bg-transparent text-[#333333] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15)] hover:bg-[var(--panel-2)]",
    outline:
      "bg-white text-[var(--accent)] border-2 border-[var(--accent)] hover:bg-[#f0f4fa] py-[9px]",
    ghost: "bg-transparent text-[var(--fg)] hover:bg-[var(--panel-2)]",
    danger: "bg-[var(--bad-soft)] text-[var(--bad)] hover:brightness-95",
  };
  return <button className={`${base} ${sizes[size]} ${styles[variant]} ${className}`} {...rest} />;
}

/** Segmented control with a sliding pale-blue thumb: the NavItem/FilterBubble
    selected state (#DFE7F5 + bold navy) moving between equal columns. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
  size = "md",
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const pad = size === "sm" ? "px-3 text-[12px] h-7" : "px-4 text-[14px] h-9";
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="relative inline-grid rounded-full bg-[var(--panel-2)] p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="seg-thumb absolute top-1 bottom-1 left-1 rounded-full bg-[var(--accent-deep)]"
        style={{
          width: `calc((100% - 8px) / ${options.length})`,
          transform: `translateX(${idx * 100}%)`,
          transition: "transform var(--t-swap) var(--ease)",
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`relative z-[1] rounded-full transition-colors duration-200 disabled:opacity-50 ${pad} ${
            value === o.value
              ? "font-bold text-[var(--fg)]"
              : "font-normal text-[var(--sidebar-ink)] hover:text-[var(--fg)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-[#d1d5db] bg-white px-3.5 py-2.5 text-[14px] text-[var(--fg)] transition-colors duration-200 placeholder:text-[var(--faint)] focus:border-[var(--accent)] focus:outline-none ${className}`}
      {...rest}
    />
  );
}

/** FilterBubble grammar: rounded-full pale pill, navy text. */
export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-[var(--panel-2)] text-[#4b5563]",
    good: "bg-[var(--good-soft)] text-[var(--good)]",
    warn: "bg-[var(--warn-soft)] text-[var(--warn)]",
    bad: "bg-[var(--bad-soft)] text-[var(--bad)]",
    accent: "bg-[var(--accent-deep)] text-[var(--fg)]",
  };
  return (
    <span
      className={`tnum inline-flex items-center gap-1 rounded-full px-3 py-1 text-[13px] font-medium ${tones[tone]}`}
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
    info: "bg-[var(--panel-2)] text-[#4b5563]",
    warn: "bg-[var(--warn-soft)] text-[#7a6d00]",
    bad: "bg-[var(--bad-soft)] text-[var(--bad)]",
  };
  return (
    <div className={`anim-swap rounded-lg px-4 py-3 text-sm leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-[var(--muted)]">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      {label}
    </span>
  );
}

/** Portal skeletons: animate-pulse gray-200 blocks, never a spinner. */
export function SkeletonRows({ rows = 3, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton w-full" style={{ height }} />
      ))}
    </div>
  );
}

/** Count-up for compared numbers: rAF, 650ms cubic ease-out, snaps under
    reduced motion. All state writes happen inside the rAF callback. */
export function useCountUp(target: number, durationMs = 650): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}
