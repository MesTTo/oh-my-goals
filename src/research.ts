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

/** A search backend the worker queries. Semantic Scholar is keyless but rate
 * limited without a key; OpenAlex is keyless. Search degrades to whichever
 * source answers, so a rate-limited or down source never fails the query. */
export type CandidateSource = "semanticScholar" | "openAlex";

/** One search hit from one source, in that source's own relevance order. */
export interface RawCandidate {
  readonly metadata: WorkMetadata;
  readonly source: CandidateSource;
  readonly citationCount?: number;
}

/** A ranked candidate work: its merged metadata, the sources that returned it,
 * and the fused relevance score used to order results. */
export interface WorkCandidate {
  readonly metadata: WorkMetadata;
  readonly sources: readonly CandidateSource[];
  readonly citationCount?: number;
  readonly score: number;
}

export interface SearchOptions {
  /** Results requested per source. Default 10, capped at 50 by the worker. */
  readonly limit?: number;
  /** Restrict the sources queried. Default both. */
  readonly sources?: readonly CandidateSource[];
}

/** The acquisition interface the MCP tools depend on. Slice 4 extends it with
 * citation traversal; this is the ingest, retract, and search surface. */
export interface ResearchWorker {
  /** Fetch and parse a paper by DOI or arXiv id. */
  fetchAndParse(id: string): Promise<ParsedPaper>;
  /** The editorial status of each DOI, from Crossref. */
  retractionStatus(dois: readonly string[]): Promise<readonly RetractionRecord[]>;
  /** Candidate works for a query, each in its source's relevance order. */
  search(query: string, options?: SearchOptions): Promise<readonly RawCandidate[]>;
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
