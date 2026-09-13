// Hand-mirrored from cortex/src/fairs/types.ts (the fair list import DTOs).
// @wingman/shared is frozen (DESIGN_WINDOWS.md §0) and this feature never
// crosses the glasses boundary, so the console keeps its own copy.

export type ImportSource = "link" | "image";
export type ImportStatus = "enriching" | "done" | "failed";
export type CompanyImportStatus = "pending" | "matched" | "enriched" | "failed";

export interface ImportCompany {
  name: string;
  aliases: string[];
  companyId: string | null;
  status: CompanyImportStatus;
  note: string | null;
}

export interface FairImport {
  importId: string;
  fairName: string;
  source: ImportSource;
  sourceRef: string;
  status: ImportStatus;
  createdAt: string;
  finishedAt: string | null;
  companies: ImportCompany[];
  done: number;
  total: number;
  reloaded: boolean;
  corpusSize: number | null;
  error: string | null;
}

export interface FairTag {
  name: string;
  source: string;
  importedAt: string;
}

export interface FairCompanyOnFile {
  companyId: string;
  name: string;
  fairs: FairTag[];
  hasCard: boolean;
  updatedAt: string;
}
