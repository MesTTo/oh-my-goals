// Rank caller-supplied actions by goals, norms, evidence, and motivation.

import { If, add, and, eq, ge, mul, names, vars, type Term } from "@metta-ts/edsl";
import {
  NORM_STATUSES,
  resolveNorms,
  resolveNormsBatch,
  type NormResolution,
  type NormStatus,
} from "./deontic.js";
import { mettaDB, mmin, num, type MettaDB } from "./engine.js";
import {
  createCandidateAction,
  createDecision,
  createEvidenceProjection,
  createGoalScenario,
  sumGoalWeights,
  type CandidateAction,
  type Decision,
  type DecisionStatus,
  type EvidenceProjection,
  type Goal,
  type GoalScenario,
} from "./models.js";
import { scoreAction } from "./native_score.js";
import { assertDenseArray, assertPlainRecord, ownValue } from "./records.js";

export interface EvidenceReasoner {
  readonly source: string;
  project(action: CandidateAction): EvidenceProjection;
}

const offlineScoreExpr = (
  goal: number,
  strength: number,
  confidence: number,
  individual: number,
  collective: number,
  bonus: number,
): Term =>
  add(
    add(
      add(mul(0.42, goal), mul(0.38, mul(strength, confidence))),
      mul(0.12, mmin(individual, collective)),
    ),
    bonus,
  );

const scoreNames = names<"decision-status" | "recommended" | "candidate" | "weak">();
const decisionStatus = scoreNames["decision-status"];
const recommended = scoreNames.recommended;
const candidate = scoreNames.candidate;
const weak = scoreNames.weak;
const statusVars = vars<{ score: number; missing: number }>();
const STATUS_DBS = new WeakSet<MettaDB>();
const NORM_STATUS_SET: ReadonlySet<string> = new Set(NORM_STATUSES);

function ensureStatusRule(db: MettaDB): void {
  if (STATUS_DBS.has(db)) return;
  db.rule(
    decisionStatus(statusVars.score, statusVars.missing),
    If(
      and(ge(statusVars.score, 0.72), eq(statusVars.missing, 0)),
      recommended,
      If(ge(statusVars.score, 0.5), candidate, weak),
    ),
  );
  STATUS_DBS.add(db);
}

function statusFor(db: MettaDB, score: number, missingCount: number): DecisionStatus {
  ensureStatusRule(db);
  const value = db.evalJs(decisionStatus(score, missingCount))[0];
  if (value !== "recommended" && value !== "candidate" && value !== "weak") {
    throw new Error(`@metta-ts returned invalid decision status: ${String(value)}`);
  }
  return value;
}

function evidenceNormStatus(value: string, actionId: string): NormStatus {
  if (!NORM_STATUS_SET.has(value)) {
    throw new TypeError(
      `evidence reasoner returned unsupported deontic status for ${actionId}: ${value}`,
    );
  }
  return value as NormStatus;
}

export function mergeNormStatus(staticStatus: NormStatus, reasonerStatus: NormStatus): NormStatus {
  if (staticStatus === "unregulated") return reasonerStatus;
  if (reasonerStatus === "unregulated" || reasonerStatus === staticStatus) return staticStatus;
  if (staticStatus === "conflict" || reasonerStatus === "conflict") return "conflict";
  if (staticStatus === "forbidden" || reasonerStatus === "forbidden") return "conflict";
  if (staticStatus === "obligated" || reasonerStatus === "obligated") return "obligated";
  return "permitted";
}

export class DecisionEngine {
  private readonly db: MettaDB = mettaDB();
  private readonly reasoner: EvidenceReasoner;
  private readonly motivationScores: Readonly<Record<string, number>>;

  constructor(
    reasoner: EvidenceReasoner,
    motivationScores: Readonly<Record<string, number>> = {},
  ) {
    assertPlainRecord(motivationScores, "motivation scores");
    this.reasoner = reasoner;
    this.motivationScores = Object.freeze(Object.fromEntries(Object.entries(motivationScores)));
  }

