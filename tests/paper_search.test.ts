import { describe, expect, it } from "vitest";

import { rankCandidates } from "../src/paper_search.js";
import type { CandidateSource, RawCandidate } from "../src/research.js";

function candidate(
  source: CandidateSource,
  metadata: RawCandidate["metadata"],
  citationCount?: number,
): RawCandidate {
  return citationCount === undefined ? { source, metadata } : { source, metadata, citationCount };
}

describe("rankCandidates", () => {
  it("fuses ranks so a work returned by both sources outranks single-source works", () => {
    const raw: RawCandidate[] = [
      candidate("semanticScholar", { title: "A", doi: "10.1/a" }),
      candidate("semanticScholar", { title: "B", doi: "10.1/b" }),
      candidate("openAlex", { title: "B", doi: "10.1/b" }),
      candidate("openAlex", { title: "C", doi: "10.1/c" }),
    ];
    const ranked = rankCandidates(raw, 10);
    expect(ranked).toHaveLength(3);
    // B is rank 1 in one source and rank 0 in the other, so its fused score beats
    // A (rank 0 in one source only) and C (rank 1 in one source only).
    expect(ranked[0]!.metadata.title).toBe("B");
    expect(ranked[0]!.sources.sort()).toEqual(["openAlex", "semanticScholar"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("merges two records of one work that share only an arXiv id", () => {
    const raw: RawCandidate[] = [
      candidate("semanticScholar", { title: "Attention", arxivId: "1706.03762", semanticScholarId: "s2id" }, 100),
      candidate("openAlex", { title: "Attention", doi: "10.1/attn", arxivId: "1706.03762", openAlexId: "W1" }, 90),
    ];
    const ranked = rankCandidates(raw, 10);
    expect(ranked).toHaveLength(1);
    const merged = ranked[0]!;
    expect(merged.sources.sort()).toEqual(["openAlex", "semanticScholar"]);
    // The merge unions every identifier and takes the larger citation count.
    expect(merged.metadata.doi).toBe("10.1/attn");
    expect(merged.metadata.arxivId).toBe("1706.03762");
    expect(merged.metadata.openAlexId).toBe("W1");
    expect(merged.metadata.semanticScholarId).toBe("s2id");
    expect(merged.citationCount).toBe(100);
  });

  it("unions records transitively through a chain of shared ids", () => {
    const raw: RawCandidate[] = [
      candidate("semanticScholar", { title: "W", arxivId: "9.9" }),
      candidate("openAlex", { title: "W", arxivId: "9.9", doi: "10.1/w" }),
      candidate("openAlex", { title: "W", doi: "10.1/w" }),
    ];
    // First shares arXiv with second, second shares DOI with third: all one work.
    expect(rankCandidates(raw, 10)).toHaveLength(1);
  });

  it("does not merge distinct works that only share a title when both have ids", () => {
    const raw: RawCandidate[] = [
      candidate("openAlex", { title: "Common Title", doi: "10.1/one" }),
      candidate("openAlex", { title: "Common Title", doi: "10.1/two" }),
    ];
    expect(rankCandidates(raw, 10)).toHaveLength(2);
  });

  it("merges id-less records by normalized title", () => {
    const raw: RawCandidate[] = [
      candidate("semanticScholar", { title: "A Study of Things" }),
      candidate("openAlex", { title: "a study of things!" }),
    ];
    expect(rankCandidates(raw, 10)).toHaveLength(1);
  });

  it("preserves a single source's order and applies the limit", () => {
    const raw: RawCandidate[] = [
      candidate("openAlex", { title: "first", doi: "10.1/1" }),
      candidate("openAlex", { title: "second", doi: "10.1/2" }),
      candidate("openAlex", { title: "third", doi: "10.1/3" }),
    ];
    const ranked = rankCandidates(raw, 2);
    expect(ranked.map((c) => c.metadata.title)).toEqual(["first", "second"]);
  });

  it("breaks a score tie by citation count", () => {
    const raw: RawCandidate[] = [
      candidate("semanticScholar", { title: "low", doi: "10.1/low" }, 3),
      candidate("openAlex", { title: "high", doi: "10.1/high" }, 500),
    ];
    // Both are rank 0 in their own source, so scores tie and citations decide.
    const ranked = rankCandidates(raw, 10);
    expect(ranked[0]!.metadata.title).toBe("high");
  });

  it("returns an empty list for no candidates and rejects a negative limit", () => {
    expect(rankCandidates([], 10)).toEqual([]);
    expect(() => rankCandidates([], -1)).toThrow(RangeError);
  });
});
