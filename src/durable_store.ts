// Durable persistence for memory records. The MeTTa space is the live reasoning
// state; this store preserves records across restarts and supports several MCP
// processes reading one local memory. On startup the memory space loads records
// from here and rebuilds the live space and the semantic index. Every mutation
// writes a durable transaction so a crash leaves a consistent state to rebuild
// from.
//
// SQLite in WAL mode is the file-backed implementation because concurrent stdio
// MCP processes may share one database: WAL gives concurrent readers and a
// serialized writer. secure_delete zeroes purged content so a forgotten
// proposition cannot be recovered from freed pages. The interface is narrow so a
// MeTTa-native backend could replace it later. An in-memory implementation backs
// tests and ephemeral use.
//
// The store uses node:sqlite, built into Node and usable without a flag from Node
// 22.13.0 (the package's engines floor). It is loaded through createRequire so the
// experimental-feature warning fires only when a SQLite store is actually opened,
// keeping it off the path of consumers that use the in-memory store.

import { createRequire } from "node:module";

export interface PersistedSource {
  readonly assertionId: string;
  readonly type: string;
  readonly reference: string;
  readonly strength: number;
  readonly confidence: number;
  readonly state: "active" | "retracted";
}

export interface PersistedDerivation {
  readonly rule: string;
  readonly premises: readonly string[];
}

export interface PersistedRecord {
  readonly id: string;
  readonly scope: string;
  readonly kind: string;
  readonly content: string;
  readonly state: string;
  readonly revision: number;
  readonly recordedAt: string;
  /** Typed-MeTTa rendering of the SH tree, written as the MemoryTree fact. */
  readonly tree: string | undefined;
  /** JSON of the structured SH tree, so candidates re-decompose on load. */
  readonly shTree: string | undefined;
  /** Sentence polarity carried from the parse, for candidate re-decomposition. */
  readonly polarity: string | undefined;
  /** Repository identity; isolates project, derived, and session scopes. */
  readonly repository: string;
  /** Session identity; isolates session-scope records between sessions. */
  readonly session: string;
  readonly supersedes: string | undefined;
  readonly supersededBy: string | undefined;
  readonly sources: readonly PersistedSource[];
  readonly derivations: readonly PersistedDerivation[];
}

/** Thrown by `insert` when a record id already exists. Generated ids retry with a
 * bumped counter; a caller-supplied id surfaces this as a hard error. */
export class IdConflictError extends Error {
  constructor(readonly id: string) {
    super(`durable record already exists: ${id}`);
    this.name = "IdConflictError";
  }
}

/** Narrow durable-record store. Implementations must be crash-consistent at the
 * transaction boundary and must make purge unrecoverable. */
export interface DurableStore {
  /** Every stored record, for rebuilding the live space on startup. */
  allRecords(): PersistedRecord[];
  /** Insert a new record, throwing {@link IdConflictError} if the id exists. */
  insert(record: PersistedRecord): void;
  /** Insert or replace one record and its sources and derivations. */
  save(record: PersistedRecord): void;
  /** Permanently remove a record so its content cannot be recovered. */
  purge(id: string): void;
  /** Run a function as one atomic durable transaction. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

function cloneRecord(record: PersistedRecord): PersistedRecord {
  return {
    ...record,
    sources: record.sources.map((source) => ({ ...source })),
    derivations: record.derivations.map((derivation) => ({
      rule: derivation.rule,
      premises: [...derivation.premises],
    })),
  };
}

/** Non-persistent store for tests and ephemeral memory. */
export class InMemoryDurableStore implements DurableStore {
  #records = new Map<string, PersistedRecord>();

