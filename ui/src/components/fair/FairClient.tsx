"use client";

// Fair list drop-in (design grill 2026-09-12): before a fair, paste the public
// exhibitor/sponsor link or upload a screenshot of the roster. Cortex builds a
// card per company now and adds the names to what the glasses can recognize.
// Anything not on the list still goes through live search at the booth.
// NEW FILES ONLY: no existing console file is edited (the UI redesign owns
// those). Reach this page at /fair until a NavBar link lands after the merge.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Chip, Input, Notice, Section, Spinner } from "@/components/ui";
import { describeError } from "@/lib/api";
import { useCortexAuth } from "@/lib/auth";
import { CLERK_ENABLED, CORTEX_CONFIGURED } from "@/lib/env";
import {
  LinkFailedError,
  getImport,
  importFromImage,
  importFromLink,
  listCompaniesOnFile,
  listImports,
} from "./fairApi";
import type { CompanyImportStatus, FairCompanyOnFile, FairImport } from "./types";

type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

const STATUS_CHIP: Record<CompanyImportStatus, { label: string; tone: Tone }> = {
  pending: { label: "pending", tone: "neutral" },
  matched: { label: "on file", tone: "accent" },
  enriched: { label: "card built", tone: "good" },
  failed: { label: "failed", tone: "bad" },
};

const IMPORT_CHIP: Record<FairImport["status"], { label: string; tone: Tone }> = {
  enriching: { label: "building cards…", tone: "warn" },
  done: { label: "done", tone: "good" },
  failed: { label: "failed", tone: "bad" },
};

function isRunning(imp: FairImport | null | undefined): boolean {
  return imp?.status === "enriching";
}

