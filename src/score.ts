// Rank caller-supplied actions through the packaged GoalChainer MeTTa module.

import { atomToJs, ExpressionAtom } from "@metta-ts/hyperon";

import {
  NORM_STATUSES,
  resolveNorms,
  resolveNormsBatch,
  type NormResolution,
  type NormStatus,
} from "./deontic.js";
import {
  mettaCall,
  mettaFloat,
  mettaOne,
  mettaSymbol,
  mettaTuple,
  sharedGoalChainerMetta,
  type GoalChainerMetta,
  type Term,
} from "./metta.js";
import {
  createCandidateAction,
  createDecision,
  createEvidenceProjection,
  createGoal,
  createGoalScenario,
  SCORE_EQUIVALENCE_EPSILON,
  type CandidateAction,
  type Decision,
  type DecisionStatus,
  type EvidenceProjection,
  type Goal,
  type GoalScenario,
} from "./models.js";
import { assertDenseArray, assertPlainRecord, ownValue } from "./records.js";

export interface EvidenceReasoner {
  readonly source: string;
  project(action: CandidateAction): EvidenceProjection;
}

/** Capture one stable evidence capability and attributable source label. */
export function snapshotEvidenceReasoner(reasoner: EvidenceReasoner): EvidenceReasoner {
  if (
    reasoner === null ||
    (typeof reasoner !== "object" && typeof reasoner !== "function")
  ) {
    throw new TypeError("evidence reasoner must be an object");
  }
  const source = reasoner.source;
  if (typeof source !== "string" || source.trim() === "") {
    throw new TypeError("evidence reasoner source must be a nonblank string");
  }
  const project = reasoner.project;
  if (typeof project !== "function") {
    throw new TypeError("evidence reasoner project must be a function");
  }
  return Object.freeze({
    source,
    project(action: CandidateAction) {
      return project.call(reasoner, action);
    },
  });
}

export interface DecisionRanking {
  readonly decisions: readonly Decision[];
  readonly tiedActionIds: readonly string[];
  readonly automaticExecutionAllowed: boolean;
}

const NORM_STATUS_SET: ReadonlySet<string> = new Set(NORM_STATUSES);
const DECISION_STATUS_SET: ReadonlySet<string> = new Set([
  "blocked",
  "recommended",
  "candidate",
  "weak",
]);

interface GoalScores {
  all: number;
  individual: number;
  collective: number;
}

interface GoalAnalysis extends GoalScores {
  missing: string[];
}

interface PreparedEvaluation {
  readonly action: CandidateAction;
  readonly norm: NormResolution;
  readonly projected: EvidenceProjection;
  readonly projectedNormStatus: NormStatus;
  readonly motivation: number | undefined;
  readonly goalAnalysis: GoalAnalysis | undefined;
  readonly request: Term;
}

function evidenceNormStatus(value: string, actionId: string): NormStatus {
  if (!NORM_STATUS_SET.has(value)) {
    throw new TypeError(
      `evidence reasoner returned unsupported deontic status for ${actionId}: ${value}`,
    );
  }
  return value as NormStatus;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`oh-my-goals.metta returned an invalid number for ${path}`);
  }
  return value;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`oh-my-goals.metta returned an invalid string sequence for ${path}`);
  }
  return [...value] as string[];
}

/** Decode the shared outer shape returned by gc-rank-decisions. */
export function nativeRankingFields(
  value: unknown,
  context: string,
): readonly [rows: unknown[], tied: unknown[], automatic: boolean] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== "RankedDecisions" ||
    !Array.isArray(value[1]) ||
    !Array.isArray(value[2]) ||
    typeof value[3] !== "boolean"
  ) {
    throw new Error(`oh-my-goals.metta returned an invalid ${context} ranking`);
  }
  return [value[1], value[2], value[3]];
}

function evaluationBatchFields(
  value: unknown,
  context: string,
): readonly [evaluated: unknown[], rows: unknown[]] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== "EvaluationBatch" ||
    !Array.isArray(value[1]) ||
    !Array.isArray(value[2])
  ) {
    throw new Error(`oh-my-goals.metta returned an invalid ${context}`);
  }
  return [value[1], value[2]];
}

