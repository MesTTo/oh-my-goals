import { describe, expect, it } from "vitest";

import { createResearchWorker } from "../src/research_worker.js";
import { ResearchWorkerError } from "../src/research.js";

const liveWorkerConfigured = (process.env.OH_MY_GOALS_RESEARCH_PYTHON ?? "") !== "";
const liveGrobidConfigured = (process.env.OH_MY_GOALS_GROBID_URL ?? "") !== "";

if (!liveWorkerConfigured) {
  console.warn(
    "skipping live research worker tests: set OH_MY_GOALS_RESEARCH_PYTHON to enable them",
  );
} else if (!liveGrobidConfigured) {
  console.warn(
    "skipping live GROBID parse assertions: set OH_MY_GOALS_GROBID_URL to parse full text",
  );
}

describe("research worker configuration", () => {
  it("defers the missing Python interpreter error to the first call", async () => {
    const saved = process.env.OH_MY_GOALS_RESEARCH_PYTHON;
    delete process.env.OH_MY_GOALS_RESEARCH_PYTHON;
    try {
      expect(() => createResearchWorker()).not.toThrow();
      const worker = createResearchWorker();
      await expect(worker.fetchAndParse("1706.03762")).rejects.toBeInstanceOf(
        ResearchWorkerError,
      );
      await expect(worker.fetchAndParse("1706.03762")).rejects.toThrow(
        /research worker is not configured/,
      );
      await worker.close();
    } finally {
      if (saved !== undefined) process.env.OH_MY_GOALS_RESEARCH_PYTHON = saved;
    }
  });
});

describe.skipIf(!liveWorkerConfigured)("live research worker", () => {
  it("fetches arXiv metadata for a known paper", async () => {
    const worker = createResearchWorker();
    try {
      const paper = await worker.fetchAndParse("1706.03762");
      expect(paper.metadata.title).toContain("Attention Is All You Need");
      expect(paper.metadata.arxivId).toBe("1706.03762");
      if (liveGrobidConfigured) {
        expect(Array.isArray(paper.sections)).toBe(true);
        expect(Array.isArray(paper.references)).toBe(true);
      }
    } finally {
      await worker.close();
    }
  });

  it("reports a Crossref-marked retracted DOI as retracted", async () => {
    const worker = createResearchWorker();
    try {
      const records = await worker.retractionStatus(["10.1016/j.micpro.2020.103768"]);
      expect(records).toHaveLength(1);
      expect(records[0]!.status).toBe("retracted");
      expect(records[0]!.date).toBe("2021-03-01");
    } finally {
      await worker.close();
    }
  });

  it("searches for candidate works and surfaces a known paper", async () => {
    const worker = createResearchWorker();
    try {
      // OpenAlex is keyless and reliable; Semantic Scholar may rate-limit keyless
      // and be skipped, so the query must still succeed from OpenAlex alone.
      const candidates = await worker.search("attention is all you need transformer", { limit: 5 });
      expect(candidates.length).toBeGreaterThan(0);
      const titles = candidates.map((candidate) => candidate.metadata.title.toLowerCase());
      expect(titles.some((title) => title.includes("attention is all you need"))).toBe(true);
      for (const candidate of candidates) {
        expect(["semanticScholar", "openAlex"]).toContain(candidate.source);
        expect(typeof candidate.metadata.title).toBe("string");
      }
    } finally {
      await worker.close();
    }
  });

  it("fetches external citation edges for a DOI paper both ways", async () => {
    const worker = createResearchWorker();
    try {
      // A published DOI resolves in OpenAlex, which holds its references and citers.
      const references = await worker.citations("10.1016/j.micpro.2020.103768", "references", { limit: 3 });
      expect(references.length).toBeGreaterThan(0);
      for (const candidate of references) {
        expect(candidate.source).toBe("openAlex");
        expect(typeof candidate.metadata.title).toBe("string");
      }
      const citedBy = await worker.citations("10.1016/j.micpro.2020.103768", "citedBy", { limit: 3 });
      expect(citedBy.length).toBeGreaterThan(0);
    } finally {
      await worker.close();
    }
  });
});
