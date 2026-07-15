// Durable semantic memory: the async face of the memory system.
//
// MemorySpace is the synchronous record and MeTTa authority. Embedding is async,
// so this facade owns the semantic index lifecycle around it. After every
// lifecycle mutation it reconciles the index against the set of active
// propositions: a proposition that just became inactive loses its candidates, one
// that just became active gains them. On open it rebuilds the index from the SH
// trees stored with the durable records, so semantic search survives a restart
// without re-running the parser. Candidates are always re-decomposed from the
// stored tree, never persisted as vectors, so swapping the embedding provider
// re-embeds cleanly.
//
// The facade adds no reasoning of its own. A search returns candidates whose
// canonical proposition is still active and in scope; establishing a proof over
// them is the query layer's job.

import { semanticCandidatesForEdge } from "./candidates.js";
import type { Polarity, ShNode } from "./hyperbase.js";
import {
  createMemorySpace,
  type AddSourceResult,
  type DeriveInput,
  type MemoryKind,
  type CitationDirection,
  type CitationReference,
  type MemoryScope,
  type MemorySourceInput,
  type MemorySpace,
  type MemoryWorkInput,
  type StoredCitation,
  type NotFoundError,
  type PurgeResult,
  type RememberInput,
  type RetractResult,
  type RetractSourceResult,
  type StoredProposition,
  type StoredWork,
  type SupersedeResult,
  type WorkStatus,
  type WorkStatusResult,
} from "./memory.js";
import type { DurableStore } from "./durable_store.js";
import {
  scopeSpaceId,
  semanticOptions,
  type SemanticBackend,
  type SemanticConfig,
  type SemanticOptions,
} from "./semantic.js";
import type { CandidatePolarity, SemanticCandidate } from "./vector_index.js";

export interface SemanticMemoryOptions {
  /** Durable backing store. Defaults to a non-persistent in-memory store. */
  readonly store?: DurableStore;
  /** Repository identity; isolates project, derived, and session scopes. */
  readonly repository?: string;
  /** Session identity; isolates session-scope records between sessions. */
  readonly session?: string;
  /** Clock for the default recordedAt timestamp. Injected for deterministic tests. */
  readonly now?: () => string;
  /** Prefix for generated proposition identifiers. */
  readonly idPrefix?: string;
  /** Semantic backend. When omitted, the facade is a pure async record memory. */
  readonly backend?: SemanticBackend;
}

function coerceCandidatePolarity(polarity: string | undefined): CandidatePolarity {
  return polarity === "negated" ? "negated" : "affirmative";
}

/** A search hit: the matched candidate and the active proposition it belongs to. */
export interface SemanticHit {
  readonly candidate: SemanticCandidate;
  readonly proposition: StoredProposition;
}

/** Async, semantic-index-maintaining facade over a synchronous {@link MemorySpace}. */
export class SemanticMemory {
  readonly #memory: MemorySpace;
  readonly #backend: SemanticBackend | undefined;
  readonly #identity: { readonly repositoryId?: string; readonly sessionId?: string };

  private constructor(memory: MemorySpace, options: SemanticMemoryOptions) {
    this.#memory = memory;
    this.#backend = options.backend;
    this.#identity = { repositoryId: options.repository, sessionId: options.session };
  }

  /** Open a durable semantic memory, rebuilding the index from stored records. */
  static async open(options: SemanticMemoryOptions = {}): Promise<SemanticMemory> {
    const memory = createMemorySpace({
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(options.repository !== undefined ? { repository: options.repository } : {}),
      ...(options.session !== undefined ? { session: options.session } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.idPrefix !== undefined ? { idPrefix: options.idPrefix } : {}),
    });
    const self = new SemanticMemory(memory, options);
    await self.#rebuildIndex();
    return self;
  }

  // --- lifecycle writes (reconcile the index after each) ---

  async remember(input: RememberInput): Promise<StoredProposition> {
    return this.#reconcile(() => this.#memory.remember(input));
  }

  async derive(input: DeriveInput): Promise<StoredProposition> {
    return this.#reconcile(() => this.#memory.derive(input));
  }

  async addProof(
    id: string,
    rule: string,
    premises: readonly string[],
  ): Promise<StoredProposition | NotFoundError> {
    return this.#reconcile(() => this.#memory.addProof(id, rule, premises));
  }

  async addSource(
    id: string,
    source: MemorySourceInput,
    expectedRevision?: number,
  ): Promise<AddSourceResult> {
    return this.#reconcile(() => this.#memory.addSource(id, source, expectedRevision));
  }

  async retract(id: string, expectedRevision?: number): Promise<RetractResult> {
    return this.#reconcile(() => this.#memory.retract(id, expectedRevision));
  }

  async retractSource(
    id: string,
    assertionId: string,
    expectedRevision?: number,
  ): Promise<RetractSourceResult> {
    return this.#reconcile(() => this.#memory.retractSource(id, assertionId, expectedRevision));
  }

  async supersede(
    oldId: string,
    replacement: RememberInput,
    expectedRevision?: number,
  ): Promise<SupersedeResult> {
    return this.#reconcile(() => this.#memory.supersede(oldId, replacement, expectedRevision));
  }

  async purge(id: string, expectedRevision?: number): Promise<PurgeResult> {
    return this.#reconcile(() => this.#memory.purge(id, expectedRevision));
  }

  // --- works ---

  /** Store a paper as a work, or return the existing one when an external id
   * matches in scope. A work carries no candidates itself, so no reindex. */
  async ingestWork(input: MemoryWorkInput): Promise<StoredWork> {
    return this.#memory.ingestWork(input);
  }

