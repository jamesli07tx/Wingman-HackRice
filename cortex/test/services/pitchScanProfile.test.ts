// PitchService (C4), ScanService (C5), ProfileService (C6) — prompt shape,
// fixed fields, and DB mapping. Anthropic helpers mocked; no network, no keys.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileSummary } from "@wingman/shared";

const { opusParse, opusVisionContent, pdfContent } = vi.hoisted(() => ({
  opusParse: vi.fn(),
  opusVisionContent: vi.fn((b64: string, text: string) => [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
    { type: "text", text },
  ]),
  pdfContent: vi.fn((b64: string, text: string) => [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
    { type: "text", text },
  ]),
}));
vi.mock("../../src/llm/anthropic.js", () => ({
  opusParse,
  opusVisionContent,
  pdfContent,
  haikuClassify: vi.fn(),
}));

import { PITCH_SUBTITLE, PITCH_SYSTEM_PROMPT, PitchService } from "../../src/pitch/PitchService.js";
import { SCAN_SYSTEM_PROMPT, ScanService } from "../../src/scan/ScanService.js";
import { ProfileService, RESUME_SYSTEM_PROMPT } from "../../src/profile/ProfileService.js";
import { makeFakeSupabase } from "./fakes.js";
import type { CompanyContext } from "../../src/interfaces.js";

const PROFILE: ProfileSummary = {
  name: "James Li",
  headline: "CS @ UT Austin, class of 2027",
  skills: ["TypeScript", "Python"],
  experiences: [{ org: "Guadaloop", role: "Software lead", highlight: "Built telemetry pipeline" }],
  interests: ["fintech infrastructure"],
  links: { github: "https://github.com/x" },
};

const COMPANY: CompanyContext = {
  companyId: "stripe",
  displayName: "Stripe",
  card: {
    title: "Stripe",
    subtitle: "Payments infrastructure",
    lines: ["Hiring: SWE Intern", "Stack: Ruby, Go", "Recently: billing APIs"],
  },
  record: null,
};

beforeEach(() => {
  opusParse.mockReset();
  opusVisionContent.mockClear();
  pdfContent.mockClear();
});

describe("PitchService (C4)", () => {
  it("forces title = company name and subtitle = 'Your pitch'", async () => {
    opusParse.mockResolvedValue({
      title: "STRIPE PAYMENTS",
      subtitle: "About you",
      lines: ["Telemetry pipeline @ Guadaloop", "TypeScript + Python daily", "Want: billing infra work"],
    });

    const page = await new PitchService().pitchPage(PROFILE, COMPANY);

    expect(page.title).toBe("Stripe");
    expect(page.subtitle).toBe(PITCH_SUBTITLE);
    expect(page.lines).toHaveLength(3);
  });

  it("truncates a long company name to 28 characters", async () => {
    opusParse.mockResolvedValue({ title: "x", subtitle: "y", lines: ["a", "b", "c"] });
    const page = await new PitchService().pitchPage(PROFILE, {
      ...COMPANY,
      displayName: "The Extremely Long Company Name Corporation",
    });
    expect(page.title.length).toBeLessThanOrEqual(28);
  });

  it("passes STUDENT + EMPLOYER material and a system prompt that forbids invention", async () => {
    opusParse.mockResolvedValue({ title: "x", subtitle: "y", lines: ["a", "b", "c"] });
    await new PitchService().pitchPage(PROFILE, COMPANY);

    const call = opusParse.mock.calls[0][0] as { system: string; content: string };
    expect(call.system).toBe(PITCH_SYSTEM_PROMPT);
    expect(call.system).toContain("NEVER invent, embellish, upgrade, or infer experience");
    expect(call.system).toContain("Use ONLY facts present in STUDENT and EMPLOYER");
    expect(call.content).toContain("STUDENT:");
    expect(call.content).toContain("Guadaloop");
    expect(call.content).toContain("EMPLOYER:");
    expect(call.content).toContain("Stripe");
  });
});

describe("ScanService (C5)", () => {
  it("sends the photo first and returns the extraction", async () => {
    const extraction = {
      lines: ["Hiring: SWE Intern", "Apply by Oct 31"],
      roles: ["SWE Intern"],
      deadlines: ["Oct 31 — SWE Intern"],
    };
    opusParse.mockResolvedValue(extraction);
    const photo = Buffer.from("fake-photo");

    const res = await new ScanService().extract(photo);

    expect(res).toEqual(extraction);
    expect(opusVisionContent).toHaveBeenCalledWith(photo.toString("base64"), expect.any(String));
    const call = opusParse.mock.calls[0][0] as { system: string; content: { type: string }[] };
    expect(call.system).toBe(SCAN_SYSTEM_PROMPT);
    expect(call.content[0].type).toBe("image");
  });
});

describe("ProfileService (C6)", () => {
  it("parses a resume PDF and upserts profiles.summary without touching links", async () => {
    opusParse.mockResolvedValue(PROFILE);
    const supabase = makeFakeSupabase(() => ({ data: null, error: null }));

    const profile = await new ProfileService(supabase.client).parseResume("user_1", Buffer.from("%PDF"));

    expect(profile).toEqual(PROFILE);
    expect(pdfContent).toHaveBeenCalledWith(Buffer.from("%PDF").toString("base64"), expect.any(String));
    expect((opusParse.mock.calls[0][0] as { system: string }).system).toBe(RESUME_SYSTEM_PROMPT);

    const upsert = supabase.calls.find((c) => c.op === "upsert");
    expect(upsert!.table).toBe("profiles");
    const payload = upsert!.args[0] as Record<string, unknown>;
    expect(payload.user_id).toBe("user_1");
    expect(payload.summary).toEqual(PROFILE);
    expect(payload).not.toHaveProperty("links");
    expect(upsert!.args[1]).toEqual({ onConflict: "user_id" });
  });

  it("setLinks keeps only the four known link fields", async () => {
    const supabase = makeFakeSupabase(() => ({ data: null, error: null }));
    await new ProfileService(supabase.client).setLinks("user_1", {
      github: " https://github.com/x ",
      website: "",
      linkedin: undefined,
    });

    const payload = supabase.calls.find((c) => c.op === "upsert")!.args[0] as Record<string, unknown>;
    expect(payload.links).toEqual({ github: "https://github.com/x" });
    expect(payload).not.toHaveProperty("summary");
  });

  it("getProfile maps snake_case row and tolerates a null/invalid summary", async () => {
    const ok = makeFakeSupabase(() => ({
      data: { summary: PROFILE, links: { github: "https://github.com/x" } },
      error: null,
    }));
    expect(await new ProfileService(ok.client).getProfile("user_1")).toEqual({
      profile: PROFILE,
      links: { github: "https://github.com/x" },
    });

    const empty = makeFakeSupabase(() => ({ data: { summary: null, links: null }, error: null }));
    expect(await new ProfileService(empty.client).getProfile("user_1")).toEqual({
      profile: null,
      links: {},
    });

    const missing = makeFakeSupabase(() => ({ data: null, error: null }));
    expect(await new ProfileService(missing.client).getProfile("nobody")).toEqual({
      profile: null,
      links: {},
    });
  });

  it("throws a clear error when the upsert fails", async () => {
    opusParse.mockResolvedValue(PROFILE);
    const supabase = makeFakeSupabase(() => ({ data: null, error: { message: "permission denied" } }));
    await expect(
      new ProfileService(supabase.client).parseResume("user_1", Buffer.from("%PDF")),
    ).rejects.toThrow(/permission denied/);
  });
});
