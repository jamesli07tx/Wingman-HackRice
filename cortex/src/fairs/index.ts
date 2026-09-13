// Fair list import — the ONE folder this feature lives in (design grill Q4b).
// cortex/src/index.ts wires it with a single additive block that reuses the
// bootstrap's own corpus loader and swappable identifier proxy:
//
//   const fairs = createFairImportService({
//     supabase, tavilyApiKey: process.env.TAVILY_API_KEY, logger: log,
//     reloadCorpus: async () => {
//       const fresh = await loadCorpus();            // index.ts's retrying loader
//       if (!fresh) throw new Error("corpus reload failed");
//       corpus = fresh;
//       identifierImpl = new IdentifyService(corpus); // the proxy forwards to it
//       return corpus.length;
//     },
//   });
//   await app.register(fairRoutes({ service: fairs, verifyToken }));
//
// SwappableIdentifier + loadIdentifyCorpus below are the standalone equivalents
// used by tools/verify-live.ts (which has no bootstrap to borrow from).
// Nothing else in cortex changes: IdentifyService, SessionOrchestrator,
// ContextService (and its Tavily path), shared/ and corpus/ are untouched.

import type { SupabaseClient } from "@supabase/supabase-js";
import { makeOpusCardWriter, makeTavilyEvidence } from "./enrich.js";
import { extractWithOpus } from "./extract.js";
import { FairImportService, type FairImportLogger } from "./FairImportService.js";
import type { FetchLike } from "./fetchPage.js";

export { SwappableIdentifier } from "./SwappableIdentifier.js";
export { loadIdentifyCorpus } from "./corpus.js";
export { fairRoutes } from "./routes.js";
export { FairImportService } from "./FairImportService.js";
export type * from "./types.js";

export interface CreateFairImportOptions {
  supabase: SupabaseClient;
  reloadCorpus: () => Promise<number>;
  tavilyApiKey?: string;
  /** defaults to global fetch */
  fetchImpl?: FetchLike;
  logger?: FairImportLogger;
  concurrency?: number;
}

/** Production wiring: opus-5 extractor + Tavily evidence + opus-5 card writer. */
export function createFairImportService(opts: CreateFairImportOptions): FairImportService {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  return new FairImportService({
    supabase: opts.supabase,
    fetchImpl,
    extract: extractWithOpus,
    evidence: makeTavilyEvidence({ fetchImpl, apiKey: opts.tavilyApiKey }),
    writeCard: makeOpusCardWriter(),
    reloadCorpus: opts.reloadCorpus,
    logger: opts.logger,
    concurrency: opts.concurrency,
  });
}
