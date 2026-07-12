// Batch score and verdict functions backed by @metta-ts arithmetic.
// Ports goal_chainer/native_score.py and integrations/prolog/gc_score.pl.

import { If, add, and, eq, ge, mul, names, or, vars } from "@metta-ts/edsl";
import { NORM_STATUSES, type NormStatus } from "./deontic.js";
import { flt, mettaDB, num, type MettaDB } from "./engine.js";
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

const SYMBOLS = names<
  "gc-score" | "gc-decision-status" | "blocked" | "recommended" | "candidate" | "weak"
>();
const GC_SCORE = SYMBOLS["gc-score"];
const GC_DECISION_STATUS = SYMBOLS["gc-decision-status"];
const INITIALIZED_DBS = new WeakSet<MettaDB>();

function unitInterval(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${path} must be finite and within [0, 1]`);
  }
}

function validateScoreActionRow(row: readonly unknown[], path: string): asserts row is ScoreActionRow {
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

function ensureScoreRule(db: MettaDB): void {
  if (INITIALIZED_DBS.has(db)) return;
  const {
    "score-deontic": deontic,
    "score-strength": strength,
    "score-confidence": confidence,
    "score-motivation": motivation,
    "decision-score": score,
    "decision-has-missing": hasMissing,
  } = vars<{
    "score-deontic": NativeDeonticStatus;
    "score-strength": number;
    "score-confidence": number;
    "score-motivation": number;
    "decision-score": number;
    "decision-has-missing": 0 | 1;
  }>();
  db.rule(
    GC_SCORE(deontic, strength, confidence, motivation),
    If(
      or(eq(deontic, "forbidden"), eq(deontic, "conflict")),
      flt(-1),
      add(
        add(mul(0.54, motivation), mul(0.38, mul(strength, confidence))),
        If(eq(deontic, "obligated"), 0.1, 0),
      ),
    ),
  );
  db.rule(
    GC_DECISION_STATUS(deontic, score, hasMissing),
    If(
      or(eq(deontic, "forbidden"), eq(deontic, "conflict")),
      SYMBOLS.blocked,
      If(
        and(ge(score, 0.72), eq(hasMissing, 0)),
        SYMBOLS.recommended,
        If(ge(score, 0.5), SYMBOLS.candidate, SYMBOLS.weak),
      ),
    ),
  );
  INITIALIZED_DBS.add(db);
}

/** Score one row on an existing engine. Shared with DecisionEngine. */
export function scoreAction(db: MettaDB, row: ScoreActionRow): number {
  validateScoreActionRow(row, "row");
  ensureScoreRule(db);
  const [deontic, strength, confidence, motivation] = row;
  return num(db, GC_SCORE(deontic, strength, confidence, motivation));
}

/** Compute the native combined score for each row, preserving input order. */
export function scoreActions(rows: readonly ScoreActionRow[]): number[] {
  assertDenseArray(rows, "rows");
  if (rows.length === 0) return [];
  const db = mettaDB();
  return rows.map((row, index) => {
    validateScoreActionRow(row, `rows[${index}]`);
    return scoreAction(db, row);
  });
}

/** Compute the native score and decision status for each row, preserving input order. */
export function decideActions(rows: readonly DecideActionRow[]): NativeDecision[] {
  validateDecideActionRows(rows);
  if (rows.length === 0) return [];
  const db = mettaDB();
  return rows.map((row) => {
    const score = scoreAction(db, [row[0], row[1], row[2], row[3]]);
    const status = db.evalJs(GC_DECISION_STATUS(row[0], score, row[4]))[0];
    if (typeof status !== "string" || !NATIVE_DECISION_STATUSES.has(status)) {
      throw new Error(`@metta-ts returned invalid native decision status: ${String(status)}`);
    }
    return [score, status as NativeDecisionStatus];
  });
}
