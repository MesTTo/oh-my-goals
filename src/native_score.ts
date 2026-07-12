// Batch score and verdict calls into the packaged GoalChainer MeTTa module.

import { NORM_STATUSES, type NormStatus } from "./deontic.js";
import {
  mettaCall,
  mettaFloat,
  mettaSymbol,
  sharedGoalChainerMetta,
  type Term,
} from "./metta.js";
import { assertDenseArray } from "./records.js";

export type NativeDeonticStatus = NormStatus;
export type NativeDecisionStatus = "blocked" | "recommended" | "candidate" | "weak";

export type ScoreActionRow = readonly [
  deontic: NativeDeonticStatus,
  strength: number,
  confidence: number,
  motivation: number,
];

export type DecideActionRow = readonly [
  deontic: NativeDeonticStatus,
  strength: number,
  confidence: number,
  motivation: number,
  hasMissing: 0 | 1,
];

export type NativeDecision = readonly [score: number, status: NativeDecisionStatus];

const NATIVE_DECISION_STATUSES: ReadonlySet<string> = new Set([
  "blocked",
  "recommended",
  "candidate",
  "weak",
]);
const NATIVE_DEONTIC_STATUSES: ReadonlySet<string> = new Set(NORM_STATUSES);

function unitInterval(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${path} must be finite and within [0, 1]`);
  }
}

function validateScoreActionRow(
  row: readonly unknown[],
  path: string,
): asserts row is ScoreActionRow {
  assertDenseArray(row, path);
  if (row.length !== 4) throw new TypeError(`${path} must contain four values`);
  if (typeof row[0] !== "string" || !NATIVE_DEONTIC_STATUSES.has(row[0])) {
    throw new TypeError(`${path}[0] has unsupported deontic status: ${String(row[0])}`);
  }
  unitInterval(row[1], `${path}[1]`);
  unitInterval(row[2], `${path}[2]`);
  unitInterval(row[3], `${path}[3]`);
}

/** Validate public decision rows before either MeTTa or Prolog evaluation. */
export function validateDecideActionRows(rows: readonly DecideActionRow[]): void {
  assertDenseArray(rows, "rows");
  rows.forEach((row, index) => {
    assertDenseArray(row, `rows[${index}]`);
    if (row.length !== 5) throw new TypeError(`rows[${index}] must contain five values`);
    validateScoreActionRow(row.slice(0, 4), `rows[${index}]`);
    if (row[4] !== 0 && row[4] !== 1) {
      throw new TypeError(`rows[${index}][4] must be 0 or 1`);
    }
  });
}

function scoreQuery(row: ScoreActionRow): Term {
  return mettaCall(
    "gc-score-motivation",
    mettaSymbol(row[0]),
    mettaFloat(row[1]),
    mettaFloat(row[2]),
    mettaFloat(row[3]),
  );
}

function decisionQuery(row: DecideActionRow): Term {
  return mettaCall(
    "gc-decide-motivation",
    mettaSymbol(row[0]),
    mettaFloat(row[1]),
    mettaFloat(row[2]),
    mettaFloat(row[3]),
    row[4],
  );
}

function readScore(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`oh-my-goals.metta returned an invalid score for ${path}`);
  }
  return value;
}

function readDecision(value: unknown, path: string): NativeDecision {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== "NativeDecision" ||
    typeof value[1] !== "number" ||
    !Number.isFinite(value[1]) ||
    typeof value[2] !== "string" ||
    !NATIVE_DECISION_STATUSES.has(value[2])
  ) {
    throw new Error(`oh-my-goals.metta returned an invalid decision for ${path}`);
  }
  return [value[1], value[2] as NativeDecisionStatus];
}

/** Compute the MeTTa combined score for each row, preserving input order. */
export function scoreActions(rows: readonly ScoreActionRow[]): number[] {
  assertDenseArray(rows, "rows");
  rows.forEach((row, index) => validateScoreActionRow(row, `rows[${index}]`));
  if (rows.length === 0) return [];
  const groups = sharedGoalChainerMetta().evalJsMany(rows.map(scoreQuery));
  return groups.map((values, index) => {
    if (values.length !== 1) {
      throw new Error(`oh-my-goals.metta returned ${values.length} scores for rows[${index}]`);
    }
    return readScore(values[0], `rows[${index}]`);
  });
}

/** Compute the MeTTa score and decision status for each row, preserving input order. */
export function decideActions(rows: readonly DecideActionRow[]): NativeDecision[] {
  validateDecideActionRows(rows);
  if (rows.length === 0) return [];
  const groups = sharedGoalChainerMetta().evalJsMany(rows.map(decisionQuery));
  return groups.map((values, index) => {
    if (values.length !== 1) {
      throw new Error(`oh-my-goals.metta returned ${values.length} decisions for rows[${index}]`);
    }
    return readDecision(values[0], `rows[${index}]`);
  });
}
