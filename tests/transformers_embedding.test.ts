import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cosine } from "../src/embedding.js";
import {
  resolveEmbeddingProvider,
  TransformersEmbeddingProvider,
} from "../src/transformers_embedding.js";

// Graceful-degradation tests. These run everywhere: with @huggingface/transformers
// absent the dynamic import fails; with it present but the model unresolvable the
// load fails. Both must degrade to the token-hash provider, not throw.
describe("embedding provider resolution", () => {
  const temps: string[] = [];
  afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("resolves the default to the token-hash provider", async () => {
    const provider = await resolveEmbeddingProvider("Local");
    expect(provider.name).toBe("Local");
    expect(provider.recommendedThreshold).toBeNull();
  });

  it("falls back to token-hash when the contextual model cannot load", async () => {
    const emptyCache = mkdtempSync(join(tmpdir(), "bge-empty-"));
    temps.push(emptyCache);
    // A model that does not exist locally, with no download allowed: the load must
    // fail closed and the resolver must hand back the token-hash provider.
    const provider = await resolveEmbeddingProvider("BGE", {
      model: "Xenova/this-model-does-not-exist",
      allowDownload: false,
      cacheDir: emptyCache,
    });
    expect(provider.name).toBe("Local");
    expect(provider.model).toBe("token-hash");
  });

  it("carries the measured query threshold on the contextual provider", () => {
    expect(new TransformersEmbeddingProvider().recommendedThreshold).toBe(0.65);
    expect(new TransformersEmbeddingProvider().name).toBe("BGE");
    expect(new TransformersEmbeddingProvider().model).toBe("Xenova/bge-small-en-v1.5");
  });
});

// The real BGE model needs @huggingface/transformers installed and the ONNX model
// present. Point OH_MY_GOALS_BGE_CACHE at a transformers.js cache dir holding
// Xenova/bge-small-en-v1.5 (fetch once with allowDownload). Then it runs offline.
const bgeCache = process.env.OH_MY_GOALS_BGE_CACHE ?? "";
const bgeConfigured = bgeCache !== "";

const CORPUS = [
  { id: "auth", text: "The authentication service validates JSON web tokens with RS256." },
  { id: "db", text: "The production database runs PostgreSQL 16." },
  { id: "test", text: "The build runs the unit test suite with vitest." },
  { id: "cache", text: "The cache layer stores user sessions in Redis." },
  { id: "ratelimit", text: "The rate limiter allows one hundred requests per minute per client." },
  { id: "migration", text: "The migration script drops the legacy audit column." },
];
const QUERIES = [
  { q: "How are access tokens verified?", relevant: "auth" },
  { q: "Which relational database does the project run?", relevant: "db" },
  { q: "What tool executes the tests?", relevant: "test" },
  { q: "Where are login sessions kept?", relevant: "cache" },
  { q: "How many calls can a client make each minute?", relevant: "ratelimit" },
];

describe.skipIf(!bgeConfigured)("BGE contextual provider (real model)", () => {
  function provider(): TransformersEmbeddingProvider {
    return new TransformersEmbeddingProvider({ dtype: "q8", cacheDir: bgeCache });
  }

  it("embeds to a normalized 384-dim vector and separates paraphrase from unrelated", async () => {
    const p = provider();
    const a = "The user requires the public API to stay compatible.";
    const b = "The public API must remain backward compatible for the user.";
    const c = "The database migration dropped the old column.";
    const [va, vb, vc] = await Promise.all([p.embed(a), p.embed(b), p.embed(c)]);

    expect(va).toHaveLength(384);
    expect(p.dimensions).toBe(384);
    const norm = Math.sqrt(va.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);
    expect(cosine(va, vb)).toBeGreaterThan(cosine(va, vc) + 0.2);
  });

  it("ranks the paraphrased proposition first and above the 0.65 threshold", async () => {
    const p = provider();
    const corpusVecs = await Promise.all(CORPUS.map((c) => p.embed(c.text)));
    let topOne = 0;
    for (const { q, relevant } of QUERIES) {
      const qv = await p.embed(q);
      const ranked = CORPUS.map((c, i) => ({ id: c.id, score: cosine(qv, corpusVecs[i]!) })).sort(
        (x, y) => y.score - x.score,
      );
      if (ranked[0]!.id === relevant) topOne += 1;
      const relevantScore = ranked.find((r) => r.id === relevant)!.score;
      // The relevant record clears the pinned threshold for these clear paraphrases.
      expect(relevantScore).toBeGreaterThan(p.recommendedThreshold!);
    }
    // Contextual retrieval puts the paraphrase first for the whole clear-cut set.
    expect(topOne).toBe(QUERIES.length);
  });
});
