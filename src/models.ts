// Data models for goal, norm, and evidence-aware action ranking.
// Ports goal_chainer/models.py. Internal fields are camelCase; the serialized
// report dicts (decisionToDict) retain the source field names and snake_case shape.

import { assertDenseArray, assertKnownKeys, assertPlainRecord } from "./records.js";
import { parseStv } from "./truth_value.js";

export type GoalKind = "individual" | "collective";
export type NormMode = "oblige" | "permit" | "forbid";
export type DeonticStatus =
  | "unregulated"
  | "permitted"
  | "obligated"
  | "forbidden"
  | "conflict";
export type DecisionStatus = "blocked" | "recommended" | "candidate" | "weak";

/** Scores within this binary64 tolerance are treated as tied for execution safety. */
export const SCORE_EQUIVALENCE_EPSILON = 1e-12;

const DEONTIC_STATUS_SET: ReadonlySet<string> = new Set([
  "unregulated",
  "permitted",
  "obligated",
  "forbidden",
  "conflict",
]);
const DECISION_STATUS_SET: ReadonlySet<string> = new Set([
  "blocked",
  "recommended",
  "candidate",
  "weak",
]);

/** Derive the only valid status for a scored decision. */
export function deriveDecisionStatus(
  score: number,
  missingRequiredCount: number,
  normStatus: DeonticStatus,
): DecisionStatus {
  if (!Number.isFinite(score)) {
    throw new RangeError("decision score must be finite");
  }
  if (!Number.isSafeInteger(missingRequiredCount) || missingRequiredCount < 0) {
    throw new RangeError("missing required goal count must be a non-negative safe integer");
  }
  if (!DEONTIC_STATUS_SET.has(normStatus)) {
    throw new RangeError(`unsupported decision norm status: ${String(normStatus)}`);
  }
  if (normStatus === "forbidden" || normStatus === "conflict") return "blocked";
  if (score >= 0.72 && missingRequiredCount === 0) return "recommended";
  if (score >= 0.5) return "candidate";
  return "weak";
}

export interface Goal {
  readonly id: string;
  readonly owner: string;
  readonly statement: string;
  readonly weight: number;
  readonly kind: GoalKind;
  readonly required: boolean;
}

export interface Norm {
  readonly id: string;
  readonly mode: NormMode;
  readonly targetAction: string;
  readonly reason: string;
  readonly priority: number;
}

export interface CandidateAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly satisfies: readonly string[];
  readonly evidenceQuery: string;
  readonly evidenceAtoms: readonly string[];
  readonly defaultStrength: number;
  readonly defaultConfidence: number;
}

export interface EvidenceProjection {
  readonly strength: number;
  readonly confidence: number;
  readonly source: string;
  readonly projection: string | null;
  readonly proofs: readonly string[];
  readonly deontic: DeonticStatus;
  readonly expectation: number;
}

export interface GoalScenario {
  readonly title: string;
  readonly goals: readonly Goal[];
  readonly norms: readonly Norm[];
  readonly actions: readonly CandidateAction[];
  readonly notes: readonly string[];
}

export interface Decision {
  readonly actionId: string;
  readonly label: string;
  readonly status: DecisionStatus;
  readonly score: number;
  readonly goalScore: number;
  readonly individualScore: number;
  readonly collectiveScore: number;
  readonly evidence: EvidenceProjection;
  readonly normStatus: DeonticStatus;
  readonly normReasons: readonly string[];
  readonly satisfiedGoals: readonly string[];
  readonly missingRequiredGoals: readonly string[];
  readonly warnings: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

export type GoalInput = Omit<Goal, "required"> & Partial<Pick<Goal, "required">>;
export type NormInput = Omit<Norm, "priority"> & Partial<Pick<Norm, "priority">>;
export type CandidateActionInput = Omit<
  CandidateAction,
  "evidenceQuery" | "evidenceAtoms" | "defaultStrength" | "defaultConfidence"
> &
  Partial<
    Pick<
      CandidateAction,
      "evidenceQuery" | "evidenceAtoms" | "defaultStrength" | "defaultConfidence"
    >
  >;
export type EvidenceProjectionInput = Omit<
  EvidenceProjection,
  "projection" | "proofs" | "deontic" | "expectation"
> &
  Partial<Pick<EvidenceProjection, "projection" | "proofs" | "deontic" | "expectation">>;
export type GoalScenarioInput = Omit<GoalScenario, "notes"> &
  Partial<Pick<GoalScenario, "notes">>;
export type DecisionInput = Omit<
  Decision,
  "normReasons" | "satisfiedGoals" | "missingRequiredGoals" | "warnings" | "metadata"
> &
  Partial<
    Pick<
      Decision,
      "normReasons" | "satisfiedGoals" | "missingRequiredGoals" | "warnings" | "metadata"
    >
  >;

function frozenList<T>(values: readonly T[], field: string): readonly T[] {
  assertDenseArray(values, field);
  return Object.freeze([...values]);
}

function frozenStringList(values: readonly string[], field: string): readonly string[] {
  const copy = frozenList(values, field);
  copy.forEach((value, index) => {
    if (typeof value !== "string") throw new TypeError(`${field}[${index}] must be a string`);
  });
  return copy;
}

function probability(value: unknown, errorMessage: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(errorMessage);
  }
  return value;
}

