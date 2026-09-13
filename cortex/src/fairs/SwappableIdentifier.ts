// INTEGRATION: SwappableIdentifier (implements Identifier)
// IN:  the boot-time IdentifyService from cortex/src/index.ts; later, a fresh
//      IdentifyService built from the current `companies` table after a fair
//      list import (FairImportService -> reloadCorpus()).
// OUT: identify(frame) delegating to whichever service is current. The
//      orchestrator holds this object for the life of the process and never
//      notices the swap — IdentifyService itself is untouched (its system
//      prompt stays byte-stable per instance, so prompt caching still works;
//      a swap simply starts a new cache lineage).
// WIRE: const identifier = new SwappableIdentifier(new IdentifyService(corpus));

import type { IdentifyResult } from "@wingman/shared";
import type { Identifier } from "../interfaces.js";

export class SwappableIdentifier implements Identifier {
  #current: Identifier;
  #generation = 0;

  constructor(initial: Identifier) {
    this.#current = initial;
  }

  /** Replace the live service. Calls already in flight finish on the old one. */
  swap(next: Identifier): void {
    this.#current = next;
    this.#generation += 1;
  }

  /** How many swaps have happened (0 = still the boot-time service). */
  get generation(): number {
    return this.#generation;
  }

  get current(): Identifier {
    return this.#current;
  }

  identify(frameJpeg: Buffer): Promise<IdentifyResult> {
    return this.#current.identify(frameJpeg);
  }
}
