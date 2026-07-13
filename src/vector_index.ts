// Semantic candidates and the vector index that stores and searches them.
//
// A stored proposition decomposes into several searchable candidates (its
// sentence, its typed edge, each subtree, connector, and argument). Each
// candidate is embedded and kept in a per-space index. The contract follows
// mettabase's VectorIndex (semantic.py:117-192) with one addition the plan
// requires: per-candidate `delete`, without which `forget` cannot remove a
// proposition's semantic footprint.
//
// The index is a pure vector store: it takes candidates already paired with
// their vectors and never embeds. The SemanticBackend owns the embedding
// provider, which lets the index stay synchronous while contextual providers
// embed asynchronously.

import { cosine } from "./embedding.js";

export type SemanticUnitType =
  | "source"
  | "edge"
  | "subtree"
  | "connector"
  | "argument"
  | "bound";

export type CandidatePolarity = "affirmative" | "negated";

/** One searchable unit derived from a proposition, with its provenance. */
export interface SemanticCandidate {
  /** Parseable typed-MeTTa payload for this unit. */
  readonly atom: string;
  /** The text that is embedded and matched. */
  readonly text: string;
  /** Cosine score; 0 until a search fills it. */
  readonly score: number;
  /** Scope / semantic-space id, a hard search filter. */
  readonly spaceId: string;
  /** Deterministic candidate id, or null for an anonymous string candidate. */
  readonly atomId: string | null;
  readonly unitType: SemanticUnitType;
  /** The parent proposition id, so a hit maps back to its canonical record. */
  readonly edgeId: string | null;
  /** SH argument-role letter for argument units, else null. */
  readonly role: string | null;
  /** Negation carried from the SH tree, exposed for filtering. */
  readonly polarity?: CandidatePolarity;
  /** Epistemic kind carried from the proposition, exposed for filtering. */
  readonly epistemicKind?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface VectorSearchQuery {
  readonly spaceId: string;
  readonly vector: readonly number[];
  readonly topK: number;
  readonly threshold: number | null;
  readonly filters: Readonly<Record<string, unknown>>;
}

/** A candidate paired with its precomputed embedding. */
export interface EmbeddedCandidate {
  readonly candidate: SemanticCandidate;
  readonly vector: readonly number[];
}

/** Insert-or-replace, search, and delete over embedded candidates. */
export interface VectorIndex {
  upsert(entries: readonly EmbeddedCandidate[]): void;
  search(query: VectorSearchQuery): SemanticCandidate[];
  /** Remove specific candidates by their atom id. */
  delete(spaceId: string, atomIds: readonly string[]): void;
  /** Remove every candidate that decomposed from the given propositions. Purge
   * and retraction key on the proposition (edge) id, not each candidate id. */
  deleteByEdge(spaceId: string, edgeIds: readonly string[]): void;
}

const FILTERABLE_ATTRIBUTES = new Set([
  "atomId",
  "unitType",
  "edgeId",
  "role",
  "polarity",
  "epistemicKind",
]);

/** Match a candidate against filter keys: attributes first, then payload. */
function matchesFilters(
  candidate: SemanticCandidate,
  filters: Readonly<Record<string, unknown>>,
): boolean {
  for (const [key, expected] of Object.entries(filters)) {
    if (FILTERABLE_ATTRIBUTES.has(key)) {
      if ((candidate as unknown as Record<string, unknown>)[key] !== expected) return false;
    } else if (candidate.payload[key] !== expected) {
      return false;
    }
  }
  return true;
}

function candidateKey(spaceId: string, atomId: string): string {
  return `${spaceId}\u0000${atomId}`;
}

interface IndexedRow {
  candidate: SemanticCandidate;
  vector: readonly number[];
}

/** In-memory linear-scan index over candidates paired with their vectors. */
export class InMemoryVectorIndex implements VectorIndex {
  #rows: IndexedRow[] = [];
  #byKey = new Map<string, number>();

  upsert(entries: readonly EmbeddedCandidate[]): void {
    for (const { candidate, vector } of entries) {
      const row: IndexedRow = { candidate, vector };
      if (candidate.atomId === null) {
        this.#rows.push(row);
        continue;
      }
      const key = candidateKey(candidate.spaceId, candidate.atomId);
      const existing = this.#byKey.get(key);
      if (existing !== undefined) {
        this.#rows[existing] = row;
      } else {
        this.#byKey.set(key, this.#rows.length);
        this.#rows.push(row);
      }
    }
  }

  search(query: VectorSearchQuery): SemanticCandidate[] {
    if (!Number.isInteger(query.topK) || query.topK <= 0) {
      throw new RangeError("topK must be a positive integer");
    }
    const scored: SemanticCandidate[] = [];
    for (const row of this.#rows) {
      const { candidate } = row;
      if (candidate.spaceId !== query.spaceId) continue;
      if (!matchesFilters(candidate, query.filters)) continue;
      const score = cosine(query.vector, row.vector);
      if (query.threshold !== null && score < query.threshold) continue;
      scored.push({ ...candidate, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.topK);
  }

  delete(spaceId: string, atomIds: readonly string[]): void {
    if (atomIds.length === 0) return;
    const remove = new Set(atomIds);
    this.#removeWhere(
      (candidate) =>
        candidate.spaceId === spaceId && candidate.atomId !== null && remove.has(candidate.atomId),
    );
  }

  deleteByEdge(spaceId: string, edgeIds: readonly string[]): void {
    if (edgeIds.length === 0) return;
    const remove = new Set(edgeIds);
    this.#removeWhere(
      (candidate) =>
        candidate.spaceId === spaceId && candidate.edgeId !== null && remove.has(candidate.edgeId),
    );
  }

  #removeWhere(matches: (candidate: SemanticCandidate) => boolean): void {
    this.#rows = this.#rows.filter((row) => !matches(row.candidate));
    this.#reindex();
  }

  /** Number of stored candidates, for tests and index maintenance. */
  size(): number {
    return this.#rows.length;
  }

  #reindex(): void {
    this.#byKey.clear();
    for (let index = 0; index < this.#rows.length; index += 1) {
      const { candidate } = this.#rows[index]!;
      if (candidate.atomId !== null) {
        this.#byKey.set(candidateKey(candidate.spaceId, candidate.atomId), index);
      }
    }
  }
}