function frozenStringRecord(
  value: Readonly<Record<string, string>> | undefined,
  field: string,
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  assertPlainRecord(value, field);
  const entries = Object.entries(value);
  entries.forEach(([key, entryValue]) => {
    if (typeof entryValue !== "string") {
      throw new TypeError(`${field}.${key} must be a string`);
    }
  });
  return Object.freeze(Object.fromEntries(entries));
}

function uniqueIds(rows: readonly { readonly id: string }[], entity: string): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new RangeError(`duplicate ${entity} ID: ${row.id}`);
    ids.add(row.id);
  }
  return ids;
}

function nonblank(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RangeError(`${field} must not be blank`);
  }
  return value;
}

/** Sum non-negative goal weights and reject aggregate binary64 overflow. */
export function sumGoalWeights(goals: readonly Goal[]): number {
  assertDenseArray(goals, "goals");
  let total = 0;
  for (const goal of goals) {
    if (!Number.isFinite(goal.weight) || goal.weight < 0) {
      throw new RangeError(`goal weight must be finite and non-negative: ${goal.id}`);
    }
    total += goal.weight;
    if (!Number.isFinite(total)) {
      throw new RangeError("aggregate goal weight must be finite");
    }
  }
  return total;
}

/** Return a finite positive aggregate for a complete scenario goal set. */
export function totalGoalWeight(goals: readonly Goal[]): number {
  const total = sumGoalWeights(goals);
  if (total === 0) throw new RangeError("aggregate goal weight must be positive");
  return total;
}

/** Construct a frozen Goal with the source default and weight invariant. */
export function createGoal(input: GoalInput): Goal {
  assertPlainRecord(input, "goal");
  assertKnownKeys(input, "goal", ["id", "owner", "statement", "weight", "kind", "required"]);
  nonblank(input.id, "goal id");
  nonblank(input.owner, `goal owner for ${input.id}`);
  nonblank(input.statement, `goal statement for ${input.id}`);
  if (input.kind !== "individual" && input.kind !== "collective") {
    throw new RangeError(`unsupported goal kind for ${input.id}: ${String(input.kind)}`);
  }
  if (!Number.isFinite(input.weight)) {
    throw new RangeError(`goal weight must be finite: ${input.id}`);
  }
  if (input.weight < 0) {
    throw new RangeError(`goal weight must be non-negative: ${input.id}`);
  }
  const required = input.required === undefined ? false : input.required;
  if (typeof required !== "boolean") {
    throw new TypeError(`goal required flag must be boolean: ${input.id}`);
  }
  return Object.freeze({
    id: input.id,
    owner: input.owner,
    statement: input.statement,
    weight: input.weight,
    kind: input.kind,
    required,
  });
}

/** Construct a frozen Norm with the source priority default. */
export function createNorm(input: NormInput): Norm {
  assertPlainRecord(input, "norm");
  assertKnownKeys(input, "norm", ["id", "mode", "targetAction", "reason", "priority"]);
  nonblank(input.id, "norm id");
  nonblank(input.targetAction, `norm target action for ${input.id}`);
  nonblank(input.reason, `norm reason for ${input.id}`);
  if (input.mode !== "oblige" && input.mode !== "permit" && input.mode !== "forbid") {
    throw new RangeError(`unsupported norm mode for ${input.id}: ${String(input.mode)}`);
  }
  const priority = input.priority === undefined ? 0 : input.priority;
  if (!Number.isSafeInteger(priority)) {
    throw new RangeError(`norm priority must be a finite integer: ${input.id}`);
  }
  return Object.freeze({
    id: input.id,
    mode: input.mode,
    targetAction: input.targetAction,
    reason: input.reason,
    priority,
  });
}