  /** Evaluate one action against the scenario. Motivation is an optional
   * normalized score in [0, 1], matching the values used by `rank`. */
  evaluateAction(
    scenario: GoalScenario,
    action: CandidateAction,
    motivation?: number,
  ): Decision {
    const validatedScenario = createGoalScenario(scenario);
    const suppliedAction = createCandidateAction(action);
    const declaredAction = validatedScenario.actions.find(
      (candidate) => candidate.id === suppliedAction.id,
    );
    if (declaredAction === undefined) {
      throw new RangeError(`action is not declared in the scenario: ${suppliedAction.id}`);
    }
    if (
      motivation !== undefined &&
      (!Number.isFinite(motivation) || motivation < 0 || motivation > 1)
    ) {
      throw new RangeError("normalized motivation must be finite and within [0, 1]");
    }
    return this.evaluateResolvedAction(
      validatedScenario,
      declaredAction,
      resolveNorms(declaredAction.id, validatedScenario.norms),
      motivation,
    );
  }

  rank(scenario: GoalScenario): Decision[] {
    const validatedScenario = createGoalScenario(scenario);
    const motivation = normalizedMotivation(validatedScenario, this.motivationScores);
    const norms = resolveNormsBatch(
      validatedScenario.actions.map((action) => action.id),
      validatedScenario.norms,
    );
    return validatedScenario.actions
      .map((action) =>
        this.evaluateResolvedAction(
          validatedScenario,
          action,
          norms.get(action.id)!,
          ownValue(motivation, action.id),
        ),
      )
      .sort((left, right) => right.score - left.score);
  }

  private evaluateResolvedAction(
    scenario: GoalScenario,
    action: CandidateAction,
    norm: NormResolution,
    motivation: number | undefined,
  ): Decision {
    const projected = createEvidenceProjection(this.reasoner.project(action));
    const projectedNormStatus = evidenceNormStatus(projected.deontic, action.id);
    const mergedNormStatus = mergeNormStatus(norm.status, projectedNormStatus);
    const evidence: EvidenceProjection = createEvidenceProjection({
      ...projected,
      deontic: mergedNormStatus,
    });
    const normReasons = [...norm.reasons];
    if (projectedNormStatus !== "unregulated") {
      normReasons.push(`reasoner:${projectedNormStatus}`);
    }
    const goalScores = goalCoverage(scenario.goals, action.satisfies);
    const missingRequired = missingRequiredGoals(scenario.goals, action.satisfies);

    const warnings: string[] = [];
    if (missingRequired.length > 0) {
      warnings.push("missing required goals: " + missingRequired.join(", "));
    }
    const blocksAction = mergedNormStatus === "forbidden" || mergedNormStatus === "conflict";
    if (blocksAction) warnings.push(`deontic status: ${mergedNormStatus}`);

    let score: number;
    let status: DecisionStatus;
    if (motivation !== undefined) {
      score = scoreAction(this.db, [
        mergedNormStatus,
        evidence.strength,
        evidence.confidence,
        motivation,
      ]);
      status = blocksAction ? "blocked" : statusFor(this.db, score, missingRequired.length);
    } else if (blocksAction) {
      score = -1;
      status = "blocked";
    } else {
      score = num(
        this.db,
        offlineScoreExpr(
          goalScores.all,
          evidence.strength,
          evidence.confidence,
          goalScores.individual,
          goalScores.collective,
          mergedNormStatus === "obligated" ? 0.1 : 0,
        ),
      );
      status = statusFor(this.db, score, missingRequired.length);
    }

    const metadata: Record<string, string> = {
      deontic_expectation: evidence.expectation.toFixed(6),
      norm_priority: String(norm.priority),
      evidence_source: evidence.source,
      reasoner_source: this.reasoner.source,
      reasoner_deontic: projectedNormStatus,
    };
    if (motivation !== undefined) {
      metadata.motivation = motivation.toFixed(4);
      metadata.score_engine = "metta-ts";
    }

    return createDecision({
      actionId: action.id,
      label: action.label,
      status,
      score,
      goalScore: goalScores.all,
      individualScore: goalScores.individual,
      collectiveScore: goalScores.collective,
      evidence,
      normStatus: mergedNormStatus,
      normReasons,
      satisfiedGoals: [...action.satisfies],
      missingRequiredGoals: missingRequired,
      warnings,
      metadata,
    });
  }
}

