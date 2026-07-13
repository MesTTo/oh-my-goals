// A live MeTTa memory of controlled-English propositions with provenance,
// lifecycle, and derivation, backed by a durable record store.
//
// Visibility, active-source aggregation, retraction, supersession, and reverse
// proof invalidation are decided by the gc-mem-* relations in oh-my-goals.metta.
// This host validates caller data, encodes it as ground facts in a memory space,
// and reads visibility and receipts back. A durable store (SQLite in production,
// in-memory for tests) persists the records; on construction the space loads the
// records in scope and rebuilds the live MeTTa facts from them. The MeTTa space
// stays the single authority for what is visible; the store is only the log the
// space rebuilds from. Every mutation writes through to the store so a restart
// recovers the same state.

import {
  IdConflictError,
  InMemoryDurableStore,
  type DurableStore,
  type PersistedRecord,
} from "./durable_store.js";
import {
  createGoalChainerMetta,
  mettaCall,
  mettaFloat,
  mettaInteger,
  mettaString,
  mettaSymbol,
  mettaTuple,
  type GoalChainerMetta,
} from "./metta.js";
import { assertDenseArray, assertKnownKeys, assertPlainRecord } from "./records.js";

export const MEMORY_SCOPES = Object.freeze([
  "session",
  "project",
  "user",
  "derived",
] as const);
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = Object.freeze([
  "user-statement",
  "repository-instruction",
  "observation",
  "goal",
  "norm",
  "action",
  "hypothesis",
  "derived-conclusion",
  "decision",
] as const);
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATES = Object.freeze(["active", "retracted", "superseded"] as const);
export type MemoryPropositionState = (typeof MEMORY_STATES)[number];

export interface MemorySourceInput {
  readonly type: string;
  readonly reference: string;
  readonly strength?: number;
  readonly confidence?: number;
}

export interface StoredSource {
  readonly assertionId: string;
  readonly type: string;
  readonly reference: string;
  readonly strength: number;
  readonly confidence: number;
  readonly state: "active" | "retracted";
}

export interface StoredDerivation {
  readonly rule: string;
  readonly premises: readonly string[];
}

export interface RememberInput {
  readonly content: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly sources: readonly MemorySourceInput[];
  readonly tree?: string;
  /** JSON of the structured SH tree, persisted so semantic candidates re-decompose on load. */
  readonly shTree?: string;
  /** Sentence polarity from the parse, persisted for candidate re-decomposition. */
  readonly polarity?: string;
  readonly recordedAt?: string;
  readonly id?: string;
}

export interface DeriveInput {
  readonly content: string;
  readonly rule: string;
  readonly premises: readonly string[];
  readonly scope?: MemoryScope;
  readonly kind?: MemoryKind;
  readonly tree?: string;
  /** JSON of the structured SH tree, so a derived conclusion can be matched and linked. */
  readonly shTree?: string;
  /** Sentence polarity from the parse, persisted for candidate re-decomposition. */
  readonly polarity?: string;
  readonly recordedAt?: string;
  readonly id?: string;
}

export interface StoredProposition {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly state: MemoryPropositionState;
  readonly revision: number;
  readonly recordedAt: string;
  readonly tree: string | undefined;
  readonly shTree: string | undefined;
  readonly polarity: string | undefined;
  readonly sources: readonly StoredSource[];
  readonly derivations: readonly StoredDerivation[];
  readonly supersedes: string | undefined;
  readonly supersededBy: string | undefined;
}

export interface RemovalReceipt {
  readonly ok: true;
  readonly id: string;
  readonly mode: "retract";
  readonly revision: number;
  readonly proposition: StoredProposition;
  readonly invalidated: readonly string[];
}

export interface PurgeReceipt {
  readonly ok: true;
  readonly id: string;
  readonly mode: "purge";
  readonly proposition: StoredProposition;
  readonly invalidated: readonly string[];
}

export interface SourceRemovalReceipt {
  readonly ok: true;
  readonly id: string;
  readonly assertionId: string;
  readonly revision: number;
  readonly proposition: StoredProposition;
  readonly invalidated: readonly string[];
}

export interface SupersessionReceipt {
  readonly ok: true;
  readonly superseded: StoredProposition;
  readonly replacement: StoredProposition;
  readonly invalidated: readonly string[];
}

export interface StaleRevisionError {
  readonly ok: false;
  readonly code: "stale_revision";
  readonly id: string;
  readonly expected: number;
  readonly actual: number;
}

