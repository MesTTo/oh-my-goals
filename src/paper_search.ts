// Rank search candidates from more than one source into one ordered list.
//
// Semantic Scholar and OpenAlex each return results in their own relevance order,
// but their relevance scores are on different, incomparable scales (OpenAlex
// reports an unbounded score; Semantic Scholar reports none). So we fuse by rank,
// not by score, using Reciprocal Rank Fusion (Cormack, Clarke & Buettcher, SIGIR
// 2009): a work's fused score is the sum over the sources that returned it of
// 1/(k + rank). RRF needs no score calibration, rewards a work that ranks well in
// several sources, and degrades to a single source's own order when only one
// answers, which is the common case when Semantic Scholar is rate limited.
//
// The same work can arrive from two sources carrying different identifiers (one
// has a DOI, the other only an arXiv id). So records are grouped by union-find
// over every id they share, not by a single "strongest" key, which would split a
// work whose two records disagree on which id is strongest.

import type { CandidateSource, RawCandidate, WorkCandidate, WorkMetadata } from "./research.js";

// The standard RRF constant. Larger k flattens the contribution of top ranks, so
// a work needs agreement across sources, not just one high placement, to rise.
const RRF_K = 60;

const MERGED_KEYS: readonly (keyof WorkMetadata)[] = [
  "doi",
  "arxivId",
  "openAlexId",
  "semanticScholarId",
  "authors",
  "year",
  "venue",
  "abstract",
  "pdfUrl",
];

/** Every external id a record carries, namespaced. Two records that share any of
 * these are the same work. A record with no external id falls back to a
 * normalized-title id, so title only ever merges records that have nothing
 * stronger to disagree on. */
function candidateIds(metadata: WorkMetadata): string[] {
  const ids: string[] = [];
  if (metadata.doi !== undefined) ids.push(`doi:${metadata.doi.toLowerCase()}`);
  if (metadata.arxivId !== undefined) ids.push(`arxiv:${metadata.arxivId.toLowerCase()}`);
  if (metadata.openAlexId !== undefined) ids.push(`openalex:${metadata.openAlexId.toLowerCase()}`);
  if (metadata.semanticScholarId !== undefined) ids.push(`s2:${metadata.semanticScholarId.toLowerCase()}`);
  if (ids.length === 0) ids.push(`title:${metadata.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`);
  return ids;
}

const withField = <K extends keyof WorkMetadata>(
  key: K,
  value: WorkMetadata[K] | undefined,
): Partial<WorkMetadata> => (value !== undefined ? ({ [key]: value } as Partial<WorkMetadata>) : {});

/** Merge two records of the same work: keep the first title, fill each optional
 * field from whichever source has it, preferring the one seen first. */
function mergeMetadata(primary: WorkMetadata, secondary: WorkMetadata): WorkMetadata {
  const merged: Partial<WorkMetadata> = { title: primary.title };
  for (const key of MERGED_KEYS) {
    Object.assign(merged, withField(key, primary[key] ?? secondary[key]));
  }
  return merged as WorkMetadata;
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

interface Accumulator {
  metadata: WorkMetadata;
  readonly sources: Set<CandidateSource>;
  citationCount: number | undefined;
  score: number;
}

// A disjoint-set forest over candidate indices, so records sharing any id fuse
// into one group even when the shared id differs from pair to pair.
class UnionFind {
  readonly #parent: number[];
  constructor(size: number) {
    this.#parent = Array.from({ length: size }, (_, index) => index);
  }
  find(x: number): number {
    let root = x;
    while (this.#parent[root] !== root) root = this.#parent[root]!;
    while (this.#parent[x] !== root) {
      const next = this.#parent[x]!;
      this.#parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.#parent[rootA] = rootB;
  }
}

/** Fuse per-source candidate lists into one ranked, de-duplicated list.
 *
 * Each candidate's position among its own source's results is its rank, so the
 * input must arrive in per-source relevance order (the worker returns it that
 * way). Ties break by citation count, then title, for a deterministic order. */
export function rankCandidates(raw: readonly RawCandidate[], limit: number): WorkCandidate[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError("limit must be a non-negative integer");
  }
  // A candidate's rank is its position among its own source's results.
  const nextRank = new Map<CandidateSource, number>();
  const contributions = raw.map((candidate) => {
    const rank = nextRank.get(candidate.source) ?? 0;
    nextRank.set(candidate.source, rank + 1);
    return 1 / (RRF_K + rank + 1);
  });

  // Union records that share any external id.
  const groups = new UnionFind(raw.length);
  const idOwner = new Map<string, number>();
  raw.forEach((candidate, index) => {
    for (const id of candidateIds(candidate.metadata)) {
      const owner = idOwner.get(id);
      if (owner !== undefined) groups.union(index, owner);
      else idOwner.set(id, index);
    }
  });

  // Accumulate each group's fused score, merged metadata, and sources.
  const byRoot = new Map<number, Accumulator>();
  raw.forEach((candidate, index) => {
    const root = groups.find(index);
    const existing = byRoot.get(root);
    if (existing === undefined) {
      byRoot.set(root, {
        metadata: candidate.metadata,
        sources: new Set([candidate.source]),
        citationCount: candidate.citationCount,
        score: contributions[index]!,
      });
    } else {
      existing.metadata = mergeMetadata(existing.metadata, candidate.metadata);
      existing.sources.add(candidate.source);
      existing.citationCount = maxDefined(existing.citationCount, candidate.citationCount);
      existing.score += contributions[index]!;
    }
  });

  const ranked: WorkCandidate[] = [...byRoot.values()].map((entry) => ({
    metadata: entry.metadata,
    sources: [...entry.sources],
    ...(entry.citationCount !== undefined ? { citationCount: entry.citationCount } : {}),
    score: entry.score,
  }));
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (b.citationCount ?? -1) - (a.citationCount ?? -1) ||
      a.metadata.title.localeCompare(b.metadata.title),
  );
  return ranked.slice(0, limit);
}
