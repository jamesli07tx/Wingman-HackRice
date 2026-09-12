// INTEGRATION: ProfileService (implements ProfileServiceApi)
// IN:  rest/routes.ts — POST /api/profile/resume (multipart PDF) ->
//      parseResume(userId, pdfBuffer); PUT /api/profile/links ->
//      setLinks(userId, links); GET /api/profile -> getProfile(userId).
//      SessionOrchestrator calls getProfile(userId) once at session start and
//      holds the ProfileSummary for PitchService (it must not be in the hot path).
// OUT: ProfileSummary (C6), persisted to profiles.summary (jsonb); links to
//      profiles.links (jsonb). snake_case columns per cortex/db/schema.sql.
// WIRE: new ProfileService(supabase) in cortex/src/index.ts (service-role client).

import { ProfileSummarySchema } from "@wingman/shared";
import type { ProfileLinks, ProfileSummary } from "@wingman/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileServiceApi } from "../interfaces.js";
import { opusParse, pdfContent } from "../llm/anthropic.js";

/** C6 system prompt — byte-stable module constant (DESIGN.md §2 caching). */
export const RESUME_SYSTEM_PROMPT = `You convert a student's resume PDF into a compact structured profile that a career-fair copilot uses to write personalized talking points. Accuracy matters more than completeness: every field you emit is spoken out loud to a recruiter by the student.

Output exactly:
- name: the student's full name as printed on the resume.
- headline: one short line of who they are right now — program, school and expected graduation, e.g. "CS @ UT Austin, class of 2027". Use only what the resume states.
- skills: the concrete technologies, languages, tools and domains listed. Most relevant first, at most 20, no soft skills, no proficiency adjectives.
- experiences: the most substantial roles, projects, research or leadership entries, strongest first, at most 6. Each is { org, role, highlight } where highlight is ONE specific accomplishment in at most 120 characters, in the resume's own terms, keeping any metric it states.
- interests: 2 to 6 fields or problem areas the resume actually evidences, phrased as short noun phrases.
- links: an object mapping label to URL for every link printed on the resume — use the keys "github", "linkedin", "x", "website", "scholar" when they apply, else a short lowercase label. Copy URLs exactly. Empty object if there are none.

Hard rules:
- Transcribe and compress only. NEVER invent, upgrade, or infer an employer, title, school, date, degree, metric, clearance or skill that is not printed in the PDF.
- Do not editorialise, rank, or judge the student, and never add flattery.
- Omit personal contact details other than links: no phone number, no street address, no email.
- If a section is absent from the resume, emit an empty array or empty string rather than guessing.`;

export const RESUME_USER_TEXT =
  "Parse this resume into the structured profile. Use only what is printed in it.";

export class ProfileService implements ProfileServiceApi {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly opts: { maxTokens?: number } = {},
  ) {}

  async parseResume(userId: string, pdf: Buffer): Promise<ProfileSummary> {
    const profile = await opusParse({
      system: RESUME_SYSTEM_PROMPT,
      // PDF document block FIRST, instruction last (DESIGN.md §2).
      content: pdfContent(pdf.toString("base64"), RESUME_USER_TEXT) as never,
      schema: ProfileSummarySchema,
      maxTokens: this.opts.maxTokens ?? 4096,
    });

    // Upsert only the columns we own here — `links` is left untouched so a
    // re-upload never clobbers the URLs typed in onboarding.
    const { error } = await this.supabase
      .from("profiles")
      .upsert(
        { user_id: userId, summary: profile, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(`profiles upsert failed: ${error.message}`);
    return profile;
  }

  async setLinks(userId: string, links: ProfileLinks): Promise<void> {
    const clean: ProfileLinks = {};
    for (const key of ["linkedin", "x", "github", "website"] as const) {
      const v = links[key]?.trim();
      if (v) clean[key] = v;
    }
    const { error } = await this.supabase
      .from("profiles")
      .upsert(
        { user_id: userId, links: clean, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(`profiles upsert failed: ${error.message}`);
  }

  async getProfile(userId: string): Promise<{ profile: ProfileSummary | null; links: ProfileLinks }> {
    const { data, error } = await this.supabase
      .from("profiles")
      .select("summary,links")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return { profile: null, links: {} };

    const row = data as { summary: unknown; links: unknown };
    const parsed = ProfileSummarySchema.safeParse(row.summary);
    return {
      profile: parsed.success ? parsed.data : null,
      links: (row.links as ProfileLinks | null) ?? {},
    };
  }
}