export interface NotFoundError {
  readonly ok: false;
  readonly code: "not_found";
  readonly id: string;
}

export type RetractResult = RemovalReceipt | StaleRevisionError | NotFoundError;
export type PurgeResult = PurgeReceipt | StaleRevisionError | NotFoundError;
export type RetractSourceResult =
  | SourceRemovalReceipt
  | StaleRevisionError
  | NotFoundError;
export type SupersedeResult = SupersessionReceipt | StaleRevisionError | NotFoundError;
export type AddSourceResult = StoredProposition | StaleRevisionError | NotFoundError;

interface MutableSource {
  assertionId: string;
  type: string;
  reference: string;
  strength: number;
  confidence: number;
  state: "active" | "retracted";
}

interface MutableRecord {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  state: MemoryPropositionState;
  revision: number;
  recordedAt: string;
  tree: string | undefined;
  shTree: string | undefined;
  polarity: string | undefined;
  repository: string;
  session: string;
  sources: MutableSource[];
  derivations: StoredDerivation[];
  supersedes: string | undefined;
  supersededBy: string | undefined;
}

export interface MemorySpaceOptions {
  /** Clock for the default recordedAt timestamp. Injected for deterministic tests. */
  readonly now?: () => string;
  /** Prefix for generated proposition identifiers. */
  readonly idPrefix?: string;
  /** Durable backing store. Defaults to a non-persistent in-memory store. */
  readonly store?: DurableStore;
  /** Repository identity; isolates project, derived, and session scopes on load. */
  readonly repository?: string;
  /** Session identity; isolates session-scope records between sessions. */
  readonly session?: string;
}

function nonblankString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  if (value.trim() === "") throw new RangeError(`${path} must not be empty`);
  return value;
}

