"use client";

// INTEGRATION: capture/useCardPresenter
// IN:  HudCard from RenderMsg (DESIGN.md §4.2)
// OUT: the single card the overlay is currently drawing
// WIRE: page.tsx wires useDeviceLink({ onRender: present }).
//
// Renderer rules implemented here (devices are stateless renderers — Cortex owns rotation):
//  - same cardId + HIGHER seq  -> replace the content IN PLACE (this is a rotation/stream tick)
//  - same cardId + LOWER seq   -> stale, dropped
//  - DIFFERENT cardId          -> honoured only after the current card has been visible for
//                                 minDisplaySec (D11); until then it waits as pending and the
//                                 newest pending wins.

import { useCallback, useEffect, useRef, useState } from "react";
import type { HudCard } from "@wingman/shared";

export interface PresenterState {
  card: HudCard | null;
  /** epoch ms the current card first appeared (reset on every accepted update) */
  shownAt: number;
  /** a newer card set is waiting out the current card's minDisplaySec */
  pendingHeld: boolean;
}

export interface CardPresenter extends PresenterState {
  present: (card: HudCard) => void;
  clear: () => void;
}

export function useCardPresenter(): CardPresenter {
  const [state, setState] = useState<PresenterState>({
    card: null,
    shownAt: 0,
    pendingHeld: false,
  });
  const cardRef = useRef<HudCard | null>(null);
  const shownAtRef = useRef(0);
  const pendingRef = useRef<HudCard | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback((card: HudCard) => {
    cardRef.current = card;
    shownAtRef.current = Date.now();
    pendingRef.current = null;
    setState({ card, shownAt: shownAtRef.current, pendingHeld: false });
  }, []);

  const present = useCallback(
    (incoming: HudCard) => {
      const current = cardRef.current;

      if (!current) {
        commit(incoming);
        return;
      }

      if (incoming.cardId === current.cardId) {
        if (incoming.seq < current.seq) return; // stale/out-of-order — drop
        commit(incoming); // update in place
        return;
      }

      const minMs = Math.max(0, (current.minDisplaySec ?? 0) * 1000);
      const elapsed = Date.now() - shownAtRef.current;
      if (elapsed >= minMs) {
        commit(incoming);
        return;
      }

      pendingRef.current = incoming;
      setState((s) => ({ ...s, pendingHeld: true }));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingRef.current;
        if (pending) commit(pending);
      }, minMs - elapsed);
    },
    [commit],
  );

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
    cardRef.current = null;
    shownAtRef.current = 0;
    setState({ card: null, shownAt: 0, pendingHeld: false });
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { ...state, present, clear };
}
