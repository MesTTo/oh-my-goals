// End-to-end proof of the extraction slice against real services: a real
// OpenAI-compatible model proposes claims, the real HyperBase parser judges each,
// and the rewrite loop recovers or drops. Gated on both a model and the parser,
// like the other live tests, so the parser-free suite still runs anywhere.
//
// Enable with, e.g.:
//   OH_MY_GOALS_LLM_BASE_URL=http://localhost:11435/v1 OH_MY_GOALS_LLM_MODEL=qwen2.5:7b \
//   OH_MY_GOALS_HYPERBASE_PYTHON=/path/to/python OH_MY_GOALS_METTABASE_DIR=/path/to/mettabase \
//   npx vitest run tests/extractor.live.test.ts

import { describe, expect, it } from "vitest";

import { TokenEmbeddingProvider } from "../src/embedding.js";
import {
  type ClaimLocator,
  formatLocator,
  resolveClaimExtractor,
  type StoreOutcome,
  storeExtractedClaims,
} from "../src/extractor.js";
import { createHyperbaseParser } from "../src/hyperbase.js";
import { ingestStatements } from "../src/ingest.js";
import type { ParsedPaper } from "../src/research.js";
import { SemanticBackend } from "../src/semantic.js";
import { SemanticMemory } from "../src/semantic_memory.js";
import { InMemoryVectorIndex } from "../src/vector_index.js";

const llmConfigured =
  (process.env.OH_MY_GOALS_LLM_BASE_URL ?? "") !== "" && (process.env.OH_MY_GOALS_LLM_MODEL ?? "") !== "";
const parserConfigured =
  (process.env.OH_MY_GOALS_HYPERBASE_PYTHON ?? "") !== "" && (process.env.OH_MY_GOALS_METTABASE_DIR ?? "") !== "";

if (!llmConfigured || !parserConfigured) {
  console.warn(
    "skipping live extractor tests: set OH_MY_GOALS_LLM_BASE_URL, OH_MY_GOALS_LLM_MODEL, " +
      "OH_MY_GOALS_HYPERBASE_PYTHON, and OH_MY_GOALS_METTABASE_DIR to enable them",
  );
}

// A compact fixture with clear, single-clause findings, so a small local model
// has parseable claims to propose without needing a fetched PDF.
const PAPER: ParsedPaper = {
  metadata: {
    title: "A Retrieval Method for Short Documents",
    doi: "10.9999/live-fixture",
    year: 2021,
    abstract:
      "We present a retrieval method for short documents. The method improves recall on the benchmark. " +
      "The method also reduces query latency compared to the baseline.",
  },
  sections: [
    {
      heading: "Results",
      text:
        "The method improves recall by twelve points on the benchmark. " +
        "The method reduces query latency. The baseline retrieves fewer relevant documents.",
    },
  ],
  references: [],
};

describe.skipIf(!llmConfigured || !parserConfigured)("live claim extraction through the real parser", () => {
  it(
    "extracts controlled-English claims a model proposes and the parser accepts",
    async () => {
      const extractor = resolveClaimExtractor();
      expect(extractor).toBeDefined();
      const parser = createHyperbaseParser();
      const memory = await SemanticMemory.open({
        backend: new SemanticBackend(new TokenEmbeddingProvider(), new InMemoryVectorIndex()),
      });
      try {
        const work = await memory.ingestWork({ title: PAPER.metadata.title, scope: "project", doi: PAPER.metadata.doi });
        const reference = work.doi ?? work.id;
        const storeClaim = async (text: string, locator: ClaimLocator): Promise<StoreOutcome> => {
          const [r] = await ingestStatements(parser, memory, [
            {
              content: text,
              scope: "project",
              kind: "observation",
              sources: [{ type: "paper", reference, workId: work.id, locator: formatLocator(locator) }],
            },
          ]);
          return r!.stored
            ? { stored: true, id: r!.proposition.id }
            : { stored: false, feedback: r!.feedback, reasons: r!.reasons };
        };

        const outcome = await storeExtractedClaims(extractor!, PAPER, storeClaim);
        // The model proposed claims and at least one survived the parser.
        expect(outcome.proposed).toBeGreaterThan(0);
        expect(outcome.stored.length).toBeGreaterThan(0);
        expect(outcome.model).toBe(process.env.OH_MY_GOALS_LLM_MODEL);

        // A stored claim is a live proposition sourced from the work.
        const stored = memory.get(outcome.stored[0]!.id);
        expect(stored).toBeDefined();
        expect(memory.isActive(stored!.id)).toBe(true);
        expect(stored!.sources[0]!.type).toBe("paper");
      } finally {
        await parser.close();
        memory.close();
      }
    },
    300_000,
  );
});
