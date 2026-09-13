// Fair list import — DTOs (ADDITIVE feature, isolated in cortex/src/fairs/).
// The console's copy lives in console/src/components/fair/types.ts and is kept
// in sync by hand: @wingman/shared is frozen (DESIGN_WINDOWS.md §0) and nothing
// here crosses the glasses boundary — no HudCard, no device message changes.

export type ImportSource = "link" | "image";
export type ImportStatus = "enriching" | "done" | "failed";
export type CompanyImportStatus = "pending" | "matched" | "enriched" | "failed";

/** One organization from the dropped-in list, tracked through the import. */
export interface ImportCompany {
  name: string;
  aliases: string[];
  /** companies.company_id once matched or created; null while pending / on failure */
  companyId: string | null;
  status: CompanyImportStatus;
  note: string | null;
}

export interface FairImport {
  importId: string;
  fairName: string;
  source: ImportSource;
  /** the URL, or the uploaded image's filename */
  sourceRef: string;
  status: ImportStatus;
  createdAt: string;
  finishedAt: string | null;
  companies: ImportCompany[];
  done: number;
  total: number;
  /** true once the live identify candidate list has been rebuilt to include this import */
  reloaded: boolean;
  corpusSize: number | null;
  error: string | null;
}

/** Why the "link" entry point could not be used — the console disables the link
 *  field on any of these and asks for an image instead (design grill Q5). */
export type LinkFailureReason =
  | "invalid_url"
  | "fetch_failed"
  | "timeout"
  | "http_error"
  | "empty_page"
  | "no_companies";

export interface LinkFailure {
  error: "link_failed";
  reason: LinkFailureReason;
  message: string;
}

export interface FairTag {
  name: string;
  source: string;
  importedAt: string;
}

/** A companies row that carries at least one fair tag (facts_json.fairs). */
export interface FairCompanyOnFile {
  companyId: string;
  name: string;
  fairs: FairTag[];
  hasCard: boolean;
  updatedAt: string;
}
