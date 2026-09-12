"use client";

import type { Mode } from "@/lib/mode";

// D2: the glasses are a pluggable I/O layer — phone mode is the same backend
// behavior through a different adapter. The toggle picks which one Start drives.

export function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Device mode"
      className="inline-flex rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] p-1"
    >
      {(["glasses", "phone"] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          disabled={disabled}
          onClick={() => onChange(m)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors disabled:opacity-50 ${
            mode === m
              ? "bg-[var(--color-accent)] text-[#04211d]"
              : "text-zinc-400 hover:text-zinc-100"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}
