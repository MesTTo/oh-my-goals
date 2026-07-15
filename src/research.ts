// The research worker: the acquisition side of the literature assistant. It
// fetches a paper's metadata, full text, and references, and reports a DOI's
// retraction status, by wrapping proven tools (GROBID through scipdf_parser for
// PDFs, Crossref for metadata and retraction status, arXiv for preprints). The
// worker itself is a resident Python subprocess driven over line-framed JSON,
// the same pattern the HyperBase parser uses; this module is the typed interface
// the MCP tools call, so a fake stands in for it in unit tests and the real
// subprocess (src/research_worker.ts) is gated on GROBID and network in live tests.

import type { BibliographicFields } from "./bibliography.js";

/** Bibliographic metadata for one work, however the worker resolved it. */
export interface WorkMetadata extends BibliographicFields {
  readonly title: string;
}

/** One section of a parsed paper: a heading and its text. */
export interface ParsedSection {
  readonly heading: string;
  readonly text: string;
}

/** One entry from a paper's reference list. */
export interface ParsedReference {
  readonly raw: string;
  readonly title?: string;
  readonly doi?: string;
}

/** A fetched and parsed paper. Sections and references are empty when GROBID is
 * unavailable and only metadata could be resolved. */
export interface ParsedPaper {
  readonly metadata: WorkMetadata;
  readonly sections: readonly ParsedSection[];
  readonly references: readonly ParsedReference[];
}

/** A DOI's editorial status from Crossref, mapping its update types onto the
 * work statuses. `active` means no retraction or correction was found. */
export interface RetractionRecord {
  readonly doi: string;
  readonly status: "active" | "retracted" | "corrected" | "concern" | "withdrawn";
  readonly notice?: string;
  readonly date?: string;
}

/** The acquisition interface the MCP tools depend on. Later slices extend it with
 * search and citation traversal; this is the ingest-and-retract spine. */
export interface ResearchWorker {
  /** Fetch and parse a paper by DOI or arXiv id. */
  fetchAndParse(id: string): Promise<ParsedPaper>;
  /** The editorial status of each DOI, from Crossref. */
  retractionStatus(dois: readonly string[]): Promise<readonly RetractionRecord[]>;
  /** Release the subprocess. */
  close(): Promise<void>;
}

/** Raised when a worker command runs without the worker being configured. Like
 * the parser, configuration is checked at call time, not construction time, so a
 * server that never ingests a paper needs no research backend. */
export class ResearchWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchWorkerError";
  }
}
