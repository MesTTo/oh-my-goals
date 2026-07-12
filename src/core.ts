// Generic GoalChainer orchestration over caller-supplied structured input.

import { isDeepStrictEqual } from "node:util";

import { NORM_STATUSES, type NormStatus } from "./deontic.js";
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
  type Decision,
  type EvidenceProjection,
  type GoalScenario,
} from "./models.js";
import { StaticEvidenceReasoner } from "./reasoner.js";
import {
  DecisionEngine,
  snapshotEvidenceReasoner,
  type EvidenceReasoner,
} from "./score.js";
import { assertDenseArray, assertKnownKeys, assertPlainRecord, ownValue } from "./records.js";

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

const VALID_RUNS = new WeakSet<object>();

function trustRun(run: GoalChainerRun): GoalChainerRun {
  const frozen = Object.freeze(run);
  VALID_RUNS.add(frozen);
  return frozen;
}

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

function validateMotivationScenario(
  scenario: GoalScenario,
  motivation: MotivationResult | null,
): void {
  if (motivation === null) return;
  if (motivation.engine !== MOTIVATION_ENGINE) {
    throw new RangeError(`GoalChainer run motivation engine must be ${MOTIVATION_ENGINE}`);
  }
  const expectedIndividual = scenario.goals.map((goal) =>
    goal.kind === "individual" ? 1 : 0,
  );
  const expectedCollective = scenario.goals.map((goal) =>
    goal.kind === "collective" ? 1 : 0,
  );
  if (
    !sameStrings(
      motivation.candidates.map((candidate) => candidate.id),
      scenario.actions.map((action) => action.id),
    ) ||
    !isDeepStrictEqual(motivation.individual_goals, expectedIndividual) ||
    !isDeepStrictEqual(motivation.collective_goals, expectedCollective)
  ) {
    throw new RangeError("GoalChainer run motivation does not match the scenario declaration");
  }
}

function suppliedReasoner(
  scenario: GoalScenario,
  decisions: readonly Decision[],
): EvidenceReasoner {
  const projections = new Map<string, EvidenceProjection>();
  let source: string | undefined;
  decisions.forEach((decision) => {
    const reasonerSource = ownValue(decision.metadata, "reasoner_source");
    const reasonerStatus = ownValue(decision.metadata, "reasoner_deontic");
    if (typeof reasonerSource !== "string" || reasonerSource.trim() === "") {
      throw new RangeError(`GoalChainer run has invalid reasoner source: ${decision.actionId}`);
    }
    if (
      typeof reasonerStatus !== "string" ||
      !NORM_STATUSES.includes(reasonerStatus as NormStatus)
    ) {
      throw new RangeError(`GoalChainer run has invalid reasoner deontic metadata: ${decision.actionId}`);
    }
    if (source !== undefined && source !== reasonerSource) {
      throw new RangeError("GoalChainer run decisions disagree on the reasoner source");
    }
    source = reasonerSource;
    projections.set(decision.actionId, createEvidenceProjection({
      ...decision.evidence,
      deontic: reasonerStatus as NormStatus,
    }));
  });
  if (source === undefined) throw new RangeError("GoalChainer run contains no reasoner source");
  return {
    source,
    project(action) {
      const projection = projections.get(action.id);
      if (projection === undefined) {
        throw new RangeError(`GoalChainer run has no evidence for action: ${action.id}`);
      }
      return projection;
    },
  };
}

function validatedRun(run: GoalChainerRun): GoalChainerRun {
  if (run !== null && typeof run === "object" && VALID_RUNS.has(run)) return run;
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
  validateMotivationScenario(scenario, motivation);
  assertDenseArray(run.decisions, "GoalChainer run decisions");
  const suppliedDecisions = Object.freeze(run.decisions.map((decision) => createDecision(decision)));
  if (suppliedDecisions.length !== scenario.actions.length) {
    throw new RangeError("GoalChainer run must contain one decision per declared action");
  }
  const decisionIds = new Set<string>();
  suppliedDecisions.forEach((decision) => {
    if (decisionIds.has(decision.actionId)) {
      throw new RangeError(`duplicate GoalChainer run decision: ${decision.actionId}`);
    }
    decisionIds.add(decision.actionId);
  });
  const reasoner = suppliedReasoner(scenario, suppliedDecisions);
  const canonical = new DecisionEngine(
    reasoner,
    motivation?.consensus_scores ?? {},
  ).rankWithReceipt(scenario);
  if (
    suppliedDecisions.length !== canonical.decisions.length ||
    suppliedDecisions.some(
      (decision, index) => !isDeepStrictEqual(decision, canonical.decisions[index]),
    )
  ) {
    throw new RangeError("GoalChainer run decisions disagree with oh-my-goals.metta");
  }
  const suppliedSelected = createDecision(run.selected);
  if (!isDeepStrictEqual(suppliedSelected, canonical.decisions[0])) {
    throw new RangeError("GoalChainer run selected decision must equal the first ranked decision");
  }
  assertDenseArray(run.tiedActionIds, "GoalChainer run tied action IDs");
  run.tiedActionIds.forEach((actionId, index) => {
    if (typeof actionId !== "string") {
      throw new TypeError(`GoalChainer run tied action IDs[${index}] must be a string`);
    }
  });
  if (!sameStrings(run.tiedActionIds, canonical.tiedActionIds)) {
    throw new RangeError("GoalChainer run tied action IDs disagree with oh-my-goals.metta");
  }
  const selectionTied = canonical.tiedActionIds.length > 1;
  if (run.selectionTied !== selectionTied) {
    throw new RangeError("GoalChainer run selectionTied disagrees with oh-my-goals.metta");
  }
  if (run.automaticExecutionAllowed !== canonical.automaticExecutionAllowed) {
    throw new RangeError(
      "GoalChainer run automaticExecutionAllowed disagrees with oh-my-goals.metta",
    );
  }
  return trustRun({
    scenario,
    motivation,
    decisions: canonical.decisions,
    selected: canonical.decisions[0]!,
    tiedActionIds: canonical.tiedActionIds,
    selectionTied,
    automaticExecutionAllowed: canonical.automaticExecutionAllowed,
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
  const stableReasoner = snapshotEvidenceReasoner(reasoner);
  const projections = new Map<string, EvidenceProjection>();
  for (const action of validatedScenario.actions) {
    projections.set(action.id, createEvidenceProjection(stableReasoner.project(action)));
  }
  const cachedReasoner: EvidenceReasoner = {
    source: stableReasoner.source,
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
  const motivation = stableOptions.motivation === false
    ? null
    : consensusDecision(validatedScenario, strengthByAction, stableOptions.motivation ?? {});
  const ranking = new DecisionEngine(
    cachedReasoner,
    motivation?.consensus_scores ?? {},
  ).rankWithReceipt(validatedScenario);
  const selected = ranking.decisions[0];
  if (selected === undefined) throw new Error("GoalChainer produced no decision");
  return trustRun({
    scenario: validatedScenario,
    motivation,
    decisions: ranking.decisions,
    selected,
    tiedActionIds: ranking.tiedActionIds,
    selectionTied: ranking.tiedActionIds.length > 1,
    automaticExecutionAllowed: ranking.automaticExecutionAllowed,
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
    motivation_audit: validated.motivation === null
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