  allRecords(): PersistedRecord[] {
    return [...this.#records.values()].map(cloneRecord);
  }

  insert(record: PersistedRecord): void {
    if (this.#records.has(record.id)) throw new IdConflictError(record.id);
    this.#records.set(record.id, cloneRecord(record));
  }

  save(record: PersistedRecord): void {
    this.#records.set(record.id, cloneRecord(record));
  }

  purge(id: string): void {
    this.#records.delete(id);
  }

  transaction<T>(fn: () => T): T {
    // A single-process in-memory store has no partial-write window to guard.
    return fn();
  }

  close(): void {
    this.#records.clear();
  }
}

// Minimal shape of the node:sqlite objects this store uses.
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS proposition (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  tree TEXT,
  sh_tree TEXT,
  polarity TEXT,
  repository TEXT NOT NULL,
  session TEXT NOT NULL,
  supersedes TEXT,
  superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS source (
  proposition_id TEXT NOT NULL,
  assertion_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  type TEXT NOT NULL,
  reference TEXT NOT NULL,
  strength REAL NOT NULL,
  confidence REAL NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (proposition_id, assertion_id),
  FOREIGN KEY (proposition_id) REFERENCES proposition(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS derivation (
  proposition_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  rule TEXT NOT NULL,
  premises TEXT NOT NULL,
  PRIMARY KEY (proposition_id, ordinal),
  FOREIGN KEY (proposition_id) REFERENCES proposition(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS proposition_scope ON proposition(scope, repository, session);
`;

interface PropositionRow {
  id: string;
  scope: string;
  kind: string;
  content: string;
  state: string;
  revision: number;
  recorded_at: string;
  tree: string | null;
  sh_tree: string | null;
  polarity: string | null;
  repository: string;
  session: string;
  supersedes: string | null;
  superseded_by: string | null;
}
interface SourceRow {
  proposition_id: string;
  assertion_id: string;
  ordinal: number;
  type: string;
  reference: string;
  strength: number;
  confidence: number;
  state: string;
}
interface DerivationRow {
  proposition_id: string;
  ordinal: number;
  rule: string;
  premises: string;
}

export interface SqliteDurableStoreOptions {
  /** Milliseconds a writer waits for the lock before failing, for concurrent clients. */
  readonly busyTimeoutMs?: number;
}

/** SQLite (WAL) durable store. Opens or creates the database at `path`. */
export class SqliteDurableStore implements DurableStore {
  readonly #db: SqliteDatabase;
  #depth = 0;

  constructor(path: string, options: SqliteDurableStoreOptions = {}) {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA secure_delete = ON");
    this.#db.exec(`PRAGMA busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? 5000)}`);
    this.#db.exec(SCHEMA);
  }

  allRecords(): PersistedRecord[] {
    const propositions = this.#db.prepare("SELECT * FROM proposition").all() as PropositionRow[];
    const sources = this.#db
      .prepare("SELECT * FROM source ORDER BY proposition_id, ordinal")
      .all() as SourceRow[];
    const derivations = this.#db
      .prepare("SELECT * FROM derivation ORDER BY proposition_id, ordinal")
      .all() as DerivationRow[];

    const sourcesBy = new Map<string, PersistedSource[]>();
    for (const row of sources) {
      const list = sourcesBy.get(row.proposition_id) ?? [];
      list.push({
        assertionId: row.assertion_id,
        type: row.type,
        reference: row.reference,
        strength: row.strength,
        confidence: row.confidence,
        state: row.state === "retracted" ? "retracted" : "active",
      });
      sourcesBy.set(row.proposition_id, list);
    }
    const derivationsBy = new Map<string, PersistedDerivation[]>();
    for (const row of derivations) {
      const list = derivationsBy.get(row.proposition_id) ?? [];
      list.push({ rule: row.rule, premises: JSON.parse(row.premises) as string[] });
      derivationsBy.set(row.proposition_id, list);
    }
    return propositions.map((row) => ({
      id: row.id,
      scope: row.scope,
      kind: row.kind,
      content: row.content,
      state: row.state,
      revision: row.revision,
      recordedAt: row.recorded_at,
      tree: row.tree ?? undefined,
      shTree: row.sh_tree ?? undefined,
      polarity: row.polarity ?? undefined,
      repository: row.repository,
      session: row.session,
      supersedes: row.supersedes ?? undefined,
      supersededBy: row.superseded_by ?? undefined,
      sources: sourcesBy.get(row.id) ?? [],
      derivations: derivationsBy.get(row.id) ?? [],
    }));
  }

  insert(record: PersistedRecord): void {
    this.transaction(() => {
      // Existence check inside the write transaction is atomic under WAL's single
      // writer, so a concurrent client cannot slip a colliding id in between.
      const exists = this.#db.prepare("SELECT 1 FROM proposition WHERE id = ?").get(record.id);
      if (exists !== undefined) throw new IdConflictError(record.id);
      this.#writeRecord(record, false);
    });
  }

  save(record: PersistedRecord): void {
    this.transaction(() => this.#writeRecord(record, true));
  }

  #writeRecord(record: PersistedRecord, replace: boolean): void {
    const verb = replace ? "INSERT OR REPLACE" : "INSERT";
    this.#db
      .prepare(
        `${verb} INTO proposition
           (id, scope, kind, content, state, revision, recorded_at, tree, sh_tree, polarity, repository, session, supersedes, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.scope,
        record.kind,
        record.content,
        record.state,
        record.revision,
        record.recordedAt,
        record.tree ?? null,
        record.shTree ?? null,
        record.polarity ?? null,
        record.repository,
        record.session,
        record.supersedes ?? null,
        record.supersededBy ?? null,
      );
    this.#db.prepare("DELETE FROM source WHERE proposition_id = ?").run(record.id);
    const insertSource = this.#db.prepare(
      `INSERT INTO source
         (proposition_id, assertion_id, ordinal, type, reference, strength, confidence, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    record.sources.forEach((source, ordinal) => {
      insertSource.run(
        record.id,
        source.assertionId,
        ordinal,
        source.type,
        source.reference,
        source.strength,
        source.confidence,
        source.state,
      );
    });
    this.#db.prepare("DELETE FROM derivation WHERE proposition_id = ?").run(record.id);
    const insertDerivation = this.#db.prepare(
      "INSERT INTO derivation (proposition_id, ordinal, rule, premises) VALUES (?, ?, ?, ?)",
    );
    record.derivations.forEach((derivation, ordinal) => {
      insertDerivation.run(record.id, ordinal, derivation.rule, JSON.stringify(derivation.premises));
    });
  }

  purge(id: string): void {
    this.transaction(() => {
      // Foreign keys cascade the delete to source and derivation; secure_delete
      // zeroes the freed pages so the content cannot be recovered.
      this.#db.prepare("DELETE FROM proposition WHERE id = ?").run(id);
    });
    // Flush the write-ahead log into the main database and truncate it so the
    // purged text does not linger in the WAL file.
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#db.exec("BEGIN");
    this.#depth += 1;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  close(): void {
    this.#db.close();
  }
}

/** Open the SQLite durable store at `path`, creating it if needed. */
export function openSqliteStore(path: string, options?: SqliteDurableStoreOptions): SqliteDurableStore {
  return new SqliteDurableStore(path, options);
}