  /** Change a work's status. Retracting it deactivates the claims that cite it,
   * so reconcile drops their candidates from the index. */
  async setWorkStatus(
    id: string,
    status: WorkStatus,
    notice?: string,
    date?: string,
  ): Promise<WorkStatusResult> {
    return this.#reconcile(() => this.#memory.setWorkStatus(id, status, notice, date));
  }

  getWork(id: string): StoredWork | undefined {
    return this.#memory.getWork(id);
  }

  worksInScope(scope: MemoryScope): readonly StoredWork[] {
    return this.#memory.worksInScope(scope);
  }

  // --- citation graph ---

  /** Record the works one work cites, from its parsed references. */
  recordCitations(citingWorkId: string, references: readonly CitationReference[]): number {
    return this.#memory.recordCitations(citingWorkId, references);
  }

  /** The works reachable from a work along the citation graph, by MeTTa chaining. */
  citesOf(workId: string, direction: CitationDirection, transitive: boolean): readonly string[] {
    return this.#memory.citesOf(workId, direction, transitive);
  }

  /** The reference edges of a work, each resolved to an ingested work when known. */
  citationEdges(workId: string): readonly StoredCitation[] {
    return this.#memory.citationEdges(workId);
  }

  // --- reads ---

  /** Top active propositions matching a query in one scope. A proposition
   * decomposes into several candidates; this keeps its best-scoring one and, like
   * mettabase's semmatch gate, requires a positive score even with no threshold.
   * When the caller does not set a threshold, the provider's measured one applies. */
  async search(
    query: string,
    scope: MemoryScope,
    options: Partial<SemanticOptions> = {},
  ): Promise<SemanticHit[]> {
    if (this.#backend === undefined) return [];
    const resolved = semanticOptions({
      ...(options.topK !== undefined ? { topK: options.topK } : {}),
      threshold: options.threshold !== undefined ? options.threshold : this.#backend.recommendedThreshold,
      ...(options.filters !== undefined ? { filters: options.filters } : {}),
    });
    const candidates = await this.#backend.search(this.#spaceId(scope), query, resolved);
    const best = new Map<string, SemanticHit>();
    for (const candidate of candidates) {
      if (candidate.edgeId === null || candidate.score <= 0) continue;
      if (!this.#memory.isActive(candidate.edgeId)) continue;
      const proposition = this.#memory.get(candidate.edgeId);
      if (proposition === undefined) continue;
      const existing = best.get(candidate.edgeId);
      if (existing === undefined || candidate.score > existing.candidate.score) {
        best.set(candidate.edgeId, { candidate, proposition });
      }
    }
    return [...best.values()].sort((a, b) => b.candidate.score - a.candidate.score);
  }

  isActive(id: string): boolean {
    return this.#memory.isActive(id);
  }

  get(id: string): StoredProposition | undefined {
    return this.#memory.get(id);
  }

  activePropositions(): readonly string[] {
    return this.#memory.activePropositions();
  }

  activeInScope(scope: MemoryScope): readonly string[] {
    return this.#memory.activeInScope(scope);
  }

  activeOfKind(scope: MemoryScope, kind: MemoryKind): readonly string[] {
    return this.#memory.activeOfKind(scope, kind);
  }

  /** The active semantic provider and index, or undefined when running record-only. */
  config(): SemanticConfig | undefined {
    return this.#backend?.config();
  }

  /** The underlying synchronous record space, for callers that need direct reads. */
  get space(): MemorySpace {
    return this.#memory;
  }

  close(): void {
    this.#memory.close();
  }

  // --- index maintenance ---

  #spaceId(scope: MemoryScope): string {
    return scopeSpaceId(scope, this.#identity);
  }

  async #rebuildIndex(): Promise<void> {
    if (this.#backend === undefined) return;
    for (const id of this.#memory.activePropositions()) {
      await this.#indexProposition(id);
    }
  }

  // Run a synchronous memory mutation, then bring the index into line with the new
  // active set: drop candidates for propositions that went inactive, add candidates
  // for those that went active. A snapshot of scopes taken before the mutation lets
  // a purged proposition (gone from the record space) still be located for removal.
  async #reconcile<T>(mutate: () => T): Promise<T> {
    if (this.#backend === undefined) return mutate();
    const beforeScopes = this.#activeScopes();
    const result = mutate();
    const after = new Set(this.#memory.activePropositions());
    for (const [id, scope] of beforeScopes) {
      if (!after.has(id)) this.#backend.removeByEdge(this.#spaceId(scope), [id]);
    }
    for (const id of after) {
      if (!beforeScopes.has(id)) await this.#indexProposition(id);
    }
    return result;
  }

  #activeScopes(): Map<string, MemoryScope> {
    const scopes = new Map<string, MemoryScope>();
    for (const id of this.#memory.activePropositions()) {
      const proposition = this.#memory.get(id);
      if (proposition !== undefined) scopes.set(id, proposition.scope);
    }
    return scopes;
  }

  async #indexProposition(id: string): Promise<void> {
    if (this.#backend === undefined) return;
    const proposition = this.#memory.get(id);
    if (proposition === undefined || proposition.shTree === undefined) return;
    const tree = JSON.parse(proposition.shTree) as ShNode;
    const candidates = semanticCandidatesForEdge({
      tree,
      edgeId: id,
      spaceId: this.#spaceId(proposition.scope),
      sourceText: proposition.content,
      polarity: coerceCandidatePolarity(proposition.polarity),
      epistemicKind: proposition.kind,
    });
    await this.#backend.indexProposition(candidates);
  }
}

/** Serialize a parsed SH tree for durable storage, with its polarity. */
export function encodeTree(tree: ShNode, polarity: Polarity): { shTree: string; polarity: Polarity } {
  return { shTree: JSON.stringify(tree), polarity };
}