/** Construct a frozen CandidateAction and enforce its probability bounds. */
export function createCandidateAction(input: CandidateActionInput): CandidateAction {
  assertPlainRecord(input, "candidate action");
  assertKnownKeys(input, "candidate action", [
    "id",
    "label",
    "description",
    "satisfies",
    "evidenceQuery",
    "evidenceAtoms",
    "defaultStrength",
    "defaultConfidence",
  ]);
  nonblank(input.id, "action id");
  nonblank(input.label, `action label for ${input.id}`);
  nonblank(input.description, `action description for ${input.id}`);
  const satisfies = frozenStringList(input.satisfies, `action ${input.id} satisfies`);
  satisfies.forEach((goalId, index) =>
    nonblank(goalId, `action ${input.id} satisfies[${index}]`),
  );
  const satisfiedGoalIds = new Set<string>();
  for (const goalId of satisfies) {
    if (satisfiedGoalIds.has(goalId)) {
      throw new RangeError(`action ${input.id} contains duplicate satisfies goal ID: ${goalId}`);
    }
    satisfiedGoalIds.add(goalId);
  }
  const evidenceQuery = input.evidenceQuery === undefined ? "" : input.evidenceQuery;
  if (evidenceQuery !== "") {
    nonblank(evidenceQuery, `action evidence query for ${input.id}`);
  } else if (typeof evidenceQuery !== "string") {
    throw new TypeError(`action evidence query for ${input.id} must be a string`);
  }
  const evidenceAtoms = frozenStringList(
    input.evidenceAtoms === undefined ? [] : input.evidenceAtoms,
    `action ${input.id} evidenceAtoms`,
  );
  evidenceAtoms.forEach((atom, index) =>
    nonblank(atom, `action ${input.id} evidenceAtoms[${index}]`),
  );
  if (evidenceAtoms.length > 0 && evidenceQuery === "") {
    throw new RangeError(`action evidence atoms require a query: ${input.id}`);
  }
  const defaultStrength = probability(
    input.defaultStrength === undefined ? 0.5 : input.defaultStrength,
    `default_strength outside [0, 1]: ${input.id}`,
  );
  const defaultConfidence = probability(
    input.defaultConfidence === undefined ? 0 : input.defaultConfidence,
    `default_confidence outside [0, 1]: ${input.id}`,
  );
  return Object.freeze({
    id: input.id,
    label: input.label,
    description: input.description,
    satisfies,
    evidenceQuery,
    evidenceAtoms,
    defaultStrength,
    defaultConfidence,
  });
}

/** Construct a frozen EvidenceProjection with independent proof storage. */
export function createEvidenceProjection(input: EvidenceProjectionInput): EvidenceProjection {
  assertPlainRecord(input, "evidence projection");
  assertKnownKeys(input, "evidence projection", [
    "strength",
    "confidence",
    "source",
    "projection",
    "proofs",
    "deontic",
    "expectation",
  ]);
  const strength = probability(input.strength, "evidence strength must be within [0, 1]");
  const confidence = probability(
    input.confidence,
    "evidence confidence must be within [0, 1]",
  );
  nonblank(input.source, "evidence source");
  const expectation = probability(
    input.expectation === undefined ? 0 : input.expectation,
    "evidence expectation must be within [0, 1]",
  );
  const deontic = input.deontic === undefined ? "unregulated" : input.deontic;
  if (!DEONTIC_STATUS_SET.has(deontic)) {
    throw new RangeError(`unsupported evidence deontic status: ${String(deontic)}`);
  }
  const projection = input.projection === undefined ? null : input.projection;
  if (projection !== null && typeof projection !== "string") {
    throw new TypeError("evidence projection must be a string or null");
  }
  const projected = parseStv(projection);
  if (projected !== null) {
    probability(projected[0], "evidence projection strength must be within [0, 1]");
    probability(projected[1], "evidence projection confidence must be within [0, 1]");
    if (
      Math.abs(projected[0] - strength) > SCORE_EQUIVALENCE_EPSILON ||
      Math.abs(projected[1] - confidence) > SCORE_EQUIVALENCE_EPSILON
    ) {
      throw new RangeError("evidence projection STV disagrees with explicit strength and confidence");
    }
  }
  const proofs = frozenStringList(
    input.proofs === undefined ? [] : input.proofs,
    "evidence proofs",
  );
  return Object.freeze({
    strength,
    confidence,
    source: input.source,
    projection,
    proofs,
    deontic,
    expectation,
  });
}

