// Canonical MeTTa projections of the durable proposition log.
//
// Agent Orchestrator allocates the paths and owns access to them. Oh My Goals
// writes only proposition facts that belong in each view: one stable agent's
// session facts in the private file, and project plus derived facts in the shared
// file. SQLite remains the recovery log. These files are replaceable reasoning
// projections for orchestration and UI readers.

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { PersistedRecord } from "./durable_store.js";
import { memoryRecordFacts } from "./memory.js";
import {
  formatMettaTerm,
  mettaCall,
  mettaString,
  mettaSymbol,
} from "./metta.js";

export const ATOMSPACE_SNAPSHOT_VERSION = "oh-my-goals-atomspace-v1";
export const MAX_ATOMSPACE_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export type AtomspaceSnapshotKind = "agent" | "project";

export interface AtomspaceSnapshotOptions {
  readonly repository: string;
  readonly agent?: string;
  readonly agentPath?: string;
  readonly projectPath?: string;
  /** SQLite lock wait. Exposed for deterministic contention tests. */
  readonly lockTimeoutMs?: number;
}

interface LockDatabase {
  exec(sql: string): void;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => LockDatabase;
}

const require = createRequire(import.meta.url);

function sqlite(): SqliteModule {
  return require("node:sqlite") as SqliteModule;
}

function boundedIdentity(value: string, name: string): string {
  if (value.trim() === "") throw new RangeError(`${name} must not be blank`);
  if (Buffer.byteLength(value, "utf8") > 1024) {
    throw new RangeError(`${name} must be at most 1024 UTF-8 bytes`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RangeError(`${name} must not contain control characters`);
  }
  return value;
}

function snapshotPath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new RangeError(`${name} must be an absolute path`);
  if (value.includes("\0")) throw new RangeError(`${name} must not contain NUL`);
  if (Buffer.byteLength(value, "utf8") > 4096) {
    throw new RangeError(`${name} must be at most 4096 UTF-8 bytes`);
  }
  return resolve(value);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertRegularOrMissing(path: string, name: string): void {
  const status = lstatIfPresent(path);
  if (status === undefined) return;
  if (status.isSymbolicLink()) throw new Error(`${name} must not be a symbolic link: ${path}`);
  if (!status.isFile()) throw new Error(`${name} must be a regular file: ${path}`);
}

function assertSecureParent(path: string): void {
  const parent = dirname(path);
  const status = statSync(parent);
  if (!status.isDirectory()) throw new Error(`snapshot parent must be a directory: ${parent}`);
  if (realpathSync(parent) !== resolve(parent)) {
    throw new Error(`snapshot parent must not contain symbolic links: ${parent}`);
  }
}

function ensureLockFile(path: string): void {
  assertRegularOrMissing(path, "snapshot lock");
  const flags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  try {
    const status = fstatSync(fd);
    if (!status.isFile()) throw new Error(`snapshot lock must be a regular file: ${path}`);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

function writeReplacement(path: string, contents: string): void {
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > MAX_ATOMSPACE_SNAPSHOT_BYTES) {
    throw new RangeError(
      `atomspace snapshot exceeds ${MAX_ATOMSPACE_SNAPSHOT_BYTES} bytes`,
    );
  }
  assertRegularOrMissing(path, "snapshot target");
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, contents, { encoding: "utf8" });
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertRegularOrMissing(path, "snapshot target");
    renameSync(temp, path);
    const parentFd = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

/** Render a deterministic standalone MeTTa snapshot. */
export function renderAtomspaceSnapshot(
  kind: AtomspaceSnapshotKind,
  repository: string,
  agent: string | undefined,
  records: readonly PersistedRecord[],
): string {
  const selected = records.filter((record) => {
    if (record.repository !== repository || record.scope === "user") return false;
    if (kind === "agent") {
      return record.scope === "session" && record.session === agent;
    }
    return record.scope === "project" || record.scope === "derived";
  });
  const ids = new Set(selected.map((record) => record.id));
  const facts = selected
    .flatMap((record) => memoryRecordFacts(record, ids))
    .map(formatMettaTerm)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
  const header = formatMettaTerm(
    mettaCall(
      "MemorySnapshot",
      mettaSymbol(ATOMSPACE_SNAPSHOT_VERSION),
      mettaSymbol(kind),
      mettaString(repository),
      mettaString(agent ?? ""),
    ),
  );
  return `${[header, ...facts].join("\n")}\n`;
}

/** Serialize snapshot writers with a persistent SQLite lock sidecar. */
export class AtomspaceSnapshots {
  readonly #repository: string;
  readonly #agent: string | undefined;
  readonly #agentPath: string | undefined;
  readonly #projectPath: string | undefined;
  readonly #lockTimeoutMs: number;

  constructor(options: AtomspaceSnapshotOptions) {
    this.#repository = boundedIdentity(options.repository, "repository");
    this.#agent =
      options.agent === undefined ? undefined : boundedIdentity(options.agent, "agent");
    this.#agentPath =
      options.agentPath === undefined
        ? undefined
        : snapshotPath(options.agentPath, "agent atomspace path");
    this.#projectPath =
      options.projectPath === undefined
        ? undefined
        : snapshotPath(options.projectPath, "project atomspace path");
    if (this.#agentPath !== undefined && this.#agent === undefined) {
      throw new RangeError("agent is required when agent atomspace path is set");
    }
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.#lockTimeoutMs) || this.#lockTimeoutMs < 0) {
      throw new RangeError("lockTimeoutMs must be a non-negative safe integer");
    }
  }

  /** Refresh every configured view from a fresh durable read taken under its lock. */
  refresh(readRecords: () => readonly PersistedRecord[]): void {
    if (this.#agentPath !== undefined) {
      this.#replace(this.#agentPath, () =>
        renderAtomspaceSnapshot(
          "agent",
          this.#repository,
          this.#agent,
          readRecords(),
        ),
      );
    }
    if (this.#projectPath !== undefined) {
      this.#replace(this.#projectPath, () =>
        renderAtomspaceSnapshot(
          "project",
          this.#repository,
          undefined,
          readRecords(),
        ),
      );
    }
  }

  #replace(path: string, render: () => string): void {
    assertSecureParent(path);
    assertRegularOrMissing(path, "snapshot target");
    const lockPath = `${path}.lock`;
    ensureLockFile(lockPath);
    const { DatabaseSync } = sqlite();
    const lock = new DatabaseSync(lockPath);
    let began = false;
    try {
      lock.exec(`PRAGMA busy_timeout = ${this.#lockTimeoutMs}`);
      lock.exec("PRAGMA journal_mode = DELETE");
      lock.exec("PRAGMA synchronous = FULL");
      lock.exec("CREATE TABLE IF NOT EXISTS snapshot_lock (id INTEGER PRIMARY KEY)");
      lock.exec("BEGIN IMMEDIATE");
      began = true;
      writeReplacement(path, render());
      lock.exec("COMMIT");
      began = false;
    } catch (error) {
      if (began) {
        try {
          lock.exec("ROLLBACK");
        } catch {
          // Preserve the original write or lock error.
        }
      }
      throw error;
    } finally {
      lock.close();
      if (lstatIfPresent(lockPath)?.isFile()) {
        const fd = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          fchmodSync(fd, 0o600);
        } finally {
          closeSync(fd);
        }
      }
    }
  }
}
