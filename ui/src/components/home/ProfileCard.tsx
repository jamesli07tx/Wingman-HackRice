"use client";

// D8: resume PDF + LinkedIn/X/GitHub/personal-site URLs are collected here. Cortex
// parses the PDF once at upload (ProfileSummary, DESIGN.md §4.1) and pre-loads the
// result into every session, which is what makes the pitch page fast (D7/F6).
// Collapsed by default once a profile exists — setup UI, not demo UI.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProfileLinks, ProfileSummary } from "@wingman/shared";
import { describeError, getProfile, putProfileLinks, uploadResume } from "@/lib/api";
import { useCortexAuth } from "@/lib/auth";
import { Button, Chip, Input, Notice, SkeletonRows, Spinner } from "@/components/ui";

const LINK_FIELDS: Array<{ key: keyof ProfileLinks; label: string; placeholder: string }> = [
  { key: "linkedin", label: "LinkedIn", placeholder: "https://linkedin.com/in/…" },
  { key: "x", label: "X", placeholder: "https://x.com/…" },
  { key: "github", label: "GitHub", placeholder: "https://github.com/…" },
  { key: "website", label: "Website", placeholder: "https://…" },
];

export function ProfileCard() {
  const { getToken } = useCortexAuth();
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [links, setLinks] = useState<ProfileLinks>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [savingLinks, setSavingLinks] = useState(false);
  const [linksMsg, setLinksMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const openTouched = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getProfile(getToken);
      setProfile(data?.profile ?? null);
      setLinks(data?.links ?? {});
      setLoadError(null);
      // First load decides the default: expanded only when setup is still needed.
      if (!openTouched.current) setOpen(!data?.profile);
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const res = await uploadResume(getToken, file);
      if (res?.profile) setProfile(res.profile);
      else await load();
    } catch (err) {
      setUploadError(describeError(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const saveLinks = async () => {
    setSavingLinks(true);
    setLinksMsg(null);
    try {
      const cleaned: ProfileLinks = {};
      for (const { key } of LINK_FIELDS) {
        const v = links[key]?.trim();
        if (v) cleaned[key] = v;
      }
      await putProfileLinks(getToken, cleaned);
      setLinksMsg("Saved.");
    } catch (err) {
      setLinksMsg(describeError(err));
    } finally {
      setSavingLinks(false);
    }
  };

  return (
    <section
      className="anim-rise mb-6 rounded-lg bg-[var(--panel)] shadow-[var(--shadow-2)]"
      style={{ animationDelay: "80ms" }}
    >
      {/* disclosure header */}
      <button
        onClick={() => {
          openTouched.current = true;
          setOpen((v) => !v);
        }}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-6 py-5 text-left transition-colors duration-150 hover:bg-[var(--panel-2)]/50"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <h2 className="text-xl font-bold">Profile</h2>
          <p className="mt-0.5 truncate text-[13px] text-[var(--muted)]">
            {loading
              ? "Loading…"
              : profile
                ? `${profile.name} — ${profile.headline}`
                : "Upload a resume to power the pitch page"}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {!loading &&
            (profile ? <Chip tone="good">parsed</Chip> : <Chip tone="warn">not set up</Chip>)}
          <span
            className={`text-[14px] text-[var(--faint)] transition-transform duration-200 ${open ? "rotate-90" : ""}`}
            style={{ transitionTimingFunction: "var(--ease)" }}
          >
            ›
          </span>
        </span>
      </button>

      <div className="reveal" data-open={open}>
        <div>
          <div className="border-t border-[var(--rule)] px-5 pb-5 pt-4">
            {loadError ? (
              <div className="mb-3">
                <Notice tone="warn">{loadError}</Notice>
              </div>
            ) : null}

            {/* Resume */}
            <div className="mb-4">
              <label className="mb-1.5 block text-[12px] font-medium text-[var(--muted)]">
                Resume (PDF)
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  disabled={uploading}
                  onChange={(e) => void onFile(e.target.files?.[0])}
                  className="block w-full max-w-full text-[12px] text-[var(--muted)] file:mr-3 file:rounded-full file:border-0 file:bg-[var(--panel-2)] file:px-4 file:py-2 file:text-[12px] file:font-medium file:text-[var(--fg)] hover:file:brightness-110 sm:w-auto"
                />
                {uploading ? <Spinner label="Parsing resume…" /> : null}
              </div>
              {uploadError ? (
                <div className="mt-2">
                  <Notice tone="warn">{uploadError}</Notice>
                </div>
              ) : null}
            </div>

            {/* Parsed summary */}
            <div className="mb-4 rounded-xl bg-[var(--ground)] p-4">
              {loading ? (
                <SkeletonRows rows={3} height={20} />
              ) : profile ? (
                <div className="space-y-2.5">
                  <div>
                    <div className="text-[16px] font-bold">{profile.name}</div>
                    <div className="text-[12px] text-[var(--muted)]">{profile.headline}</div>
                  </div>
                  {profile.skills?.length ? (
                    <div className="flex flex-wrap gap-1">
                      {profile.skills.slice(0, 12).map((s) => (
                        <Chip key={s}>{s}</Chip>
                      ))}
                    </div>
                  ) : null}
                  {profile.experiences?.length ? (
                    <ul className="space-y-1.5 text-[13px] leading-snug">
                      {profile.experiences.slice(0, 5).map((e, i) => (
                        <li key={`${e.org}-${i}`}>
                          <span className="font-medium">{e.org}</span>
                          <span className="text-[var(--muted)]"> · {e.role}</span>
                          <div className="text-[12px] text-[var(--muted)]">{e.highlight}</div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {profile.interests?.length ? (
                    <div className="text-[12px] text-[var(--faint)]">
                      Interests: {profile.interests.join(", ")}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-[13px] text-[var(--muted)]">
                  No parsed profile yet — upload a resume PDF above.
                </p>
              )}
            </div>

            {/* Links */}
            <div className="grid gap-2.5 sm:grid-cols-2">
              {LINK_FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="mb-1 block text-[12px] font-medium text-[var(--muted)]">
                    {f.label}
                  </span>
                  <Input
                    type="url"
                    inputMode="url"
                    placeholder={f.placeholder}
                    value={links[f.key] ?? ""}
                    onChange={(e) => setLinks((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <Button variant="primary" onClick={() => void saveLinks()} disabled={savingLinks}>
                {savingLinks ? "Saving…" : "Save links"}
              </Button>
              {linksMsg ? (
                <span className="anim-swap text-[12px] text-[var(--muted)]">{linksMsg}</span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
