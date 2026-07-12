// Generic GoalChainer orchestration over caller-supplied structured input.

import { isDeepStrictEqual } from "node:util";

import { NORM_STATUSES, resolveNorms, type NormStatus } from "./deontic.js";
import { parseGoalChainerInput, type GoalChainerInput } from "./input.js";
import {
  consensusDecision,
  createMotivationResult,
  MOTIVATION_ENGINE,
  motivationSummary,
  type MotivationOptions,
  type MotivationResult,
} from "./motivation.js";
import {
  createDecision,
  createEvidenceProjection,
  createGoalScenario,
  decisionToDict,
  deriveDecisionStatus,
  SCORE_EQUIVALENCE_EPSILON,
  type Decision,
  type EvidenceProjection,
  type GoalScenario,
} from "./models.js";
import { StaticEvidenceReasoner } from "./reasoner.js";
import {
  DecisionEngine,
  goalCoverage,
  mergeNormStatus,
  missingRequiredGoals,
  normalizeFiniteMotivation,
  type EvidenceReasoner,
} from "./score.js";
import {
  assertDenseArray,
  assertKnownKeys,
  assertPlainRecord,
  ownValue,
} from "./records.js";

export interface GoalChainerOptions {
  /** Disable motivation consensus or override correlations and risks. */
  motivation?: false | MotivationOptions;
}

export interface GoalChainerRun {
  readonly scenario: GoalScenario;
  readonly motivation: MotivationResult | null;
  readonly decisions: readonly Decision[];
  readonly selected: Decision;
  readonly tiedActionIds: readonly string[];
  readonly selectionTied: boolean;
  readonly automaticExecutionAllowed: boolean;
}

export class ContextualEvidenceRequiresReasonerError extends TypeError {}