function goalTerm(goal: Goal): Term {
  return mettaCall(
    "Goal",
    goal.id,
    mettaSymbol(goal.kind),
    mettaFloat(goal.weight),
    goal.required,
  );
}

function goalsTerm(goals: readonly Goal[]): Term {
  return mettaTuple(goals.map(goalTerm));
}

function actionTerm(action: CandidateAction): Term {
  return mettaCall("Action", action.id, action.label, mettaTuple(action.satisfies));
}

function analyzedActionTerm(action: CandidateAction): Term {
  return mettaCall("AnalyzedAction", action.id, action.label);
}

function resolutionTerm(norm: NormResolution): Term {
  return mettaCall(
    "NormResolution",
    mettaSymbol(norm.status),
    mettaFloat(norm.priority),
    mettaTuple(norm.reasons),
  );
}

function evidenceTerm(evidence: EvidenceProjection, deontic: NormStatus): Term {
  return mettaCall(
    "Evidence",
    mettaFloat(evidence.strength),
    mettaFloat(evidence.confidence),
    evidence.source,
    evidence.projection,
    mettaTuple(evidence.proofs),
    mettaSymbol(deontic),
  );
}

function motivationTerm(motivation: number | undefined): Term {
  return motivation === undefined
    ? mettaCall("NoMotivation")
    : mettaCall("Motivation", mettaFloat(motivation));
}

function goalAnalysisSummaryTerm(analysis: GoalAnalysis): Term {
  return mettaCall(
    "GoalAnalysisSummary",
    mettaFloat(analysis.all),
    mettaFloat(analysis.individual),
    mettaFloat(analysis.collective),
    analysis.missing.length,
  );
}

function prepareEvaluation(
  scenario: GoalScenario,
  action: CandidateAction,
  norm: NormResolution,
  reasoner: EvidenceReasoner,
  motivation: number | undefined,
  order: number,
): PreparedEvaluation {
  const projected = createEvidenceProjection(reasoner.project(action));
  const projectedNormStatus = evidenceNormStatus(projected.deontic, action.id);
  const goalAnalysis = scenario.goals.length > 16 || action.satisfies.length > 16
    ? nativeGoalAnalysis(scenario.goals, action.satisfies)
    : undefined;
  const request = goalAnalysis === undefined
    ? mettaCall(
        "EvaluateRequest",
        order,
        goalsTerm(scenario.goals),
        actionTerm(action),
        resolutionTerm(norm),
        evidenceTerm(projected, projectedNormStatus),
        motivationTerm(motivation),
      )
    : mettaCall(
        "EvaluateAnalyzedRequest",
        order,
        analyzedActionTerm(action),
        resolutionTerm(norm),
        evidenceTerm(projected, projectedNormStatus),
        motivationTerm(motivation),
        goalAnalysisSummaryTerm(goalAnalysis),
      );
  return {
    action,
    norm,
    projected,
    projectedNormStatus,
    motivation,
    goalAnalysis,
    request,
  };
}

