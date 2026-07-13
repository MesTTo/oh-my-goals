// Text embedding providers for semantic memory retrieval.
//
// The default is a deterministic token-hash provider: a bag of tokens hashed
// into a fixed number of bins and L2-normalized, so cosine similarity is a plain
// dot product. It is offline, order-independent, and stable, which makes it the
// test and degraded-fallback backend. It is not a contextual model and does not
// understand paraphrases; a contextual provider slots in behind this interface.
// The shape follows mettabase's TokenEmbeddingProvider (semantic.py:80-101); the
// hash bins are this project's own and need not match mettabase byte for byte.

import { createHash } from "node:crypto";

/** A text-to-vector embedder. Vectors are L2-normalized so dot product is cosine.
 * The token-hash provider embeds synchronously; contextual model providers embed
 * asynchronously, so the return type covers both and callers await it. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number | null;
  embed(text: string): number[] | Promise<number[]>;
}

// Split on any run of non-alphanumeric characters, matching Python str.isalnum
// over Unicode. Underscores split too, so `auth_refresh` becomes two tokens.
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

/** Lowercased alphanumeric tokens of a text, in order, with empties dropped. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const token of text.split(TOKEN_SPLIT)) {
    if (token.length > 0) tokens.push(token.toLowerCase());
  }
  return tokens;
}

/** Return the L2-normalized copy of a vector, or a zero vector when the norm is 0. */
export function l2normalize(vector: readonly number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

/** Cosine similarity of two equal-length vectors, computed as the dot product.
 * Providers return L2-normalized vectors, for which the dot product is cosine. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError("vectors must have equal length");
  }
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index]! * b[index]!;
  return dot;
}

/** Deterministic offline bag-of-tokens embedding hashed into fixed bins. */
export class TokenEmbeddingProvider implements EmbeddingProvider {
  readonly name = "Local";
  readonly model = "token-hash";
  readonly dimensions: number;

  constructor(dimensions = 256) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new RangeError("dimensions must be a positive integer");
    }
    this.dimensions = dimensions;
  }

  embed(text: string): number[] {
    if (typeof text !== "string") throw new TypeError("embed expects a string");
    const vector = new Array<number>(this.dimensions).fill(0);
    const modulus = BigInt(this.dimensions);
    for (const token of tokenize(text)) {
      const digest = createHash("blake2b512").update(token, "utf8").digest("hex");
      const bin = Number(BigInt(`0x${digest}`) % modulus);
      vector[bin]! += 1;
    }
    return l2normalize(vector);
  }
}
