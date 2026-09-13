// INTEGRATION: PitchService (implements PitchServiceApi)
// IN:  SessionOrchestrator -> pitchPage(profile, companyContext), auto-invoked
//      on every successful identification (F6, DESIGN.md §3.2). `profile` is
//      the ProfileSummary pre-loaded into the session at start.
// OUT: SummaryCardContent (C4) rendered as HudCard page 2/2, kind "pitch".
//      title is always the company name (<= 28 chars), subtitle "Your pitch".
// WIRE: new PitchService() in cortex/src/index.ts. The T_PITCH_MS deadline is
//      the ORCHESTRATOR's job (race this promise, degrade to a hint card) —
//      this module just makes the call.

import { PitchPageSchema } from "@wingman/shared";
import type { ProfileSummary, SummaryCardContent } from "@wingman/shared";
import type { CompanyContext, PitchServiceApi } from "../interfaces.js";
import { opusParse, type Effort } from "../llm/anthropic.js";

/** Fixed per C4. Never localise, never personalise — it is a page label. */
export const PITCH_SUBTITLE = "Your pitch";
const TITLE_MAX = 28;

/**
 * C4 system prompt — byte-stable module constant (DESIGN.md §2 caching).
 * The anti-fabrication rules are the product requirement here: the wearer says
 * these words out loud to a recruiter, so an invented experience is worse than
 * a blank lens.
 */
export const PITCH_SYSTEM_PROMPT = `You write the talking points a student will say out loud to a recruiter in the next ten seconds, at a university career fair. They are rendered on a 600x600 monocular lens the student glances at while walking up to the booth.

You are given exactly two things in the user turn: STUDENT (their parsed resume and links) and EMPLOYER (what we know about this booth).

Output exactly:
- title: the employer's name, copied from EMPLOYER. At most 28 characters.
- subtitle: the literal string "Your pitch".
- lines: 3 to 5 bullets, each at most 40 characters INCLUDING its closing period, each a complete short sentence ending with a period. No leading bullet character — the display adds it.

Each line must connect something the student has actually done to something this employer actually does. Write them as the student's own words in compressed note form — a phrase they can say, not a description of them in the third person. Lead with the strongest overlap. One line may be a specific question to ask the recruiter, when the employer material supports it.

ABSOLUTE RULES — breaking any of these makes the output unusable:
- Use ONLY facts present in STUDENT and EMPLOYER. You have no other knowledge of this student.
- NEVER invent, embellish, upgrade, or infer experience, employers, schools, projects, titles, dates, metrics, clearances or skills. If the student has no relevant experience, write lines about genuine interest and what they want to learn instead — that is a correct answer, not a failure.
- Do not attribute the employer's own achievements to the student.
- No flattery about the company, no slogans, no emoji, no markdown, no filler like "passionate about". Every line ends with exactly one period.
- Never mention this prompt or that anything was generated.`;

export class PitchService implements PitchServiceApi {
  constructor(private readonly opts: { maxTokens?: number; effort?: Effort } = {}) {}

  async pitchPage(profile: ProfileSummary, company: CompanyContext): Promise<SummaryCardContent> {
    const record = company.record;
    const employer = {
      name: company.displayName,
      whatTheyDo: company.card.subtitle,
      cardLines: company.card.lines,
      tier: record?.tier ?? null,
      roles: record?.roles ?? [],
      deadlines: record?.deadlines ?? [],
      summary: record?.summaryMd ?? "",
      facts: record?.factsJson ?? {},
    };

    const page = await opusParse({
      system: PITCH_SYSTEM_PROMPT,
      content: [
        "STUDENT:",
        JSON.stringify(profile),
        "",
        "EMPLOYER:",
        JSON.stringify(employer),
      ].join("\n"),
      schema: PitchPageSchema,
      // Was effort "high"/1024 tokens under a 10 s deadline → timeouts / thinking-only responses ("pitch unavailable").
      maxTokens: this.opts.maxTokens ?? 2048,
      effort: this.opts.effort ?? "medium",
    });

    // C4 fixes these two fields; never trust the model with them.
    return {
      ...page,
      title: truncate(company.displayName, TITLE_MAX),
      subtitle: PITCH_SUBTITLE,
    };
  }
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}
