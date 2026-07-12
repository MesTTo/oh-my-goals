// Resolve caller-supplied policy norms on the @metta-ts interpreter.

import { If, Match, and, names, or, vars } from "@metta-ts/edsl";

import { addTerms, mettaDB, type MettaDB } from "./engine.js";
import { createNorm, type Norm, type NormMode } from "./models.js";
import { assertDenseArray } from "./records.js";

export const NORM_STATUSES = Object.freeze([
  "unregulated",
  "permitted",
  "obligated",
  "forbidden",
  "conflict",
] as const);

export type NormStatus = (typeof NORM_STATUSES)[number];

const NORM_MODES: ReadonlySet<string> = new Set<NormMode>(["forbid", "oblige", "permit"]);
const STATUS_SET: ReadonlySet<string> = new Set(NORM_STATUSES);

type DeonticName =
  | NormStatus
  | "policy-norm"
  | "has-policy-mode"
  | "norm-resolution-status";

const n = names<DeonticName>();
const policyNorm = n["policy-norm"];
const hasPolicyMode = n["has-policy-mode"];
const normResolutionStatus = n["norm-resolution-status"];

/** The highest-priority policy result for one action. */
export class NormResolution {
  readonly reasons: readonly string[];

  constructor(
    readonly status: NormStatus,
    reasons: readonly string[],
    readonly priority: number,
  ) {
    if (!STATUS_SET.has(status)) {
      throw new TypeError(`unsupported norm resolution status: ${String(status)}`);
    }
    assertDenseArray(reasons, "norm resolution reasons");
    reasons.forEach((reason, index) => {
      if (typeof reason !== "string") {
        throw new TypeError(`norm resolution reasons[${index}] must be a string`);
      }
    });
    if (!Number.isSafeInteger(priority)) {
      throw new RangeError("norm resolution priority must be a safe integer");
    }
    this.reasons = Object.freeze([...reasons]);
    Object.freeze(this);
  }

  get blocksAction(): boolean {
    return this.status === "forbidden" || this.status === "conflict";
  }
}

interface NormDatabase {
  readonly db: MettaDB;
  readonly indexedNorms: readonly Norm[];
}

function validateNorms(norms: readonly Norm[]): void {
  assertDenseArray(norms, "norms");
  norms.forEach((norm, index) => {
    for (const [field, value] of [
      ["id", norm.id],
      ["targetAction", norm.targetAction],
      ["reason", norm.reason],
    ] as const) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(`norm at index ${index} ${field} must be a nonblank string`);
      }
    }
    if (!NORM_MODES.has(norm.mode)) {
      throw new TypeError(`norm at index ${index} has unsupported mode: ${String(norm.mode)}`);
    }
    if (!Number.isInteger(norm.priority)) {
      throw new RangeError(`norm at index ${index} has non-integer priority: ${norm.priority}`);
    }
    if (!Number.isSafeInteger(norm.priority)) {
      throw new RangeError(`norm at index ${index} has unsafe integer priority: ${norm.priority}`);
    }
  });
}

function validateActionIds(actionIds: readonly string[]): void {
  assertDenseArray(actionIds, "action ids");
  const seen = new Set<string>();
  for (const actionId of actionIds) {
    if (typeof actionId !== "string" || actionId.trim() === "") {
      throw new TypeError("action ids must contain nonblank strings");
    }
    if (seen.has(actionId)) throw new TypeError(`duplicate action id: ${actionId}`);
    seen.add(actionId);
  }
}

function createNormDatabase(norms: readonly Norm[]): NormDatabase {
  assertDenseArray(norms, "norms");
  const indexedNorms = Object.freeze(norms.map((norm) => createNorm(norm)));
  validateNorms(indexedNorms);
  const normIds = new Set<string>();
  for (const norm of indexedNorms) {
    if (normIds.has(norm.id)) throw new RangeError(`duplicate norm ID: ${norm.id}`);
    normIds.add(norm.id);
  }
  const db = mettaDB();
  addTerms(
    db,
    indexedNorms.map((norm, index) =>
      policyNorm(norm.targetAction, index, norm.mode, norm.priority, norm.reason),
    ),
  );

  const { action, index, mode, priority, reason } = vars<{
    action: string;
    index: number;
    mode: NormMode;
    priority: number;
    reason: string;
  }>();
  db.rule(
    hasPolicyMode(action, priority, mode),
    Match(policyNorm(action, index, mode, priority, reason), true),
  );

  const { hasForbid, hasPermit, hasOblige } = vars<{
    hasForbid: boolean;
    hasPermit: boolean;
    hasOblige: boolean;
  }>();
  db.rule(
    normResolutionStatus(hasForbid, hasPermit, hasOblige),
    If(
      and(hasForbid, or(hasPermit, hasOblige)),
      n.conflict,
      If(hasForbid, n.forbidden, If(hasOblige, n.obligated, n.permitted)),
    ),
  );

  return { db, indexedNorms };
}

function resolveFromDatabase(actionId: string, database: NormDatabase): NormResolution {
  const { db, indexedNorms } = database;
  const { index, mode, priority, reason } = vars<{
    index: number;
    mode: NormMode;
    priority: number;
    reason: string;
  }>();
  const applicable = db.query(
    policyNorm(actionId, index, mode, priority, reason),
    { index, mode, priority, reason },
  );
  if (applicable.length === 0) return new NormResolution("unregulated", [], 0);

  let maxPriority = applicable[0]!.priority;
  if (!Number.isSafeInteger(maxPriority)) {
    throw new Error(`@metta-ts returned invalid norm priority: ${String(maxPriority)}`);
  }
  for (const row of applicable.slice(1)) {
    if (!Number.isSafeInteger(row.priority)) {
      throw new Error(`@metta-ts returned invalid norm priority: ${String(row.priority)}`);
    }
    if (row.priority > maxPriority) maxPriority = row.priority;
  }
  const strongest = db
    .query(policyNorm(actionId, index, mode, maxPriority, reason), {
      index,
      mode,
      reason,
    })
    .sort((left, right) => left.index - right.index);

  const present = (candidate: NormMode): boolean =>
    db.evalJs(hasPolicyMode(actionId, maxPriority, candidate)).length > 0;
  const result = db.evalJs(
    normResolutionStatus(present("forbid"), present("permit"), present("oblige")),
  )[0];
  if (typeof result !== "string" || !STATUS_SET.has(result)) {
    throw new Error(`@metta-ts returned invalid norm resolution status: ${String(result)}`);
  }

  const reasons = strongest.map((row) => {
    const source = indexedNorms[row.index];
    if (source === undefined) {
      throw new Error(`@metta-ts returned unknown norm index: ${row.index}`);
    }
    return `${source.mode}:${source.reason}`;
  });
  return new NormResolution(result as NormStatus, reasons, maxPriority);
}

/** Resolve the strongest applicable norms for one action. */
export function resolveNorms(actionId: string, norms: readonly Norm[]): NormResolution {
  validateActionIds([actionId]);
  return resolveFromDatabase(actionId, createNormDatabase(norms));
}

/** Resolve arbitrary ordered action IDs against one shared norm database. */
export function resolveNormsBatch(
  actionIds: readonly string[],
  norms: readonly Norm[],
): ReadonlyMap<string, NormResolution> {
  validateActionIds(actionIds);
  const database = createNormDatabase(norms);
  return new Map(actionIds.map((actionId) => [actionId, resolveFromDatabase(actionId, database)]));
}
