// Resolve caller-supplied policy norms through goalchainer.metta.

import {
  mettaCall,
  mettaFloat,
  mettaInteger,
  mettaString,
  mettaSymbol,
  sharedGoalChainerMetta,
  type Term,
} from "./metta.js";
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

function validateNorms(norms: readonly Norm[]): readonly Norm[] {
  assertDenseArray(norms, "norms");
  const stable = Object.freeze(norms.map((norm) => createNorm(norm)));
  const normIds = new Set<string>();
  stable.forEach((norm, index) => {
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
    if (!Number.isSafeInteger(norm.priority)) {
      throw new RangeError(`norm at index ${index} has unsafe priority: ${norm.priority}`);
    }
    if (normIds.has(norm.id)) throw new RangeError(`duplicate norm ID: ${norm.id}`);
    normIds.add(norm.id);
  });
  return stable;
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

function normLeaf(norm: Norm, index: number): Term {
  return mettaCall(
    "NormLeaf",
    mettaCall(
      "Norm",
      mettaString(norm.targetAction),
      mettaInteger(index),
      mettaSymbol(norm.mode),
      mettaFloat(norm.priority),
      mettaInteger(index),
    ),
  );
}

function balancedRange(leaves: readonly Term[], start: number, end: number): Term {
  const length = end - start;
  if (length === 0) return mettaSymbol("NormTreeEmpty");
  if (length === 1) return leaves[start]!;
  const midpoint = start + Math.floor(length / 2);
  return mettaCall(
    "NormBranch",
    balancedRange(leaves, start, midpoint),
    balancedRange(leaves, midpoint, end),
  );
}

/** Serialize every norm without filtering, sorting, or selecting policy outcomes. */
function normTree(norms: readonly Norm[]): Term {
  const leaves = norms.map(normLeaf);
  return balancedRange(leaves, 0, leaves.length);
}

function resolutionQuery(actionId: string, tree: Term): Term {
  return mettaCall("gc-resolve-norm-tree", mettaString(actionId), tree);
}

function decodeReasonTree(
  value: unknown,
  actionId: string,
  priority: number,
  norms: readonly Norm[],
  indexes: number[],
): void {
  if (value === "ReasonEmpty") return;
  if (!Array.isArray(value)) {
    throw new Error(`goalchainer.metta returned an invalid reason tree: ${JSON.stringify(value)}`);
  }
  if (value[0] === "ReasonJoin" && value.length === 3) {
    decodeReasonTree(value[1], actionId, priority, norms, indexes);
    decodeReasonTree(value[2], actionId, priority, norms, indexes);
    return;
  }
  const reason = value[1];
  if (
    value[0] !== "ReasonLeaf" ||
    value.length !== 2 ||
    !Array.isArray(reason) ||
    reason.length !== 3 ||
    reason[0] !== "NormReason" ||
    typeof reason[1] !== "string" ||
    !NORM_MODES.has(reason[1]) ||
    typeof reason[2] !== "number" ||
    !Number.isSafeInteger(reason[2]) ||
    reason[2] < 0 ||
    reason[2] >= norms.length
  ) {
    throw new Error(`goalchainer.metta returned an invalid reason leaf: ${JSON.stringify(value)}`);
  }
  const index = reason[2];
  const norm = norms[index]!;
  if (
    norm.mode !== reason[1] ||
    norm.targetAction !== actionId ||
    norm.priority !== priority ||
    (indexes.length > 0 && indexes[indexes.length - 1]! >= index)
  ) {
    throw new Error(`goalchainer.metta returned an inconsistent reason leaf at norm ${index}`);
  }
  indexes.push(index);
}

function resolutionResult(
  value: unknown,
  actionId: string,
  norms: readonly Norm[],
): NormResolution {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== "NormResolution" ||
    typeof value[1] !== "string" ||
    !STATUS_SET.has(value[1]) ||
    typeof value[2] !== "number" ||
    !Number.isSafeInteger(value[2])
  ) {
    throw new Error(
      `goalchainer.metta returned an invalid norm resolution for ${actionId}: ${JSON.stringify(value)}`,
    );
  }
  const indexes: number[] = [];
  decodeReasonTree(value[3], actionId, value[2], norms, indexes);
  const reasons = indexes.map((index) => {
    const norm = norms[index]!;
    return `${norm.mode}:${norm.reason}`;
  });
  return new NormResolution(value[1] as NormStatus, reasons, value[2]);
}

/** Resolve the strongest applicable norms for one action. */
export function resolveNorms(actionId: string, norms: readonly Norm[]): NormResolution {
  validateActionIds([actionId]);
  const stable = validateNorms(norms);
  const values = sharedGoalChainerMetta().evalJs(resolutionQuery(actionId, normTree(stable)));
  if (values.length !== 1) {
    throw new Error(`goalchainer.metta returned ${values.length} norm resolutions for ${actionId}`);
  }
  return resolutionResult(values[0], actionId, stable);
}

/** Resolve arbitrary ordered action IDs through one native MeTTa reduction. */
export function resolveNormsBatch(
  actionIds: readonly string[],
  norms: readonly Norm[],
): ReadonlyMap<string, NormResolution> {
  validateActionIds(actionIds);
  const stable = validateNorms(norms);
  const tree = normTree(stable);
  const groups = sharedGoalChainerMetta().evalJsMany(
    actionIds.map((actionId) => resolutionQuery(actionId, tree)),
  );
  return new Map(actionIds.map((actionId, index) => {
    const group = groups[index]!;
    if (group.length !== 1) {
      throw new Error(
        `goalchainer.metta returned ${group.length} norm resolutions for ${actionId}`,
      );
    }
    return [actionId, resolutionResult(group[0], actionId, stable)];
  }));
}