/** Construct a frozen GoalScenario with independent tuple-like lists. */
export function createGoalScenario(input: GoalScenarioInput): GoalScenario {
  assertPlainRecord(input, "goal scenario");
  assertKnownKeys(input, "goal scenario", ["title", "goals", "norms", "actions", "notes"]);
  nonblank(input.title, "scenario title");
  const goals = Object.freeze(
    frozenList(input.goals, "scenario goals").map((goal) => createGoal(goal)),
  );
  const norms = Object.freeze(
    frozenList(input.norms, "scenario norms").map((norm) => createNorm(norm)),
  );
  const actions = Object.freeze(
    frozenList(input.actions, "scenario actions").map((action) =>
      createCandidateAction(action),
    ),
  );
  const notes = frozenStringList(
    input.notes === undefined ? [] : input.notes,
    "scenario notes",
  );
  if (actions.length === 0) {
    throw new RangeError("a scenario must contain at least one candidate action");
  }
  totalGoalWeight(goals);
  const goalIds = uniqueIds(goals, "goal");
  const actionIds = uniqueIds(actions, "action");
  uniqueIds(norms, "norm");
  for (const action of actions) {
    for (const goalId of action.satisfies) {
      if (!goalIds.has(goalId)) {
        throw new RangeError(`action ${action.id} references unknown goal ID: ${goalId}`);
      }
    }
  }
  for (const norm of norms) {
    if (!actionIds.has(norm.targetAction)) {
      throw new RangeError(`norm ${norm.id} references unknown action ID: ${norm.targetAction}`);
    }
  }
  return Object.freeze({
    title: input.title,
    goals,
    norms,
    actions,
    notes,
  });
}

/** Construct a frozen Decision with fresh list and metadata defaults. */
export function createDecision(input: DecisionInput): Decision {
  assertPlainRecord(input, "decision");
  assertKnownKeys(input, "decision", [
    "actionId",
    "label",
    "status",
    "score",
    "goalScore",
    "individualScore",
    "collectiveScore",
    "evidence",
    "normStatus",
    "normReasons",
    "satisfiedGoals",
    "missingRequiredGoals",
    "warnings",
    "metadata",
  ]);
  nonblank(input.actionId, "decision action id");
  nonblank(input.label, `decision label for ${input.actionId}`);
  if (!Number.isFinite(input.score)) throw new RangeError("decision score must be finite");
  for (const [field, value] of [
    ["goalScore", input.goalScore],
    ["individualScore", input.individualScore],
    ["collectiveScore", input.collectiveScore],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`decision ${field} must be finite and within [0, 1]`);
    }
  }
  if (!DECISION_STATUS_SET.has(input.status)) {
    throw new RangeError(`unsupported decision status: ${String(input.status)}`);
  }
  if (!DEONTIC_STATUS_SET.has(input.normStatus)) {
    throw new RangeError(`unsupported decision norm status: ${String(input.normStatus)}`);
  }
  const evidence = createEvidenceProjection(input.evidence);
  const normReasons = frozenStringList(
    input.normReasons === undefined ? [] : input.normReasons,
    "decision norm reasons",
  );
  const satisfiedGoals = frozenStringList(
    input.satisfiedGoals === undefined ? [] : input.satisfiedGoals,
    "decision satisfied goals",
  );
  const missingRequiredGoals = frozenStringList(
    input.missingRequiredGoals === undefined ? [] : input.missingRequiredGoals,
    "decision missing required goals",
  );
  const warnings = frozenStringList(
    input.warnings === undefined ? [] : input.warnings,
    "decision warnings",
  );
  const metadata = frozenStringRecord(input.metadata, "decision metadata");
  const satisfiedSet = new Set<string>();
  satisfiedGoals.forEach((goalId, index) => {
    nonblank(goalId, `decision satisfied goals[${index}]`);
    if (satisfiedSet.has(goalId)) {
      throw new RangeError(`decision satisfied goals contains duplicate ID: ${goalId}`);
    }
    satisfiedSet.add(goalId);
  });
  const missingSet = new Set<string>();
  missingRequiredGoals.forEach((goalId, index) => {
    nonblank(goalId, `decision missing required goals[${index}]`);
    if (missingSet.has(goalId)) {
      throw new RangeError(`decision missing required goals contains duplicate ID: ${goalId}`);
    }
    if (satisfiedSet.has(goalId)) {
      throw new RangeError(`decision goal cannot be both satisfied and missing: ${goalId}`);
    }
    missingSet.add(goalId);
  });
  const expectedStatus = deriveDecisionStatus(
    input.score,
    missingRequiredGoals.length,
    input.normStatus,
  );
  if (input.status !== expectedStatus) {
    throw new RangeError(
      `decision status ${input.status} is inconsistent with score, missing required goals, and norm status; expected ${expectedStatus}`,
    );
  }
  if (expectedStatus === "blocked" && input.score !== -1) {
    throw new RangeError("blocked decision score must be -1");
  }
  if (expectedStatus !== "blocked" && (input.score < 0 || input.score > 1.02 + 1e-12)) {
    throw new RangeError("nonblocked decision score must be within [0, 1.02]");
  }
  if (evidence.deontic !== input.normStatus) {
    throw new RangeError(
      `evidence deontic status ${evidence.deontic} does not match decision norm status ${input.normStatus}`,
    );
  }
  return Object.freeze({
    actionId: input.actionId,
    label: input.label,
    status: input.status,
    score: input.score,
    goalScore: input.goalScore,
    individualScore: input.individualScore,
    collectiveScore: input.collectiveScore,
    evidence,
    normStatus: input.normStatus,
    normReasons,
    satisfiedGoals,
    missingRequiredGoals,
    warnings,
    metadata,
  });
}