function readDecisionResult(
  value: unknown,
  prepared: PreparedEvaluation,
  reasonerSource: string,
): Decision {
  if (!Array.isArray(value) || value.length !== 15 || value[0] !== "DecisionResult") {
    throw new Error(
      `oh-my-goals.metta returned an invalid decision for ${prepared.action.id}`,
    );
  }
  const [
    ,
    actionId,
    label,
    status,
    scoreValue,
    goalScoreValue,
    individualScoreValue,
    collectiveScoreValue,
    expectationValue,
    normStatus,
    priorityValue,
    nativeReasons,
    reasonerStatus,
    satisfiedValue,
    missingValue,
  ] = value;
  if (actionId !== prepared.action.id || label !== prepared.action.label) {
    throw new Error(`oh-my-goals.metta changed the declared action identity: ${prepared.action.id}`);
  }
  if (typeof status !== "string" || !DECISION_STATUS_SET.has(status)) {
    throw new Error(`oh-my-goals.metta returned an invalid decision status for ${actionId}`);
  }
  if (typeof normStatus !== "string" || !NORM_STATUS_SET.has(normStatus)) {
    throw new Error(`oh-my-goals.metta returned an invalid norm status for ${actionId}`);
  }
  if (reasonerStatus !== prepared.projectedNormStatus) {
    throw new Error(`oh-my-goals.metta changed the evidence norm status for ${actionId}`);
  }
  const score = finiteNumber(scoreValue, `${actionId}.score`);
  const goalScore = finiteNumber(goalScoreValue, `${actionId}.goalScore`);
  const individualScore = finiteNumber(individualScoreValue, `${actionId}.individualScore`);
  const collectiveScore = finiteNumber(collectiveScoreValue, `${actionId}.collectiveScore`);
  finiteNumber(expectationValue, `${actionId}.expectation`);
  const priority = finiteNumber(priorityValue, `${actionId}.normPriority`);
  if (!Number.isSafeInteger(priority) || priority !== prepared.norm.priority) {
    throw new Error(`oh-my-goals.metta returned an invalid norm priority for ${actionId}`);
  }
  const reasons = stringList(nativeReasons, `${actionId}.normReasons`);
  let satisfiedGoals: string[];
  if (prepared.goalAnalysis === undefined) {
    satisfiedGoals = stringList(satisfiedValue, `${actionId}.satisfiedGoals`);
  } else if (
    Array.isArray(satisfiedValue) &&
    satisfiedValue.length === 1 &&
    satisfiedValue[0] === "AnalyzedSatisfaction"
  ) {
    satisfiedGoals = [...prepared.action.satisfies];
  } else {
    throw new Error(`oh-my-goals.metta returned invalid analyzed satisfaction for ${actionId}`);
  }
  let missingRequiredGoals: string[];
  if (prepared.goalAnalysis === undefined) {
    missingRequiredGoals = stringList(missingValue, `${actionId}.missingRequiredGoals`);
  } else if (
    Array.isArray(missingValue) &&
    missingValue.length === 1 &&
    missingValue[0] === "AnalyzedMissing"
  ) {
    missingRequiredGoals = [...prepared.goalAnalysis.missing];
  } else {
    throw new Error(`oh-my-goals.metta returned invalid analyzed missing goals for ${actionId}`);
  }
  if (
    prepared.goalAnalysis !== undefined &&
    (
      goalScore !== prepared.goalAnalysis.all ||
      individualScore !== prepared.goalAnalysis.individual ||
      collectiveScore !== prepared.goalAnalysis.collective ||
      missingRequiredGoals.length !== prepared.goalAnalysis.missing.length ||
      missingRequiredGoals.some(
        (goalId, index) => goalId !== prepared.goalAnalysis!.missing[index],
      )
    )
  ) {
    throw new Error(`oh-my-goals.metta changed the analyzed goal result for ${actionId}`);
  }
  const normReasons = [
    ...reasons,
    ...(prepared.projectedNormStatus === "unregulated"
      ? []
      : [`reasoner:${prepared.projectedNormStatus}`]),
  ];
  const warnings = [
    ...(missingRequiredGoals.length === 0
      ? []
      : [`missing required goals: ${missingRequiredGoals.join(", ")}`]),
    ...(normStatus === "forbidden" || normStatus === "conflict"
      ? [`deontic status: ${normStatus}`]
      : []),
  ];
  const evidence = createEvidenceProjection({
    ...prepared.projected,
    deontic: normStatus as NormStatus,
  });
  const metadata: Record<string, string> = {
    deontic_expectation: evidence.expectation.toFixed(6),
    norm_priority: String(priority),
    evidence_source: evidence.source,
    reasoner_source: reasonerSource,
    reasoner_deontic: prepared.projectedNormStatus,
  };
  if (prepared.motivation !== undefined) {
    metadata.motivation = prepared.motivation.toFixed(4);
    metadata.score_engine = "metta-ts";
  }
  return createDecision({
    actionId,
    label,
    status: status as DecisionStatus,
    score,
    goalScore,
    individualScore,
    collectiveScore,
    evidence,
    normStatus: normStatus as NormStatus,
    normReasons,
    satisfiedGoals,
    missingRequiredGoals,
    warnings,
    metadata,
  });
}

