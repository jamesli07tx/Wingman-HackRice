"use client";

// Demo safety (D3/D13/§8): the only manual path in the whole system, and it is
// operator-side. Search the corpus, force a company, bypass gate + cooldown +
// confidence. Works even with LLM calls disabled — that is the outage drill.

import { useEffect, useRef, useState } from "react";
import type { CompanySearchItem } from "@wingman/shared";
import { describeError, overrideCompany, searchCompanies } from "@/lib/api";
import { useCortexAuth } from "@/lib/auth";
import { Button, Input, Notice, Section } from "@/components/ui";

export function OverridePicker() {
  const { getToken } = useCortexAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CompanySearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forced, setForced] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(async () => {
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      setSearching(true);
      try {
        const list = await searchCompanies(getToken, q, ctl.signal);
        setResults(Array.isArray(list) ? list : []);
        setError(null);
      } catch (err) {
        if (!ctl.signal.aborted) {
          setResults([]);
          setError(describeError(err));
        }
      } finally {
        if (!ctl.signal.aborted) setSearching(false);
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query, getToken]);

  const force = async (item: CompanySearchItem) => {
    setError(null);
    try {
      await overrideCompany(getToken, { companyId: item.companyId });
      setForced(item.name);
      window.setTimeout(() => setForced(null), 4000);
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <Section
      title="Override"
      hint="Force a company onto the lens — bypasses the gate, cooldown and confidence floor"
    >
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search companies…"
        aria-label="Search companies"
      />
      {searching ? (
        <p className="mt-2 tnum text-[12px] text-[var(--faint)]">Searching…</p>
      ) : null}
      {results.length > 0 ? (
        <ul className="scroll-thin mt-2 max-h-56 space-y-1 overflow-y-auto">
          {results.map((r) => (
            <li key={r.companyId}>
              <div className="flex items-center justify-between gap-2 rounded-xl px-3.5 py-2 hover:bg-[var(--panel-2)]/60">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{r.name}</span>
                  <span className="block truncate tnum font-mono text-[12px] text-[var(--faint)]">
                    {r.companyId}
                  </span>
                </span>
                <Button size="sm" variant="primary" onClick={() => void force(r)}>
                  Force
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {forced ? (
        <div className="mt-2">
          <Notice tone="info">Forced {forced} onto the lens.</Notice>
        </div>
      ) : null}
      {error ? (
        <div className="mt-2">
          <Notice tone="warn">{error}</Notice>
        </div>
      ) : null}
    </Section>
  );
}
