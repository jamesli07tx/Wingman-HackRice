"use client";

// D8: resume PDF + LinkedIn/X/GitHub/personal-site URLs are collected here. Cortex
// parses the PDF once at upload (ProfileSummary, DESIGN.md §4.1) and pre-loads the
// result into every session, which is what makes the pitch page fast (D7/F6).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProfileLinks, ProfileSummary } from "@wingman/shared";
import { describeError, getProfile, putProfileLinks, uploadResume } from "@/lib/api";
import { useCortexAuth } from "@/lib/auth";
import { Button, Chip, Input, Notice, Section, Spinner } from "@/components/ui";

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
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getProfile(getToken);
      setProfile(data?.profile ?? null);
      setLinks(data?.links ?? {});
      setLoadError(null);
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
    <Section
      title="Profile"
      hint="Resume + links feed the pitch page. Parsed once, cached, pre-loaded at session start."
    >
      {loadError ? (
        <div className="mb-3">
          <Notice tone="warn">{loadError}</Notice>
        </div>
      ) : null}

      {/* Resume */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs font-medium text-zinc-400">Resume (PDF)</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            disabled={uploading}
            onChange={(e) => void onFile(e.target.files?.[0])}
            className="block w-full max-w-full text-xs text-zinc-400 file:mr-3 file:rounded-lg file:border file:border-[var(--color-edge)] file:bg-[var(--color-surface-2)] file:px-3 file:py-2 file:text-xs file:text-zinc-200 sm:w-auto"
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
      <div className="mb-4 rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] p-3">
        {loading ? (
          <Spinner label="Loading profile…" />
        ) : profile ? (
          <div className="space-y-2">
            <div>
              <div className="text-sm font-medium text-zinc-100">{profile.name}</div>
              <div className="text-xs text-zinc-500">{profile.headline}</div>
            </div>
            {profile.skills?.length ? (
              <div className="flex flex-wrap gap-1">
                {profile.skills.slice(0, 12).map((s) => (
                  <Chip key={s}>{s}</Chip>
                ))}
              </div>
            ) : null}
            {profile.experiences?.length ? (
              <ul className="space-y-1 text-xs text-zinc-300">
                {profile.experiences.slice(0, 5).map((e, i) => (
                  <li key={`${e.org}-${i}`}>
                    <span className="text-zinc-100">{e.org}</span>
                    <span className="text-zinc-500"> · {e.role}</span>
                    <div className="text-zinc-500">{e.highlight}</div>
                  </li>
                ))}
              </ul>
            ) : null}
            {profile.interests?.length ? (
              <div className="text-[11px] text-zinc-500">
                Interests: {profile.interests.join(", ")}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            No parsed profile yet — upload a resume PDF above.
          </p>
        )}
      </div>

      {/* Links */}
      <div className="grid gap-2 sm:grid-cols-2">
        {LINK_FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-400">{f.label}</span>
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
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" onClick={() => void saveLinks()} disabled={savingLinks}>
          {savingLinks ? "Saving…" : "Save links"}
        </Button>
        {linksMsg ? <span className="text-xs text-zinc-500">{linksMsg}</span> : null}
      </div>
    </Section>
  );
}