function validatedOptions(options: GoalChainerOptions): GoalChainerOptions {
  assertPlainRecord(options, "GoalChainer options");
  assertKnownKeys(options, "GoalChainer options", ["motivation"]);
  const motivation = options.motivation;
  if (motivation === undefined || motivation === false) return Object.freeze({ motivation });
  assertPlainRecord(motivation, "GoalChainer motivation options");
  assertKnownKeys(motivation, "GoalChainer motivation options", ["correlations", "risks"]);
  let correlations: MotivationOptions["correlations"];
  if (motivation.correlations !== undefined) {
    assertPlainRecord(motivation.correlations, "GoalChainer motivation correlations");
    correlations = Object.freeze(
      Object.fromEntries(
        Object.entries(motivation.correlations).map(([actionId, values]) => {
          assertPlainRecord(values, `GoalChainer motivation correlations.${actionId}`);
          return [actionId, Object.freeze(Object.fromEntries(Object.entries(values)))];
        }),
      ),
    ) as MotivationOptions["correlations"];
  }
  let risks: MotivationOptions["risks"];
  if (motivation.risks !== undefined) {
    assertPlainRecord(motivation.risks, "GoalChainer motivation risks");
    risks = Object.freeze(
      Object.fromEntries(Object.entries(motivation.risks)),
    ) as MotivationOptions["risks"];
  }
  return Object.freeze({
    motivation: Object.freeze({
      ...(correlations === undefined ? {} : { correlations }),
      ...(risks === undefined ? {} : { risks }),
    }),
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameDecision(left: Decision, right: Decision): boolean {
  return isDeepStrictEqual(decisionToDict(left), decisionToDict(right));
}

function validatedRun(run: GoalChainerRun): GoalChainerRun {
  assertPlainRecord(run, "GoalChainer run");
  assertKnownKeys(run, "GoalChainer run", [
    "scenario",
    "motivation",
    "decisions",
    "selected",
    "tiedActionIds",
    "selectionTied",
    "automaticExecutionAllowed",
  ]);
  const scenario = createGoalScenario(run.scenario);
  const motivation = run.motivation === null ? null : createMotivationResult(run.motivation);
  let normalizedMotivation: Readonly<Record<string, number>> | null = null;
  if (motivation !== null) {
    if (motivation.engine !== MOTIVATION_ENGINE) {
      throw new RangeError(`GoalChainer run motivation engine must be ${MOTIVATION_ENGINE}`);
    }
    const expectedIndividual = scenario.goals.map((goal) =>
      goal.kind === "individual" ? goal.weight : 0,
    );
    const expectedCollective = scenario.goals.map((goal) =>
      goal.kind === "collective" ? goal.weight : 0,
    );
    if (
      motivation.individual_goals.length !== scenario.goals.length ||
      motivation.collective_goals.length !== scenario.goals.length ||
      !motivation.individual_goals.every((value, index) => value === expectedIndividual[index]) ||
      !motivation.collective_goals.every((value, index) => value === expectedCollective[index]) ||
      !sameStrings(
        motivation.candidates.map((candidate) => candidate.id),
        scenario.actions.map((action) => action.id),
      )
    ) {
      throw new RangeError("GoalChainer run motivation does not match the scenario declaration");
    }
    const normalized = normalizeFiniteMotivation(
      scenario.actions.map((action) => motivation.consensus_scores[action.id]!),
    );
    normalizedMotivation = Object.freeze(Object.fromEntries(
      scenario.actions.map((action, index) => [action.id, normalized[index]!]),
    ));
  }
  assertDenseArray(run.decisions, "GoalChainer run decisions");
  const suppliedDecisions = Object.freeze(
    run.decisions.map((decision) => createDecision(decision)),
  );
  if (suppliedDecisions.length !== scenario.actions.length) {
    throw new RangeError("GoalChainer run must contain one decision per declared action");
  }
  const actionById = new Map(scenario.actions.map((action) => [action.id, action]));
  const decisionIds = new Set<string>();
  const canonicalByAction = new Map<string, Decision>();
  suppliedDecisions.forEach((decision) => {
    if (decisionIds.has(decision.actionId)) {
      throw new RangeError(`duplicate GoalChainer run decision: ${decision.actionId}`);
    }
    decisionIds.add(decision.actionId);
    const action = actionById.get(decision.actionId);
    if (action === undefined) {
      throw new RangeError(`GoalChainer run decision references unknown action: ${decision.actionId}`);
    }
    if (decision.label !== action.label) {
      throw new RangeError(`GoalChainer run decision label disagrees for action: ${action.id}`);
    }
    if (!sameStrings(decision.satisfiedGoals, action.satisfies)) {
      throw new RangeError(`GoalChainer run satisfied goals disagree for action: ${action.id}`);
    }
    const expectedMissing = missingRequiredGoals(scenario.goals, action.satisfies);
    if (!sameStrings(decision.missingRequiredGoals, expectedMissing)) {
      throw new RangeError(`GoalChainer run missing required goals disagree for action: ${action.id}`);
    }
    const expectedCoverage = goalCoverage(scenario.goals, action.satisfies);
    if (
      decision.goalScore !== expectedCoverage.all ||
      decision.individualScore !== expectedCoverage.individual ||
      decision.collectiveScore !== expectedCoverage.collective
    ) {
      throw new RangeError(`GoalChainer run goal coverage disagrees for action: ${action.id}`);
    }
    const staticNorm = resolveNorms(action.id, scenario.norms);
    const reasonerStatus = ownValue(decision.metadata, "reasoner_deontic");
    if (
      typeof reasonerStatus !== "string" ||
      !NORM_STATUSES.includes(reasonerStatus as NormStatus)
    ) {
      throw new RangeError(`GoalChainer run has invalid reasoner deontic metadata: ${action.id}`);
    }
    const expectedNormStatus = mergeNormStatus(
      staticNorm.status,
      reasonerStatus as NormStatus,
    );
    if (decision.normStatus !== expectedNormStatus) {
      throw new RangeError(`GoalChainer run norm status disagrees for action: ${action.id}`);
    }
    const expectedReasons = [
      ...staticNorm.reasons,
      ...(reasonerStatus === "unregulated" ? [] : [`reasoner:${reasonerStatus}`]),
    ];
    if (!sameStrings(decision.normReasons, expectedReasons)) {
      throw new RangeError(`GoalChainer run norm reasons disagree for action: ${action.id}`);
    }
    const expectedWarnings = [
      ...(expectedMissing.length > 0
        ? [`missing required goals: ${expectedMissing.join(", ")}`]
        : []),
      ...(expectedNormStatus === "forbidden" || expectedNormStatus === "conflict"
        ? [`deontic status: ${expectedNormStatus}`]
        : []),
    ];
    if (!sameStrings(decision.warnings, expectedWarnings)) {
      throw new RangeError(`GoalChainer run warnings disagree for action: ${action.id}`);
    }
    const motivationScore = normalizedMotivation?.[action.id];
    const blocked = expectedNormStatus === "forbidden" || expectedNormStatus === "conflict";
    const bonus = expectedNormStatus === "obligated" ? 0.1 : 0;
    const expectedScore = blocked
      ? -1
      : motivationScore === undefined
        ? 0.42 * expectedCoverage.all +
          0.38 * (decision.evidence.strength * decision.evidence.confidence) +
          0.12 * Math.min(expectedCoverage.individual, expectedCoverage.collective) +
          bonus
        : 0.54 * motivationScore +
          0.38 * (decision.evidence.strength * decision.evidence.confidence) +
          bonus;
    if (Math.abs(decision.score - expectedScore) > SCORE_EQUIVALENCE_EPSILON) {
      throw new RangeError(`GoalChainer run score disagrees for action: ${action.id}`);
    }
    const expectedStatus = deriveDecisionStatus(
      expectedScore,
      expectedMissing.length,
      expectedNormStatus,
    );
    if (decision.status !== expectedStatus) {
      throw new RangeError(`GoalChainer run status disagrees for action: ${action.id}`);
    }
    const expectedMetadata = {
      deontic_expectation: decision.evidence.expectation.toFixed(6),
      norm_priority: String(staticNorm.priority),
      evidence_source: decision.evidence.source,
      reasoner_source: ownValue(decision.metadata, "reasoner_source"),
      reasoner_deontic: reasonerStatus,
      ...(motivationScore === undefined
        ? {}
        : { motivation: motivationScore.toFixed(4), score_engine: "metta-ts" }),
    };
    if (
      typeof ownValue(decision.metadata, "reasoner_source") !== "string" ||
      ownValue(decision.metadata, "reasoner_source")!.trim() === "" ||
      !isDeepStrictEqual(decision.metadata, expectedMetadata)
    ) {
      throw new RangeError(`GoalChainer run metadata disagrees for action: ${action.id}`);
    }
    canonicalByAction.set(action.id, createDecision({
      ...decision,
      score: expectedScore,
      status: expectedStatus,
    }));
  });
  const decisions = Object.freeze(
    scenario.actions
      .map((action) => canonicalByAction.get(action.id)!)
      .sort((left, right) => right.score - left.score),
  );
  if (
    !sameStrings(
      suppliedDecisions.map((decision) => decision.actionId),
      decisions.map((decision) => decision.actionId),
    )
  ) {
    throw new RangeError("GoalChainer run decisions must use the canonical score ranking");
  }
  const suppliedSelected = createDecision(run.selected);
  if (!sameDecision(suppliedSelected, suppliedDecisions[0]!)) {
    throw new RangeError("GoalChainer run selected decision must equal the first ranked decision");
  }
  const selected = decisions[0]!;
  assertDenseArray(run.tiedActionIds, "GoalChainer run tied action IDs");
  run.tiedActionIds.forEach((actionId, index) => {
    if (typeof actionId !== "string") {
      throw new TypeError(`GoalChainer run tied action IDs[${index}] must be a string`);
    }
  });
  const tiedActionIds = Object.freeze(
    decisions
      .filter(
        (decision) =>
          Math.abs(decision.score - selected.score) <= SCORE_EQUIVALENCE_EPSILON,
      )
      .map((decision) => decision.actionId),
  );
  if (!sameStrings(run.tiedActionIds, tiedActionIds)) {
    throw new RangeError("GoalChainer run tied action IDs disagree with the ranked decisions");
  }
  const selectionTied = tiedActionIds.length > 1;
  if (run.selectionTied !== selectionTied) {
    throw new RangeError("GoalChainer run selectionTied disagrees with the ranked decisions");
  }
  const automaticExecutionAllowed = selected.status === "recommended" && !selectionTied;
  if (run.automaticExecutionAllowed !== automaticExecutionAllowed) {
    throw new RangeError(
      "GoalChainer run automaticExecutionAllowed disagrees with the selected decision",
    );
  }
  return Object.freeze({
    scenario,
    motivation,
    decisions,
    selected: decisions[0]!,
    tiedActionIds,
    selectionTied,
    automaticExecutionAllowed,
  });
}

/** Evaluate a validated scenario with any evidence reasoner implementation. */
export function evaluateScenario(
  scenario: GoalScenario,
  reasoner: EvidenceReasoner,
  options: GoalChainerOptions = {},
): GoalChainerRun {
  const stableOptions = validatedOptions(options);
  const validatedScenario = createGoalScenario(scenario);
  const projections = new Map<string, EvidenceProjection>();
  for (const action of validatedScenario.actions) {
    projections.set(action.id, createEvidenceProjection(reasoner.project(action)));
  }
  const cachedReasoner: EvidenceReasoner = {
    source: reasoner.source,
    project(action) {
      const projected = projections.get(action.id);
      if (projected === undefined) {
        throw new Error(`evidence reasoner has no projection for action: ${action.id}`);
      }
      return projected;
    },
  };
  const strengthByAction = Object.fromEntries(
    validatedScenario.actions.map((action) => [action.id, projections.get(action.id)!.strength]),
  );
  const motivation =
    stableOptions.motivation === false
      ? null
      : consensusDecision(validatedScenario, strengthByAction, stableOptions.motivation ?? {});
  const decisions = Object.freeze(new DecisionEngine(
    cachedReasoner,
    motivation?.consensus_scores ?? {},
  ).rank(validatedScenario));
  const selected = decisions[0];
  if (selected === undefined) {
    throw new Error("GoalChainer produced no decision");
  }
  const tiedActionIds = Object.freeze(
    decisions
      .filter(
        (decision) =>
          Math.abs(decision.score - selected.score) <= SCORE_EQUIVALENCE_EPSILON,
      )
      .map((decision) => decision.actionId),
  );
  const selectionTied = tiedActionIds.length > 1;
  return validatedRun({
    scenario: validatedScenario,
    motivation,
    decisions,
    selected,
    tiedActionIds,
    selectionTied,
    automaticExecutionAllowed: selected.status === "recommended" && !selectionTied,
  });
}

/** Parse and evaluate one generic GoalChainer request. */
export function runGoalChainer(
  input: unknown,
  options: GoalChainerOptions = {},
): GoalChainerRun {
  const parsed: GoalChainerInput = parseGoalChainerInput(input);
  const contextualAction = parsed.scenario.actions.find(
    (action) => action.evidenceQuery !== "" || action.evidenceAtoms.length > 0,
  );
  if (contextualAction !== undefined) {
    throw new ContextualEvidenceRequiresReasonerError(
      `action ${contextualAction.id} declares contextual evidence. Use evaluateScenario with ContextualQueryEvidenceReasoner; the static JSON decision path cannot execute evidence queries`,
    );
  }
  return evaluateScenario(
    parsed.scenario,
    new StaticEvidenceReasoner(parsed.evidence),
    options,
  );
}

export function goalChainerRunToJson(run: GoalChainerRun): Record<string, unknown> {
  const validated = validatedRun(run);
  return {
    scenario: validated.scenario.title,
    scenario_declaration: {
      title: validated.scenario.title,
      goals: validated.scenario.goals.map((goal) => ({
        id: goal.id,
        owner: goal.owner,
        statement: goal.statement,
        weight: goal.weight,
        kind: goal.kind,
        required: goal.required,
      })),
      norms: validated.scenario.norms.map((norm) => ({
        id: norm.id,
        mode: norm.mode,
        target_action: norm.targetAction,
        reason: norm.reason,
        priority: norm.priority,
      })),
      actions: validated.scenario.actions.map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description,
        satisfies: [...action.satisfies],
        evidence_query: action.evidenceQuery,
        evidence_atoms: [...action.evidenceAtoms],
        default_strength: action.defaultStrength,
        default_confidence: action.defaultConfidence,
      })),
      notes: [...validated.scenario.notes],
    },
    selected: validated.selected.actionId,
    status: validated.selected.status,
    tied_actions: [...validated.tiedActionIds],
    selection_tied: validated.selectionTied,
    automatic_execution_allowed: validated.automaticExecutionAllowed,
    decisions: validated.decisions.map(decisionToDict),
    motivation: validated.motivation === null ? null : motivationSummary(validated.motivation),
    motivation_audit:
      validated.motivation === null
        ? null
        : {
            engine: validated.motivation.engine,
            individual_goals: [...validated.motivation.individual_goals],
            collective_goals: [...validated.motivation.collective_goals],
            candidates: validated.motivation.candidates.map((candidate) => ({
              id: candidate.id,
              corr: [...candidate.corr],
              risk: candidate.risk,
            })),
            goal_pull: { ...validated.motivation.goal_pull },
            subsystem_preference: { ...validated.motivation.subsystem_preference },
            consensus_scores: { ...validated.motivation.consensus_scores },
            consensus: validated.motivation.consensus,
          },
  };
}

export class GoalChainer {
  private readonly options: GoalChainerOptions;

  constructor(options: GoalChainerOptions = {}) {
    this.options = validatedOptions(options);
  }

  evaluate(input: unknown): GoalChainerRun {
    return runGoalChainer(input, this.options);
  }
}
