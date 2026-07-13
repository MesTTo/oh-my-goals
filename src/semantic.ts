// Semantic backend: embed queries, search the vector index, score bound
// candidates, and corroborate paraphrases. Ports mettabase's SemanticBackend
// (semantic.py:324-374), its score>0 match gate, and its anchored corroboration
// (semantic.py:549-599). The MeTTa relations in the module call these through
// grounded operations; the backend itself is pure TypeScript.

import { cosine, type EmbeddingProvider, tokenize } from "./embedding.js";
import type { MemoryScope } from "./memory.js";
import type { EmbeddedCandidate, SemanticCandidate, VectorIndex } from "./vector_index.js";

export const DEFAULT_TOP_K = 10;

export interface SemanticOptions {
  readonly topK: number;
  readonly threshold: number | null;
  readonly filters: Readonly<Record<string, unknown>>;
}

export function semanticOptions(overrides: Partial<SemanticOptions> = {}): SemanticOptions {
  return {
    topK: overrides.topK ?? DEFAULT_TOP_K,
    threshold: overrides.threshold ?? null,
    filters: overrides.filters ?? {},
  };
}

export interface SemanticConfig {
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly dimensions: number | null;
  readonly index: string;
  readonly defaultTopK: number;
}

/** Map a memory scope to a distinct vector-index space id. */
export function scopeSpaceId(
  scope: MemoryScope,
  identity: { readonly repositoryId?: string; readonly sessionId?: string } = {},
): string {
  const repository = identity.repositoryId ?? "local";
  switch (scope) {
    case "user":
      return "omg:user";
    case "project":
      return `omg:project:${repository}`;
    case "session":
      return `omg:session:${identity.sessionId ?? "default"}`;
    case "derived":
      return `omg:derived:${repository}`;
  }
}

/** Embed queries, search, score bound candidates, and maintain the index. */
export class SemanticBackend {
  readonly #embedding: EmbeddingProvider;
  readonly #index: VectorIndex;
  readonly #indexName: string;

  constructor(embedding: EmbeddingProvider, index: VectorIndex, indexName = "InMemory") {
    this.#embedding = embedding;
    this.#index = index;
    this.#indexName = indexName;
  }

  get embedding(): EmbeddingProvider {
    return this.#embedding;
  }

  get index(): VectorIndex {
    return this.#index;
  }

  async #embed(text: string): Promise<number[]> {
    return this.#embedding.embed(text);
  }

  /** Insert or replace a set of decomposed candidates, embedding each. */
  async indexProposition(candidates: readonly SemanticCandidate[]): Promise<void> {
    const entries: EmbeddedCandidate[] = await Promise.all(
      candidates.map(async (candidate) => ({ candidate, vector: await this.#embed(candidate.text) })),
    );
    this.#index.upsert(entries);
  }

  /** Index one free-text string candidate under an id (mb-add-candidate). */
  async addCandidate(spaceId: string, atomId: string, text: string): Promise<void> {
    this.#index.upsert([
      {
        candidate: {
          atom: text,
          text,
          score: 0,
          spaceId,
          atomId,
          unitType: "bound",
          edgeId: null,
          role: null,
          payload: { candidate_kind: "string" },
        },
        vector: await this.#embed(text),
      },
    ]);
  }

  /** Remove candidates by id from a space. */
  remove(spaceId: string, atomIds: readonly string[]): void {
    this.#index.delete(spaceId, atomIds);
  }

  /** Remove every candidate that decomposed from the given propositions. */
  removeByEdge(spaceId: string, edgeIds: readonly string[]): void {
    this.#index.deleteByEdge(spaceId, edgeIds);
  }

  /** Top semantic candidates for a query in one space (generator mode). */
  async search(
    spaceId: string,
    query: string,
    options: SemanticOptions = semanticOptions(),
  ): Promise<SemanticCandidate[]> {
    return this.#index.search({
      spaceId,
      vector: await this.#embed(query),
      topK: options.topK,
      threshold: options.threshold,
      filters: options.filters,
    });
  }

  /** Cosine score of a bound candidate text, or null when below threshold. */
  async score(
    query: string,
    candidateText: string,
    threshold: number | null = null,
  ): Promise<number | null> {
    const value = cosine(await this.#embed(query), await this.#embed(candidateText));
    if (threshold !== null && value < threshold) return null;
    return value;
  }

  /** Whether a bound candidate matches. A positive score is required even with
   * no threshold, matching mettabase's semmatch_bool gate. */
  async matches(query: string, candidateText: string, threshold: number | null = null): Promise<boolean> {
    const value = await this.score(query, candidateText, threshold);
    return value !== null && value > 0;
  }

  config(): SemanticConfig {
    return {
      embeddingProvider: this.#embedding.name,
      embeddingModel: this.#embedding.model,
      dimensions: this.#embedding.dimensions,
      index: this.#indexName,
      defaultTopK: DEFAULT_TOP_K,
    };
  }
}

// Anchored corroboration. Two paraphrases corroborate only when they share a
// resolved entity anchor, have compatible polarity, and their relation text
// embeds above a cosine threshold. The anchor is the precision gate that stops
// "berlin is nice" from corroborating "paris is nice".

export type PolarityInput = boolean | number | string;

export interface CorroborationItem {
  readonly id: string;
  readonly anchor: string;
  readonly text: string;
  readonly polarity: PolarityInput;
}

export interface CorroborationPair {
  readonly a: string;
  readonly b: string;
  readonly score: number;
}

const NEGATIVE_POLARITY = new Set(["-1", "neg", "negative", "false", "disbelief"]);

/** Coerce a polarity input to +1 or -1. */
export function coercePolarity(polarity: PolarityInput): 1 | -1 {
  if (typeof polarity === "boolean") return polarity ? 1 : -1;
  if (typeof polarity === "number") return polarity < 0 ? -1 : 1;
  return NEGATIVE_POLARITY.has(polarity.trim().toLowerCase()) ? -1 : 1;
}

// Function words stripped before token-hash embedding so glue words do not
// inflate similarity. Contextual providers keep the full text.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is",
  "it", "its", "of", "on", "or", "that", "the", "to", "was", "were", "will", "with",
]);

function contentText(text: string): string {
  return tokenize(text)
    .filter((token) => !STOPWORDS.has(token))
    .join(" ");
}

/** Corroborating pairs: same anchor, compatible polarity, cosine >= threshold. */
export async function semanticCorroborations(
  embedding: EmbeddingProvider,
  items: readonly CorroborationItem[],
  threshold: number,
  options: { readonly samePolarity?: boolean } = {},
): Promise<CorroborationPair[]> {
  const samePolarity = options.samePolarity ?? true;
  const strip = embedding.name === "Local";
  const prepared = await Promise.all(
    items.map(async (item) => ({
      id: item.id,
      anchor: item.anchor,
      polarity: coercePolarity(item.polarity),
      vector: await embedding.embed(strip ? contentText(item.text) : item.text),
    })),
  );

  const pairs: CorroborationPair[] = [];
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const a = prepared[i]!;
      const b = prepared[j]!;
      if (a.anchor !== b.anchor) continue;
      if (samePolarity && a.polarity !== b.polarity) continue;
      const score = cosine(a.vector, b.vector);
      if (score < threshold) continue;
      const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      pairs.push({ a: low, b: high, score });
    }
  }
  pairs.sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1));
  return pairs;
}