function readRanking(
  value: unknown,
  prepared: readonly PreparedEvaluation[],
  reasonerSource: string,
): DecisionRanking {
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== "ScenarioEvaluation") {
    throw new Error("oh-my-goals.metta returned an invalid scenario evaluation");
  }
  const evaluated = value[1];
  const ranking = value[2];
  if (!Array.isArray(evaluated) || evaluated.length !== prepared.length) {
    throw new Error("oh-my-goals.metta returned the wrong number of evaluated decisions");
  }
  const decisionsById = new Map<string, Decision>();
  evaluated.forEach((entry, index) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      entry[0] !== "EvaluatedDecision" ||
      entry[1] !== index
    ) {
      throw new Error(`oh-my-goals.metta returned an invalid evaluated decision at ${index}`);
    }
    const decision = readDecisionResult(entry[2], prepared[index]!, reasonerSource);
    decisionsById.set(decision.actionId, decision);
  });
  const [rankedRows, tiedRows, automatic] = nativeRankingFields(ranking, "decision");
  const rankedIds = rankedRows.map((row, index) => {
    if (
      !Array.isArray(row) ||
      row.length !== 5 ||
      row[0] !== "DecisionRow" ||
      typeof row[1] !== "string" ||
      typeof row[2] !== "number" ||
      typeof row[3] !== "number" ||
      typeof row[4] !== "string"
    ) {
      throw new Error(`oh-my-goals.metta returned an invalid ranked row at ${index}`);
    }
    const decision = decisionsById.get(row[1]);
    if (decision === undefined || decision.score !== row[3] || decision.status !== row[4]) {
      throw new Error(`oh-my-goals.metta returned an inconsistent ranked row for ${row[1]}`);
    }
    return row[1];
  });
  const tiedActionIds = stringList(tiedRows, "ranking.tiedActionIds");
  const decisions = Object.freeze(rankedIds.map((actionId) => decisionsById.get(actionId)!));
  return Object.freeze({
    decisions,
    tiedActionIds: Object.freeze(tiedActionIds),
    automaticExecutionAllowed: automatic,
  });
}

export function mergeNormStatus(staticStatus: NormStatus, reasonerStatus: NormStatus): NormStatus {
  if (!NORM_STATUS_SET.has(staticStatus) || !NORM_STATUS_SET.has(reasonerStatus)) {
    throw new RangeError("norm statuses must use the GoalChainer deontic vocabulary");
  }
  const value = mettaOne(
    sharedGoalChainerMetta(),
    "gc-merge-norm-status",
    mettaSymbol(staticStatus),
    mettaSymbol(reasonerStatus),
  );
  if (typeof value !== "string" || !NORM_STATUS_SET.has(value)) {
    throw new Error(`oh-my-goals.metta returned an invalid merged norm status: ${String(value)}`);
  }
  return value as NormStatus;
}

export class DecisionEngine {
  private readonly db: GoalChainerMetta = sharedGoalChainerMetta();
  private readonly reasoner: EvidenceReasoner;
  private readonly motivationScores: Readonly<Record<string, number>>;

  constructor(
    reasoner: EvidenceReasoner,
    motivationScores: Readonly<Record<string, number>> = {},
  ) {
    assertPlainRecord(motivationScores, "motivation scores");
    this.reasoner = snapshotEvidenceReasoner(reasoner);
    this.motivationScores = Object.freeze(Object.fromEntries(Object.entries(motivationScores)));
  }

