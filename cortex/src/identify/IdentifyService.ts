// INTEGRATION: IdentifyService (implements Identifier)
// IN:  the stable banner frame from SceneGate, via
//      SessionOrchestrator -> identifier.identify(jpegBuffer)
// OUT: IdentifyResult { corpusId, nameGuess, confidence } (C2). corpusId is
//      guaranteed to be a member of the injected corpus list or null.
//      confidence < CONF_THRESHOLD -> orchestrator silences the lens and logs
//      a "silenced_identify" dashboard event (D13).
// WIRE: const corpus = await contextService.identifyCorpus();   // or a seed load
//       new IdentifyService(corpus) in cortex/src/index.ts.
//       The corpus list is baked into a byte-stable system prompt AT
//       CONSTRUCTION — rebuild the service (not the prompt) if the corpus
//       changes, so prompt caching keeps working (DESIGN.md §2).

import { IdentifyResultSchema } from "@wingman/shared";
import type { IdentifyResult } from "@wingman/shared";
import type { Identifier } from "../interfaces.js";
import { opusParse, opusVisionContent } from "../llm/anthropic.js";

/** One corpus candidate the model is allowed to choose from. */
export interface IdentifyCorpusEntry {
  companyId: string;
  name: string;
  aliases: string[];
}

/**
 * C2 rules — byte-stable module constant. The corpus list is appended below it
 * deterministically (see formatCorpusList) so the whole system prompt is
 * cache-stable across every call for a given corpus (DESIGN.md §2).
 */
export const IDENTIFY_RULES = `You identify which employer's booth a career-fair attendee is looking at, from a single first-person frame taken by their smart glasses.

Rules:
- Read the banner, signage, table cloth, backdrop or booth number in the frame. Company-level identification only: never describe, identify or reason about any person in the frame.
- Choose the single best match from the CORPUS list below. Set corpusId to that entry's exact id. An id you invent, or any id not in the list, is a hard error.
- If the visible branding clearly belongs to an employer that is NOT in the CORPUS list, set corpusId to null and put the organization name you read in nameGuess.
- If you can match the corpus, still fill nameGuess with the name as it appears in the frame.
- If no employer branding is legible at all, set corpusId and nameGuess to null and confidence to 0.
- confidence is your probability that the named employer is genuinely the booth in view: 0.9+ only for a clearly legible, unambiguous logo or wordmark; 0.6-0.8 for a partial, angled, blurred or distant read; below 0.6 when you are guessing from colours, shapes or context. Do not inflate it — anything under 0.6 shows the wearer nothing at all.

CORPUS (id | name | aliases):`;

/** Deterministic, sorted rendering so the system prompt is byte-stable. */
export function formatCorpusList(corpus: IdentifyCorpusEntry[]): string {
  return [...corpus]
    .sort((a, b) => (a.companyId < b.companyId ? -1 : a.companyId > b.companyId ? 1 : 0))
    .map((c) => {
      const aliases = [...c.aliases].sort().join(", ");
      return `${c.companyId} | ${c.name} | ${aliases}`;
    })
    .join("\n");
}

export function buildIdentifySystemPrompt(corpus: IdentifyCorpusEntry[]): string {
  const list = corpus.length > 0 ? formatCorpusList(corpus) : "(empty — always answer with corpusId null)";
  return `${IDENTIFY_RULES}\n${list}`;
}

/** Byte-stable user instruction; the frame image comes FIRST (helper). */
export const IDENTIFY_USER_TEXT =
  "Identify the employer whose booth this frame shows. Answer with the structured result only.";

export class IdentifyService implements Identifier {
  private readonly system: string;
  private readonly ids: Set<string>;
  private readonly maxTokens: number;

  constructor(corpus: IdentifyCorpusEntry[], opts: { maxTokens?: number } = {}) {
    // Built ONCE — this is the cache-stable system prompt (DESIGN.md §2).
    this.system = buildIdentifySystemPrompt(corpus);
    this.ids = new Set(corpus.map((c) => c.companyId));
    this.maxTokens = opts.maxTokens ?? 512;
  }

  /** Exposed for the prompt-stability test and for cache debugging. */
  get systemPrompt(): string {
    return this.system;
  }

  async identify(frameJpeg: Buffer): Promise<IdentifyResult> {
    const result = await opusParse({
      system: this.system,
      content: opusVisionContent(frameJpeg.toString("base64"), IDENTIFY_USER_TEXT),
      schema: IdentifyResultSchema,
      effort: "low",
      maxTokens: this.maxTokens,
    });

    // C2 hard rule: corpusId must come from the provided list or be null.
    if (result.corpusId != null && !this.ids.has(result.corpusId)) {
      return { ...result, corpusId: null };
    }
    return result;
  }
}