/** Round to 6 decimal places the way Python's round() does for these reports. */
export function round6(x: number): number {
  return roundN(x, 6);
}

/** Round a binary64 number to decimal places using Python's ties-to-even rule. */
export function roundN(x: number, digits: number): number {
  if (!Number.isInteger(digits)) {
    throw new TypeError("digits must be an integer");
  }
  if (typeof x !== "number") throw new TypeError("value must be a number");
  if (!Number.isFinite(x) || x === 0 || digits > 323) return x;
  if (digits < -308) return x < 0 ? -0 : 0;

  const negative = x < 0;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);

  let numerator: bigint;
  let binaryExponent: number;
  if (exponentBits === 0) {
    numerator = fraction;
    binaryExponent = -1074;
  } else {
    numerator = (1n << 52n) | fraction;
    binaryExponent = exponentBits - 1023 - 52;
  }

  let denominator = 1n;
  if (binaryExponent >= 0) {
    numerator <<= BigInt(binaryExponent);
  } else {
    denominator <<= BigInt(-binaryExponent);
  }
  if (digits >= 0) {
    numerator *= 10n ** BigInt(digits);
  } else {
    denominator *= 10n ** BigInt(-digits);
  }

  let rounded = numerator / denominator;
  const twiceRemainder = (numerator % denominator) * 2n;
  if (
    twiceRemainder > denominator ||
    (twiceRemainder === denominator && rounded % 2n === 1n)
  ) {
    rounded += 1n;
  }

  const result = Number(`${negative ? "-" : ""}${rounded}e${-digits}`);
  if (!Number.isFinite(result)) {
    throw new RangeError("rounded value too large to represent");
  }
  return result;
}

/** Serialize a Decision while retaining the authoritative unrounded score. */
export function decisionToDict(d: Decision): Record<string, unknown> {
  const decision = createDecision(d);
  return {
    action_id: decision.actionId,
    label: decision.label,
    status: decision.status,
    score: decision.score,
    goal_score: round6(decision.goalScore),
    individual_score: round6(decision.individualScore),
    collective_score: round6(decision.collectiveScore),
    evidence: {
      strength: round6(decision.evidence.strength),
      confidence: round6(decision.evidence.confidence),
      source: decision.evidence.source,
      projection: decision.evidence.projection,
      proofs: [...decision.evidence.proofs],
    },
    norm_status: decision.normStatus,
    norm_reasons: [...decision.normReasons],
    satisfied_goals: [...decision.satisfiedGoals],
    missing_required_goals: [...decision.missingRequiredGoals],
    warnings: [...decision.warnings],
    metadata: { ...decision.metadata },
  };
}