  /** Evaluate one declared action through the native MeTTa policy relations. */
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
    const prepared = prepareEvaluation(
      validatedScenario,
      declaredAction,
      resolveNorms(declaredAction.id, validatedScenario.norms),
      this.reasoner,
      motivation,
      0,
    );
    const results = this.db.evalJs(mettaCall("gc-evaluate-request", prepared.request));
    if (results.length !== 1) {
      throw new Error(`oh-my-goals.metta returned ${results.length} decisions for ${declaredAction.id}`);
    }
    const [evaluated, rows] = evaluationBatchFields(
      results[0],
      `decision for ${declaredAction.id}`,
    );
    if (
      evaluated.length !== 1 ||
      rows.length !== 1 ||
      !Array.isArray(evaluated[0]) ||
      evaluated[0].length !== 3 ||
      evaluated[0][0] !== "EvaluatedDecision" ||
      evaluated[0][1] !== 0
    ) {
      throw new Error(`oh-my-goals.metta returned an invalid decision for ${declaredAction.id}`);
    }
    return readDecisionResult(evaluated[0][2], prepared, this.reasoner.source);
  }

  /** Evaluate and rank every declared action through one MeTTa query. */
  rankWithReceipt(scenario: GoalScenario): DecisionRanking {
    const validatedScenario = createGoalScenario(scenario);
    const motivation = normalizedMotivation(validatedScenario, this.motivationScores);
    const norms = resolveNormsBatch(
      validatedScenario.actions.map((action) => action.id),
      validatedScenario.norms,
    );
    const prepared = validatedScenario.actions.map((action, order) =>
      prepareEvaluation(
        validatedScenario,
        action,
        norms.get(action.id)!,
        this.reasoner,
        ownValue(motivation, action.id),
        order,
      ),
    );
    if (
      prepared.length <= 16 &&
      prepared.every((entry) => entry.goalAnalysis === undefined)
    ) {
      const values = this.db.evalJs(mettaCall(
        "gc-evaluate-and-rank",
        mettaTuple(prepared.map((entry) => entry.request)),
        mettaFloat(SCORE_EQUIVALENCE_EPSILON),
      ));
      if (values.length !== 1) {
        throw new Error(`oh-my-goals.metta returned ${values.length} scenario evaluations`);
      }
      return readRanking(values[0], prepared, this.reasoner.source);
    }

    const groups = this.db.evalMany(prepared.map((entry) =>
      mettaCall("gc-evaluate-request", entry.request)
    ));
    const batches = groups.map((values, index) => {
      if (values.length !== 1) {
        throw new Error(
          `oh-my-goals.metta returned ${values.length} evaluations for action ${index}`,
        );
      }
      const batchAtom = values[0]!;
      const batch = atomToJs(batchAtom);
      const [evaluated, rows] = evaluationBatchFields(batch, `action evaluation at ${index}`);
      if (evaluated.length !== 1 || rows.length !== 1) {
        throw new Error(`oh-my-goals.metta returned an invalid action evaluation at ${index}`);
      }
      if (!(batchAtom instanceof ExpressionAtom)) {
        throw new Error(`oh-my-goals.metta returned a non-expression action evaluation at ${index}`);
      }
      const batchFields = batchAtom.children();
      const rowSequence = batchFields[2];
      if (!(rowSequence instanceof ExpressionAtom) || rowSequence.children().length !== 1) {
        throw new Error(`oh-my-goals.metta returned an invalid native decision row at ${index}`);
      }
      return {
        evaluated: evaluated[0],
        row: rowSequence.children()[0]!,
        rowValue: rows[0],
      };
    });
    for (const [index, batch] of batches.entries()) {
      const entry = batch.evaluated;
      if (!Array.isArray(entry) || entry.length !== 3 || entry[0] !== "EvaluatedDecision") {
        throw new Error(`oh-my-goals.metta returned an invalid evaluated decision at ${index}`);
      }
      const decision = readDecisionResult(entry[2], prepared[index]!, this.reasoner.source);
      if (
        !Array.isArray(batch.rowValue) ||
        batch.rowValue.length !== 5 ||
        batch.rowValue[0] !== "DecisionRow" ||
        batch.rowValue[1] !== decision.actionId ||
        batch.rowValue[2] !== index ||
        batch.rowValue[3] !== decision.score ||
        batch.rowValue[4] !== decision.status
      ) {
        throw new Error(`oh-my-goals.metta returned an inconsistent decision row at ${index}`);
      }
    }
    const ranking = mettaOne(
      this.db,
      "gc-rank-decisions",
      mettaTuple(batches.map((batch) => batch.row)),
      mettaFloat(SCORE_EQUIVALENCE_EPSILON),
    );
    return readRanking(
      ["ScenarioEvaluation", batches.map((batch) => batch.evaluated), ranking],
      prepared,
      this.reasoner.source,
    );
  }

  rank(scenario: GoalScenario): Decision[] {
    return [...this.rankWithReceipt(scenario).decisions];
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
  const values = scenario.actions.map((action) => {
    const value = ownValue(scores, action.id);
    if (value === undefined) throw new Error(`missing validated motivation score: ${action.id}`);
    if (!Number.isFinite(value)) {
      throw new RangeError(`motivation score for ${action.id} must be finite`);
    }
    return value;
  });
  const normalized = normalizeFiniteMotivation(values);
  return Object.fromEntries(
    scenario.actions.map((action, index) => [action.id, normalized[index]!]),
  );
}