function unitInterval(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${path} must be a finite number within [0, 1]`);
  }
  return value;
}

function assertMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new RangeError(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function validateSources(value: unknown): MemorySourceInput[] {
  assertDenseArray(value, "sources");
  if (value.length === 0) throw new RangeError("sources must contain at least one entry");
  return value.map((raw, index) => {
    const path = `sources[${index}]`;
    assertPlainRecord(raw, path);
    assertKnownKeys(raw, path, ["type", "reference", "strength", "confidence"]);
    return {
      type: nonblankString(raw.type, `${path}.type`),
      reference: nonblankString(raw.reference, `${path}.reference`),
      strength: unitInterval(raw.strength, `${path}.strength`, 1),
      confidence: unitInterval(raw.confidence, `${path}.confidence`, 1),
    };
  });
}

// The scalar fields shared by the working, stored, and persisted record shapes.
// Extracted so adding a field touches one list, not three.
type RecordScalars = Pick<
  MutableRecord,
  | "id"
  | "scope"
  | "kind"
  | "content"
  | "state"
  | "revision"
  | "recordedAt"
  | "tree"
  | "shTree"
  | "polarity"
  | "supersedes"
  | "supersededBy"
>;

function scalarFields(record: MutableRecord): RecordScalars {
  return {
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    content: record.content,
    state: record.state,
    revision: record.revision,
    recordedAt: record.recordedAt,
    tree: record.tree,
    shTree: record.shTree,
    polarity: record.polarity,
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
  };
}

function copySource(source: MutableSource): MutableSource {
  return {
    assertionId: source.assertionId,
    type: source.type,
    reference: source.reference,
    strength: source.strength,
    confidence: source.confidence,
    state: source.state,
  };
}

function copyDerivation(derivation: StoredDerivation): StoredDerivation {
  return { rule: derivation.rule, premises: [...derivation.premises] };
}

function freezeProposition(record: MutableRecord): StoredProposition {
  return Object.freeze({
    ...scalarFields(record),
    sources: Object.freeze(record.sources.map((source) => Object.freeze(copySource(source)))),
    derivations: Object.freeze(
      record.derivations.map((derivation) =>
        Object.freeze({
          rule: derivation.rule,
          premises: Object.freeze([...derivation.premises]),
        }),
      ),
    ),
  });
}

function persistedToMutable(record: PersistedRecord): MutableRecord {
  return {
    id: record.id,
    scope: assertMember(record.scope, MEMORY_SCOPES, "stored scope"),
    kind: assertMember(record.kind, MEMORY_KINDS, "stored kind"),
    content: record.content,
    state: assertMember(record.state, MEMORY_STATES, "stored state"),
    revision: record.revision,
    recordedAt: record.recordedAt,
    tree: record.tree,
    shTree: record.shTree,
    polarity: record.polarity,
    repository: record.repository,
    session: record.session,
    sources: record.sources.map(copySource),
    derivations: record.derivations.map(copyDerivation),
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
  };
}

function mutableToPersisted(record: MutableRecord): PersistedRecord {
  return {
    ...scalarFields(record),
    repository: record.repository,
    session: record.session,
    sources: record.sources.map(copySource),
    derivations: record.derivations.map(copyDerivation),
  };
}

/** A live memory of propositions whose visibility is decided in native MeTTa. */
export class MemorySpace {
  private readonly db: GoalChainerMetta = createGoalChainerMetta();
  private readonly records = new Map<string, MutableRecord>();
  private readonly store: DurableStore;
  private readonly now: () => string;
  private readonly idPrefix: string;
  private readonly idPattern: RegExp;
  private readonly repository: string;
  private readonly session: string;
  private counter = 0;

  constructor(options: MemorySpaceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idPrefix = options.idPrefix ?? "prop";
    this.idPattern = new RegExp(`^${escapeRegExp(this.idPrefix)}-(\\d+)$`);
    this.store = options.store ?? new InMemoryDurableStore();
    this.repository = options.repository ?? "local";
    this.session = options.session ?? "default";
    this.load();
  }

  /** Store one controlled-English proposition with at least one source. */
  remember(input: RememberInput): StoredProposition {
    assertPlainRecord(input, "remember input");
    assertKnownKeys(input, "remember input", [
      "content",
      "scope",
      "kind",
      "sources",
      "tree",
      "shTree",
      "polarity",
      "recordedAt",
      "id",
    ]);
    const content = nonblankString(input.content, "content");
    const scope = assertMember(input.scope, MEMORY_SCOPES, "scope");
    const kind = assertMember(input.kind, MEMORY_KINDS, "kind");
    const sources = validateSources(input.sources);

    const record = this.buildRecord({
      scope,
      kind,
      content,
      tree: input.tree,
      shTree: input.shTree,
      polarity: input.polarity,
      recordedAt: input.recordedAt,
      id: input.id,
    });
    for (const source of sources) this.attachSource(record, source);
    this.commitNew(record, input.id !== undefined);
    return freezeProposition(record);
  }

  /** Store a derived conclusion supported by a proof over existing premises. */
  derive(input: DeriveInput): StoredProposition {
    assertPlainRecord(input, "derive input");
    assertKnownKeys(input, "derive input", [
      "content",
      "rule",
      "premises",
      "scope",
      "kind",
      "tree",
      "shTree",
      "polarity",
      "recordedAt",
      "id",
    ]);
    const content = nonblankString(input.content, "content");
    const rule = nonblankString(input.rule, "rule");
    const premises = this.validatePremises(input.premises);
    const scope =
      input.scope === undefined ? "derived" : assertMember(input.scope, MEMORY_SCOPES, "scope");
    const kind =
      input.kind === undefined
        ? "derived-conclusion"
        : assertMember(input.kind, MEMORY_KINDS, "kind");

    const record = this.buildRecord({
      scope,
      kind,
      content,
      tree: input.tree,
      shTree: input.shTree,
      polarity: input.polarity,
      recordedAt: input.recordedAt,
      id: input.id,
    });
    record.derivations.push({ rule, premises });
    this.commitNew(record, input.id !== undefined);
    return freezeProposition(record);
  }

  /** Record another proof for an existing conclusion. Preserves it if a premise later fails. */
  addProof(id: string, rule: string, premises: readonly string[]): StoredProposition | NotFoundError {
    const record = this.records.get(nonblankString(id, "id"));
    if (record === undefined) return { ok: false, code: "not_found", id };
    const validated = this.validatePremises(premises);
    this.appendDerivation(record, nonblankString(rule, "rule"), validated);
    this.writeState(record, record.state);
    this.persist(record);
    return freezeProposition(record);
  }

  /** Add another supporting assertion so the proposition survives losing one source. */
  addSource(
    id: string,
    source: MemorySourceInput,
    expectedRevision?: number,
  ): AddSourceResult {
    const loaded = this.loadForMutation(id, expectedRevision);
    if ("ok" in loaded) return loaded;
    const record = loaded;
    const [validated] = validateSources([source]);
    this.attachSource(record, validated!);
    this.writeSourceFacts(record, record.sources[record.sources.length - 1]!);
    this.writeState(record, record.state);
    this.persist(record);
    return freezeProposition(record);
  }

  /** Whether the proposition is currently visible, decided by native MeTTa. */
  isActive(id: string): boolean {
    if (!this.records.has(id)) return false;
    return this.queryActive(id);
  }

  /** Read a stored proposition, active or not. */
  get(id: string): StoredProposition | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : freezeProposition(record);
  }

  /** Release the durable store. The live MeTTa space is discarded with the instance. */
  close(): void {
    this.store.close();
  }

  /** Every active proposition identifier across all scopes. */
  activePropositions(): readonly string[] {
    return this.stream(mettaCall("gc-mem-active-proposition"));
  }

  /** Active proposition identifiers in one scope. */
  activeInScope(scope: MemoryScope): readonly string[] {
    return this.stream(mettaCall("gc-mem-active-in-scope", mettaSymbol(assertMember(scope, MEMORY_SCOPES, "scope"))));
  }

  /** Active proposition identifiers of one kind in one scope. */
  activeOfKind(scope: MemoryScope, kind: MemoryKind): readonly string[] {
    return this.stream(
      mettaCall(
        "gc-mem-active-of-kind",
        mettaSymbol(assertMember(scope, MEMORY_SCOPES, "scope")),
        mettaSymbol(assertMember(kind, MEMORY_KINDS, "kind")),
      ),
    );
  }

  /** Make a proposition inactive while preserving its history, and report the cascade. */
  retract(id: string, expectedRevision?: number): RetractResult {
    const loaded = this.loadForMutation(id, expectedRevision);
    if ("ok" in loaded) return loaded;
    const record = loaded;

    const before = new Set(this.activePropositions());
    this.writeState(record, "retracted");
    this.persist(record);
    const invalidated = this.cascade(before, id);
    return {
      ok: true,
      id,
      mode: "retract",
      revision: record.revision,
      proposition: freezeProposition(record),
      invalidated,
    };
  }

  /** Permanently delete a proposition and its content, reporting the dependants it invalidates.
   * Unlike retract, no history survives: the record is removed from the store, the live space,
   * and its content is scrubbed so it cannot be recovered. */
  purge(id: string, expectedRevision?: number): PurgeResult {
    const loaded = this.loadForMutation(id, expectedRevision);
    if ("ok" in loaded) return loaded;
    const record = loaded;

    const before = new Set(this.activePropositions());
    const proposition = freezeProposition(record);
    this.store.purge(id);
    this.removeFacts(record);
    this.records.delete(id);
    const invalidated = this.cascade(before, id);
    return { ok: true, id, mode: "purge", proposition, invalidated };
  }

  /** Retract one supporting assertion. The proposition survives if another stays active. */
  retractSource(
    id: string,
    assertionId: string,
    expectedRevision?: number,
  ): RetractSourceResult {
    const record = this.records.get(nonblankString(id, "id"));
    if (record === undefined) return { ok: false, code: "not_found", id };
    const source = record.sources.find((entry) => entry.assertionId === assertionId);
    if (source === undefined) return { ok: false, code: "not_found", id: assertionId };
    const stale = this.checkRevision(record, expectedRevision);
    if (stale !== undefined) return stale;

    const before = new Set(this.activePropositions());
    if (source.state === "active") {
      this.db.remove(
        mettaCall("MemoryAssertionState", mettaSymbol(id), mettaSymbol(assertionId), mettaSymbol("active")),
      );
      this.db.add(
        mettaCall("MemoryAssertionState", mettaSymbol(id), mettaSymbol(assertionId), mettaSymbol("retracted")),
      );
      source.state = "retracted";
    }
    this.writeState(record, record.state);
    this.persist(record);
    const invalidated = this.cascade(before, id);
    return {
      ok: true,
      id,
      assertionId,
      revision: record.revision,
      proposition: freezeProposition(record),
      invalidated,
    };
  }

  /** Replace a proposition with a correction, retract the old one, and recompute dependants. */
  supersede(
    oldId: string,
    replacement: RememberInput,
    expectedRevision?: number,
  ): SupersedeResult {
    const loaded = this.loadForMutation(oldId, expectedRevision);
    if ("ok" in loaded) return loaded;
    const oldRecord = loaded;

    return this.store.transaction(() => {
      const before = new Set(this.activePropositions());
      const created = this.remember(replacement);
      const newRecord = this.records.get(created.id)!;
      newRecord.supersedes = oldId;
      oldRecord.supersededBy = created.id;
      this.db.add(mettaCall("MemorySupersedes", mettaSymbol(created.id), mettaSymbol(oldId)));
      this.writeState(oldRecord, "superseded");
      this.persist(newRecord);
      this.persist(oldRecord);
      const invalidated = this.cascade(before, oldId);
      return {
        ok: true,
        superseded: freezeProposition(oldRecord),
        replacement: freezeProposition(newRecord),
        invalidated,
      };
    });
  }

  // --- construction and durable rebuild ---

  // Load in-scope records from the durable store and rebuild the live MeTTa facts.
  // The counter is seeded past the highest generated id across every record and the
  // store's persisted high-water mark, so a new id never collides with an
  // out-of-scope record nor reuses a purged id after a restart.
  private load(): void {
    const all = this.store.allRecords();
    this.counter = Math.max(this.maxGeneratedCounter(all), this.store.idCounter(this.idPrefix));
    for (const persisted of all) {
      if (!this.inScope(persisted.scope, persisted.repository, persisted.session)) continue;
      const record = persistedToMutable(persisted);
      this.records.set(record.id, record);
      this.rebuildFacts(record);
    }
  }

  private inScope(scope: string, repository: string, session: string): boolean {
    switch (scope) {
      case "user":
        return true;
      case "project":
      case "derived":
        return repository === this.repository;
      case "session":
        return repository === this.repository && session === this.session;
      default:
        return false;
    }
  }

  private maxGeneratedCounter(records: readonly PersistedRecord[]): number {
    let max = 0;
    for (const record of records) {
      max = Math.max(max, this.idOrdinal(record.id));
    }
    return max;
  }

  // The numeric suffix of a `<prefix>-<n>` id, or 0 for a caller-supplied id that
  // does not follow the generated form.
  private idOrdinal(id: string): number {
    const match = this.idPattern.exec(id);
    return match === null ? 0 : Number(match[1]);
  }

  // --- internal encoding and query helpers ---

  private buildRecord(fields: {
    scope: MemoryScope;
    kind: MemoryKind;
    content: string;
    tree: string | undefined;
    shTree: string | undefined;
    polarity: string | undefined;
    recordedAt: string | undefined;
    id: string | undefined;
  }): MutableRecord {
    const tree = fields.tree === undefined ? undefined : nonblankString(fields.tree, "tree");
    const recordedAt =
      fields.recordedAt === undefined ? this.now() : nonblankString(fields.recordedAt, "recordedAt");
    return {
      id: this.resolveNewId(fields.id),
      scope: fields.scope,
      kind: fields.kind,
      content: fields.content,
      state: "active",
      revision: 1,
      recordedAt,
      tree,
      shTree: fields.shTree,
      polarity: fields.polarity,
      repository: this.repository,
      session: this.session,
      sources: [],
      derivations: [],
      supersedes: undefined,
      supersededBy: undefined,
    };
  }

  private resolveNewId(requested: string | undefined): string {
    if (requested !== undefined) {
      const id = nonblankString(requested, "id");
      if (this.records.has(id)) throw new RangeError(`proposition id already exists: ${id}`);
      return id;
    }
    return this.nextGeneratedId();
  }

  private nextGeneratedId(): string {
    let id: string;
    do {
      this.counter += 1;
      id = `${this.idPrefix}-${this.counter}`;
    } while (this.records.has(id));
    return id;
  }

  // Persist a freshly built record. A generated id that collides with an
  // out-of-scope record (a concurrent client) is regenerated; a caller-supplied
  // id that collides is a hard error. Only then are the live facts written.
  private commitNew(record: MutableRecord, userProvidedId: boolean): void {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.store.insert(mutableToPersisted(record));
        break;
      } catch (error) {
        if (!(error instanceof IdConflictError)) throw error;
        if (userProvidedId) throw new RangeError(`proposition id already exists: ${record.id}`);
        if (attempt > 100000) throw error;
        this.reassignGeneratedId(record);
      }
    }
    this.records.set(record.id, record);
    this.rebuildFacts(record);
    // Raise the durable high-water mark so purging this record later cannot free
    // its id for a colliding reuse after a restart.
    this.store.bumpIdCounter(this.idPrefix, Math.max(this.counter, this.idOrdinal(record.id)));
  }

  private reassignGeneratedId(record: MutableRecord): void {
    record.id = this.nextGeneratedId();
    record.sources.forEach((source, index) => {
      source.assertionId = `${record.id}-s${index + 1}`;
    });
  }

  private validatePremises(value: unknown): string[] {
    assertDenseArray(value, "premises");
    if (value.length === 0) throw new RangeError("premises must contain at least one entry");
    return value.map((premise, index) => {
      const id = nonblankString(premise, `premises[${index}]`);
      if (!this.records.has(id)) {
        throw new RangeError(`premise does not exist: ${id}`);
      }
      return id;
    });
  }

  // Attach a source to the record in memory. The MeTTa facts are written by
  // rebuildFacts on create and by writeSourceFacts on a later addSource.
  private attachSource(record: MutableRecord, source: MemorySourceInput): void {
    record.sources.push({
      assertionId: `${record.id}-s${record.sources.length + 1}`,
      type: source.type,
      reference: source.reference,
      strength: source.strength ?? 1,
      confidence: source.confidence ?? 1,
      state: "active",
    });
  }

  // Write every ground fact for a record: proposition, content, state, timestamp,
  // tree, each source, each derivation, and supersession. Used on create and on
  // durable rebuild, so it must honor the record's actual state, not assume active.
  private rebuildFacts(record: MutableRecord): void {
    this.writePropositionFacts(record);
    for (const source of record.sources) this.writeSourceFacts(record, source);
    for (const derivation of record.derivations) this.writeDerivationFacts(record, derivation);
    if (record.supersedes !== undefined) {
      this.db.add(mettaCall("MemorySupersedes", mettaSymbol(record.id), mettaSymbol(record.supersedes)));
    }
  }

  // Remove every ground fact for a record. Mirrors rebuildFacts so purge leaves no
  // trace of the proposition in the live space. GoalChainerMetta.remove takes one
  // atom at a time, so each fact is removed with its own call.
  private removeFacts(record: MutableRecord): void {
    this.db.remove(mettaCall("MemoryProposition", mettaSymbol(record.id), mettaSymbol(record.scope), mettaSymbol(record.kind)));
    this.db.remove(mettaCall("MemoryContent", mettaSymbol(record.id), mettaString(record.content)));
    this.db.remove(mettaCall("MemoryState", mettaSymbol(record.id), mettaSymbol(record.state), mettaInteger(record.revision)));
    this.db.remove(mettaCall("MemoryRecordedAt", mettaSymbol(record.id), mettaString(record.recordedAt)));
    if (record.tree !== undefined) {
      this.db.remove(mettaCall("MemoryTree", mettaSymbol(record.id), mettaString(record.tree)));
    }
    for (const source of record.sources) {
      this.db.remove(mettaCall("MemorySource", mettaSymbol(record.id), mettaSymbol(source.assertionId), mettaSymbol(source.type), mettaString(source.reference)));
      this.db.remove(mettaCall("MemoryAssertionState", mettaSymbol(record.id), mettaSymbol(source.assertionId), mettaSymbol(source.state)));
      this.db.remove(mettaCall("MemorySourceTruth", mettaSymbol(record.id), mettaSymbol(source.assertionId), mettaFloat(source.strength), mettaFloat(source.confidence)));
    }
    for (const derivation of record.derivations) {
      this.db.remove(
        mettaCall(
          "MemoryDerivation",
          mettaSymbol(record.id),
          mettaSymbol(derivation.rule),
          mettaTuple(derivation.premises.map((premise) => mettaSymbol(premise))),
        ),
      );
    }
    if (record.supersedes !== undefined) {
      this.db.remove(mettaCall("MemorySupersedes", mettaSymbol(record.id), mettaSymbol(record.supersedes)));
    }
    if (record.supersededBy !== undefined) {
      this.db.remove(mettaCall("MemorySupersedes", mettaSymbol(record.supersededBy), mettaSymbol(record.id)));
    }
  }

  private writePropositionFacts(record: MutableRecord): void {
    this.db.add(
      mettaCall(
        "MemoryProposition",
        mettaSymbol(record.id),
        mettaSymbol(record.scope),
        mettaSymbol(record.kind),
      ),
      mettaCall("MemoryContent", mettaSymbol(record.id), mettaString(record.content)),
      mettaCall("MemoryState", mettaSymbol(record.id), mettaSymbol(record.state), mettaInteger(record.revision)),
      mettaCall("MemoryRecordedAt", mettaSymbol(record.id), mettaString(record.recordedAt)),
    );
    if (record.tree !== undefined) {
      this.db.add(mettaCall("MemoryTree", mettaSymbol(record.id), mettaString(record.tree)));
    }
  }

  private writeSourceFacts(record: MutableRecord, source: MutableSource): void {
    this.db.add(
      mettaCall(
        "MemorySource",
        mettaSymbol(record.id),
        mettaSymbol(source.assertionId),
        mettaSymbol(source.type),
        mettaString(source.reference),
      ),
      mettaCall(
        "MemoryAssertionState",
        mettaSymbol(record.id),
        mettaSymbol(source.assertionId),
        mettaSymbol(source.state),
      ),
      mettaCall(
        "MemorySourceTruth",
        mettaSymbol(record.id),
        mettaSymbol(source.assertionId),
        mettaFloat(source.strength),
        mettaFloat(source.confidence),
      ),
    );
  }

  private appendDerivation(record: MutableRecord, rule: string, premises: readonly string[]): void {
    const derivation: StoredDerivation = { rule, premises: [...premises] };
    record.derivations.push(derivation);
    this.writeDerivationFacts(record, derivation);
  }

  private writeDerivationFacts(record: MutableRecord, derivation: StoredDerivation): void {
    this.db.add(
      mettaCall(
        "MemoryDerivation",
        mettaSymbol(record.id),
        mettaSymbol(derivation.rule),
        mettaTuple(derivation.premises.map((premise) => mettaSymbol(premise))),
      ),
    );
  }

  // Rewrite the single MemoryState fact, moving to the given state and bumping the revision.
  // Passing the current state records a change to a source or proof without a state change.
  private writeState(record: MutableRecord, state: MemoryPropositionState): void {
    this.db.remove(
      mettaCall("MemoryState", mettaSymbol(record.id), mettaSymbol(record.state), mettaInteger(record.revision)),
    );
    record.state = state;
    record.revision += 1;
    this.db.add(
      mettaCall("MemoryState", mettaSymbol(record.id), mettaSymbol(record.state), mettaInteger(record.revision)),
    );
  }

  private persist(record: MutableRecord): void {
    this.store.save(mutableToPersisted(record));
  }

  // Load a record for a guarded mutation: reject an unknown id or a stale expected revision.
  // Returns the record on success, or the typed error the caller forwards.
  private loadForMutation(
    id: string,
    expectedRevision: number | undefined,
  ): MutableRecord | NotFoundError | StaleRevisionError {
    const record = this.records.get(nonblankString(id, "id"));
    if (record === undefined) return { ok: false, code: "not_found", id };
    const stale = this.checkRevision(record, expectedRevision);
    if (stale !== undefined) return stale;
    return record;
  }

  private checkRevision(
    record: MutableRecord,
    expectedRevision: number | undefined,
  ): StaleRevisionError | undefined {
    if (expectedRevision === undefined) return undefined;
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new TypeError("expected revision must be a safe integer");
    }
    if (expectedRevision !== record.revision) {
      return {
        ok: false,
        code: "stale_revision",
        id: record.id,
        expected: expectedRevision,
        actual: record.revision,
      };
    }
    return undefined;
  }

  private cascade(before: ReadonlySet<string>, directId: string): readonly string[] {
    const after = new Set(this.activePropositions());
    const invalidated: string[] = [];
    for (const id of before) {
      if (id !== directId && !after.has(id)) invalidated.push(id);
    }
    return Object.freeze(invalidated.sort());
  }

  private queryActive(id: string): boolean {
    const result = this.db.evalJs(mettaCall("gc-mem-active", mettaSymbol(id)));
    if (result.length !== 1 || typeof result[0] !== "boolean") {
      throw new Error(`gc-mem-active returned an unexpected result for ${id}`);
    }
    return result[0];
  }

  private stream(call: ReturnType<typeof mettaCall>): readonly string[] {
    const ids = this.db.evalJs(call);
    for (const value of ids) {
      if (typeof value !== "string") {
        throw new Error("memory stream returned a non-identifier result");
      }
    }
    return Object.freeze([...(ids as string[])].sort());
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Create an empty live memory space. */
export function createMemorySpace(options?: MemorySpaceOptions): MemorySpace {
  return new MemorySpace(options);
}
