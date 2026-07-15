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
});