/** Min-max normalize finite values through oh-my-goals.metta. */
export function normalizeFiniteMotivation(values: readonly number[]): number[] {
  assertDenseArray(values, "motivation values");
  values.forEach((value) => {
    if (!Number.isFinite(value)) throw new RangeError("motivation values must be finite");
  });
  if (values.length === 0) return [];
  const result = mettaOne(
    sharedGoalChainerMetta(),
    "gc-normalize-values-fast",
    mettaTuple(values.map(mettaFloat)),
  );
  if (
    !Array.isArray(result) ||
    result.length !== values.length ||
    result.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("oh-my-goals.metta returned invalid normalized motivation values");
  }
  return [...result] as number[];
}

function nativeGoalAnalysis(goals: readonly Goal[], satisfied: readonly string[]): GoalAnalysis {
  assertDenseArray(goals, "goals");
  assertDenseArray(satisfied, "satisfied goals");
  const stableGoals = goals.map(createGoal);
  satisfied.forEach((goalId, index) => {
    if (typeof goalId !== "string") {
      throw new TypeError(`satisfied goals[${index}] must be a string`);
    }
  });
  const encodedGoals = goalsTerm(stableGoals);
  const encodedSatisfied = mettaTuple(satisfied);
  if (stableGoals.length > 16 || satisfied.length > 16) {
    const fold = mettaOne(
      sharedGoalChainerMetta(),
      "gc-goal-fold-atom",
      mettaCall("noeval", encodedGoals),
      mettaCall("noeval", encodedSatisfied),
    );
    if (!Array.isArray(fold) || fold.length !== 8 || fold[0] !== "GoalFold") {
      throw new Error("oh-my-goals.metta returned an invalid goal fold");
    }
    const totals = fold.slice(1, 7).map((value, index) =>
      finiteNumber(value, `goal fold value ${index}`)
    );
    const missing = stringList(fold[7], "goal fold missing");
    const scores = mettaOne(
      sharedGoalChainerMetta(),
      "gc-goal-scores",
      ...totals.map(mettaFloat),
    );
    if (!Array.isArray(scores) || scores.length !== 4 || scores[0] !== "GoalScores") {
      throw new Error("oh-my-goals.metta returned invalid goal scores");
    }
    return {
      all: finiteNumber(scores[1], "goal scores all"),
      individual: finiteNumber(scores[2], "goal scores individual"),
      collective: finiteNumber(scores[3], "goal scores collective"),
      missing,
    };
  }
  const value = mettaOne(
    sharedGoalChainerMetta(),
    "gc-goal-analysis",
    encodedGoals,
    encodedSatisfied,
  );
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== "GoalAnalysis") {
    throw new Error("oh-my-goals.metta returned an invalid goal analysis");
  }
  return {
    all: finiteNumber(value[1], "goal analysis all"),
    individual: finiteNumber(value[2], "goal analysis individual"),
    collective: finiteNumber(value[3], "goal analysis collective"),
    missing: stringList(value[4], "goal analysis missing"),
  };
}

export function goalCoverage(goals: readonly Goal[], satisfied: readonly string[]): GoalScores {
  const { all, individual, collective } = nativeGoalAnalysis(goals, satisfied);
  return { all, individual, collective };
}

export function missingRequiredGoals(goals: readonly Goal[], satisfied: readonly string[]): string[] {
  return nativeGoalAnalysis(goals, satisfied).missing;
}