function normalizedMotivation(
  scenario: GoalScenario,
  scores: Readonly<Record<string, number>>,
): Record<string, number> {
  const providedIds = Object.keys(scores);
  if (providedIds.length === 0) return {};
  const actionIds = new Set(scenario.actions.map((action) => action.id));
  const unknownIds = providedIds.filter((actionId) => !actionIds.has(actionId));
  if (unknownIds.length > 0) {
    throw new RangeError(`motivation scores reference unknown action IDs: ${unknownIds.join(", ")}`);
  }
  const missingIds = scenario.actions
    .filter((action) => ownValue(scores, action.id) === undefined)
    .map((action) => action.id);
  if (missingIds.length > 0) {
    throw new RangeError(`motivation scores missing action IDs: ${missingIds.join(", ")}`);
  }
  const values: number[] = [];
  for (const action of scenario.actions) {
    const value = ownValue(scores, action.id);
    if (value === undefined) throw new Error(`missing validated motivation score: ${action.id}`);
    if (!Number.isFinite(value)) {
      throw new RangeError(`motivation score for ${action.id} must be finite`);
    }
    values.push(value);
  }
  const normalized = normalizeFiniteMotivation(values);
  return Object.fromEntries(
    scenario.actions.map((action, index) => [action.id, normalized[index]!]),
  );
}

/** Min-max normalize finite values without argument-count or binary64 overflow. */
export function normalizeFiniteMotivation(values: readonly number[]): number[] {
  assertDenseArray(values, "motivation values");
  if (values.length === 0) return [];
  let low = values[0]!;
  let high = values[0]!;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new RangeError("motivation values must be finite");
    }
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (high <= 0) return values.map(() => 0);
  if (low === high) return values.map(() => 1);

  const span = high - low;
  if (Number.isFinite(span)) {
    return values.map((value) => Math.max(0, Math.min(1, (value - low) / span)));
  }
  const scale = Math.max(Math.abs(low), Math.abs(high));
  const scaledLow = low / scale;
  const scaledSpan = high / scale - scaledLow;
  return values.map((value) =>
    Math.max(0, Math.min(1, (value / scale - scaledLow) / scaledSpan)),
  );
}

interface GoalScores {
  all: number;
  individual: number;
  collective: number;
}

export function goalCoverage(goals: readonly Goal[], satisfied: readonly string[]): GoalScores {
  const satisfiedSet = new Set(satisfied);
  return {
    all: weightedCoverage(goals, satisfiedSet),
    individual: weightedCoverage(
      goals.filter((goal) => goal.kind === "individual"),
      satisfiedSet,
    ),
    collective: weightedCoverage(
      goals.filter((goal) => goal.kind === "collective"),
      satisfiedSet,
    ),
  };
}

function weightedCoverage(goals: readonly Goal[], satisfied: ReadonlySet<string>): number {
  const total = sumGoalWeights(goals);
  if (total === 0) return 0;
  const covered = goals
    .filter((goal) => satisfied.has(goal.id))
    .reduce((sum, goal) => sum + goal.weight, 0);
  return covered / total;
}

export function missingRequiredGoals(goals: readonly Goal[], satisfied: readonly string[]): string[] {
  const satisfiedSet = new Set(satisfied);
  return goals
    .filter((goal) => goal.required && !satisfiedSet.has(goal.id))
    .map((goal) => goal.id);
}
