// End-to-end review against the real parser: claims from different works are
// parsed, their cores reflected, and review reads contradiction and corroboration
// over them. Gated on the parser, like the other parser-dependent tests.

import { describe, expect, it } from "vitest";

import { TokenEmbeddingProvider } from "../src/embedding.js";
import { createHyperbaseParser } from "../src/hyperbase.js";
import { ingestStatements } from "../src/ingest.js";
import { reviewClaims } from "../src/review.js";
import { SemanticBackend } from "../src/semantic.js";
import { SemanticMemory } from "../src/semantic_memory.js";
import { InMemoryVectorIndex } from "../src/vector_index.js";

const parserConfigured =
  (process.env.OH_MY_GOALS_HYPERBASE_PYTHON ?? "") !== "" && (process.env.OH_MY_GOALS_METTABASE_DIR ?? "") !== "";

if (!parserConfigured) {
  console.warn(
    "skipping live review tests: set OH_MY_GOALS_HYPERBASE_PYTHON and OH_MY_GOALS_METTABASE_DIR to enable them",
  );
}

describe.skipIf(!parserConfigured)("live review over the real parser", () => {
  it(
    "reads contradiction and corroboration across works",
    async () => {
      const parser = createHyperbaseParser();
      const memory = await SemanticMemory.open({
        backend: new SemanticBackend(new TokenEmbeddingProvider(), new InMemoryVectorIndex()),
      });
      try {
        const ingest = async (doi: string, sentence: string): Promise<void> => {
          const work = await memory.ingestWork({ title: `Work ${doi}`, scope: "project", doi });
          await ingestStatements(parser, memory, [
            {
              content: sentence,
              scope: "project",
              kind: "observation",
              sources: [{ type: "paper", reference: doi, workId: work.id, locator: "Results" }],
            },
          ]);
        };
        await ingest("10.1/a", "The method improves recall.");
        await ingest("10.1/b", "The method does not improve recall."); // contradicts
        await ingest("10.1/c", "The drug reduces risk.");
        await ingest("10.1/d", "The drug reduces risk."); // corroborates

        const conflict = await reviewClaims(memory, "method recall", "project");
        const improve = conflict.statements.find((statement) => statement.core.startsWith("improve"));
        expect(improve).toBeDefined();
        expect(improve!.contradicted).toBe(true);
        expect(improve!.opinion.belief).toBeGreaterThan(0);
        expect(improve!.opinion.disbelief).toBeGreaterThan(0);

        const agreement = await reviewClaims(memory, "drug risk", "project");
        const reduce = agreement.statements.find((statement) => statement.core.startsWith("reduce"));
        expect(reduce).toBeDefined();
        expect(reduce!.corroborated).toBe(true);
        expect(reduce!.negating).toHaveLength(0);
      } finally {
        await parser.close();
        memory.close();
      }
    },
    120_000,
  );
});
