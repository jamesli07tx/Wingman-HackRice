// INTEGRATION: ScanService (implements ScanServiceApi)
// IN:  SessionOrchestrator -> extract(photoJpeg), where the photo is the
//      device's reply to capture_photo (<= DOC_MAX_EDGE_PX, q ~ 0.8) after the
//      gate went "document" x STABILITY_N (F7, DESIGN.md §3.2).
// OUT: ScanExtraction { lines, roles, deadlines } (C5). `lines` renders
//      directly — merged into the current company card set, or a standalone
//      kind:"scan" card when there is no company context. roles/deadlines go
//      to the dashboard feed / company record.
// WIRE: new ScanService() in cortex/src/index.ts. The T_PHOTO_MS / per-stage
//      deadline is the orchestrator's; the photo buffer is discarded by the
//      caller as soon as this resolves (D14 — nothing is persisted).

import { ScanExtractionSchema } from "@wingman/shared";
import type { ScanExtraction } from "@wingman/shared";
import type { ScanServiceApi } from "../interfaces.js";
import { opusParse, opusVisionContent } from "../llm/anthropic.js";

/** C5 system prompt — byte-stable module constant (DESIGN.md §2 caching). */
export const SCAN_SYSTEM_PROMPT = `You read a photo of a recruiting handout — a pamphlet, flyer, one-pager or booth card — that a student is holding up at a university career fair, and pull out only what they need in the next ten seconds. The result is rendered on a 600x600 monocular lens.

Output exactly:
- lines: 1 to 5 bullets, each at most 40 characters, in the order a student cares about: open roles, application deadlines, how to apply (QR/URL/email, shortened), then anything else concrete.
- roles: every distinct job or internship title printed on the handout, verbatim, each at most 60 characters. Empty array if none.
- deadlines: every date or deadline printed on the handout, with what it is for, each at most 60 characters. Empty array if none.

Hard rules:
- Transcribe only what is actually legible in the photo. Never guess a role, date, URL or requirement that is not printed there, and never fill in what you know about the company from elsewhere.
- If a line is partially cut off or blurred, drop it rather than completing it.
- If the photo is not a recruiting handout, or nothing is legible, return one line saying so and empty roles and deadlines.
- Identify no people. No emoji, no markdown, no trailing punctuation on lines.`;

/** Byte-stable user instruction; the photo image comes FIRST (helper). */
export const SCAN_USER_TEXT = "Extract the roles, deadlines and display lines from this handout.";

export class ScanService implements ScanServiceApi {
  constructor(private readonly opts: { maxTokens?: number } = {}) {}

  async extract(photoJpeg: Buffer): Promise<ScanExtraction> {
    return opusParse({
      system: SCAN_SYSTEM_PROMPT,
      content: opusVisionContent(photoJpeg.toString("base64"), SCAN_USER_TEXT),
      schema: ScanExtractionSchema,
      maxTokens: this.opts.maxTokens ?? 1024,
    });
  }
}