export function FairClient() {
  const { getToken, isLoaded, isSignedIn } = useCortexAuth();
  const [fairName, setFairName] = useState("");
  const [url, setUrl] = useState("");
  const [linkDisabled, setLinkDisabled] = useState(false);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"link" | "image" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<FairImport | null>(null);
  const [onFile, setOnFile] = useState<FairCompanyOnFile[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const ready = CORTEX_CONFIGURED && (!CLERK_ENABLED || (isLoaded && isSignedIn));

  const refreshOnFile = useCallback(async () => {
    try {
      const r = await listCompaniesOnFile(getToken);
      setOnFile(Array.isArray(r?.companies) ? r.companies : []);
    } catch {
      /* backend offline: the section simply stays empty */
    }
  }, [getToken]);

  // First load: what is on file, and any import still running in cortex.
  useEffect(() => {
    if (!ready) return;
    void refreshOnFile();
    listImports(getToken)
      .then((r) => {
        const imports = Array.isArray(r?.imports) ? r.imports : [];
        const pick = imports.find(isRunning) ?? imports[0] ?? null;
        setCurrent((c) => c ?? pick);
      })
      .catch(() => {});
  }, [ready, getToken, refreshOnFile]);

  // Poll the running import; stop polling on its own once it settles.
  const runningId = current && isRunning(current) ? current.importId : null;
  useEffect(() => {
    if (!runningId) return;
    const timer = window.setInterval(async () => {
      try {
        const r = await getImport(getToken, runningId);
        setCurrent(r.import);
        if (!isRunning(r.import)) void refreshOnFile();
      } catch {
        /* transient: keep polling */
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [runningId, getToken, refreshOnFile]);

  const runLink = async () => {
    const target = url.trim();
    if (!target) return;
    setError(null);
    setBusy("link");
    try {
      const r = await importFromLink(getToken, { url: target, fairName: fairName.trim() || undefined });
      setCurrent(r.import);
      setLinkMessage(null);
    } catch (err) {
      if (err instanceof LinkFailedError) {
        // Design decision (grill Q5): disabled for the rest of this visit; a reload re-enables it.
        setLinkDisabled(true);
        setLinkMessage(`That link did not work: ${err.message}. Upload an image of the list instead.`);
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(null);
    }
  };

  const runImage = async () => {
    if (!file) return;
    setError(null);
    setBusy("image");
    try {
      const r = await importFromImage(getToken, file, fairName.trim() || undefined);
      setCurrent(r.import);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const byFair = new Map<string, FairCompanyOnFile[]>();
  for (const c of onFile) {
    for (const f of c.fairs) {
      const list = byFair.get(f.name) ?? [];
      list.push(c);
      byFair.set(f.name, list);
    }
  }

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Fair list</h1>
        <p className="text-xs opacity-60">
          Drop in who is exhibiting before you go. Wingman builds their cards now and adds the
          names to what the glasses recognize. Anything not on the list still gets looked up live at
          the booth.
        </p>
      </div>

      {!CORTEX_CONFIGURED ? (
        <div className="mb-4">
          <Notice tone="warn">Cortex URL is not configured (NEXT_PUBLIC_CORTEX_URL).</Notice>
        </div>
      ) : null}
      {CLERK_ENABLED && isLoaded && !isSignedIn ? (
        <div className="mb-4">
          <Notice tone="warn">Sign in to import a fair list.</Notice>
        </div>
      ) : null}

      <Section
        title="Import"
        hint="Paste the public exhibitor or sponsor page, or upload a screenshot of the roster."
      >
        <label className="mb-1 block text-xs opacity-70" htmlFor="fair-name">
          Fair name (optional, read from the page when blank)
        </label>
        <Input
          id="fair-name"
          value={fairName}
          onChange={(e) => setFairName(e.target.value)}
          placeholder="e.g. HackRice 16"
          disabled={busy !== null}
        />

        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={linkDisabled ? "Link import disabled for this visit" : "https://…"}
            aria-label="Exhibitor list link"
            disabled={linkDisabled || busy !== null}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !linkDisabled && busy === null) void runLink();
            }}
          />
          <Button
            variant="primary"
            disabled={!ready || linkDisabled || busy !== null || url.trim().length === 0}
            onClick={() => void runLink()}
          >
            {busy === "link" ? <Spinner label="Reading page…" /> : "Import from link"}
          </Button>
        </div>
        {linkMessage ? (
          <div className="mt-2">
            <Notice tone="warn">{linkMessage}</Notice>
          </div>
        ) : null}

        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="Exhibitor list image"
            disabled={busy !== null}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:px-3 file:py-2 file:text-sm file:font-medium"
          />
          <Button
            variant="primary"
            disabled={!ready || !file || busy !== null}
            onClick={() => void runImage()}
          >
            {busy === "image" ? <Spinner label="Reading image…" /> : "Import from image"}
          </Button>
        </div>
        {error ? (
          <div className="mt-2">
            <Notice tone="bad">{error}</Notice>
          </div>
        ) : null}
      </Section>

      {current ? (
        <Section
          title={current.fairName}
          hint={`${current.source === "link" ? "From link" : "From image"} · ${current.sourceRef}`}
          right={<Chip tone={IMPORT_CHIP[current.status].tone}>{IMPORT_CHIP[current.status].label}</Chip>}
        >
          <div className="mb-2 flex items-center justify-between text-xs opacity-70">
            <span>
              {current.done}/{current.total} processed
            </span>
            {current.reloaded ? (
              <span>Identify list reloaded · {current.corpusSize ?? "?"} companies known</span>
            ) : isRunning(current) ? (
              <span>Cards are pre-built now so the booth is instant</span>
            ) : null}
          </div>
          <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-black/10">
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300"
              style={{ width: `${current.total > 0 ? Math.round((current.done / current.total) * 100) : 0}%` }}
            />
          </div>
          {current.error ? (
            <div className="mb-2">
              <Notice tone="warn">{current.error}</Notice>
            </div>
          ) : null}
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {current.companies.map((c) => (
              <li key={`${current.importId}-${c.name}`} className="flex items-center justify-between gap-2 py-1">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{c.name}</span>
                  {c.note ? <span className="block truncate text-[11px] opacity-60">{c.note}</span> : null}
                </span>
                <Chip tone={STATUS_CHIP[c.status].tone}>{STATUS_CHIP[c.status].label}</Chip>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="On file" hint="Companies already tagged with a fair. These are instant at the booth.">
        {byFair.size === 0 ? (
          <p className="text-xs opacity-60">No fair lists imported yet.</p>
        ) : (
          <div className="space-y-3">
            {[...byFair.entries()].map(([fair, companies]) => (
              <div key={fair}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-sm font-medium">{fair}</span>
                  <Chip tone="neutral">{companies.length}</Chip>
                </div>
                <p className="text-xs leading-relaxed opacity-70">
                  {companies.map((c) => c.name).join(" · ")}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
