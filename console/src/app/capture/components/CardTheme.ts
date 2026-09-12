// INTEGRATION: capture/CardTheme
// IN:  HudCard.kind (DESIGN.md §4.2)
// OUT: the accent colour both renderers (AR bubble + 600x600 HUD replica) use,
//      so the dev replica and the demo view never drift
// WIRE: imported by ArBubble.tsx and HudReplica.tsx.

import type { CardKind } from "@wingman/shared";

export interface KindTheme {
  accent: string;
  label: string;
}

const THEMES: Record<CardKind, KindTheme> = {
  ack: { accent: "#f5c451", label: "Identifying" },
  company: { accent: "#5ad1ff", label: "Company" },
  pitch: { accent: "#b48bff", label: "Your pitch" },
  scan: { accent: "#6ee7a8", label: "Scan" },
  hint: { accent: "#9aa6b2", label: "Hint" },
  error: { accent: "#ff7a7a", label: "Error" },
};

export function kindTheme(kind: CardKind): KindTheme {
  return THEMES[kind] ?? THEMES.hint;
}

/** Renderer contract: title + subtitle + max 5 lines + footer (DESIGN.md §4.2). */
export const MAX_LINES = 5;

export function pageMarker(page: { index: number; count: number } | undefined): string | null {
  if (!page) return null;
  return `${page.index}/${page.count}`;
}
