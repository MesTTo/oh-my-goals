// Reconcile individual and collective goal preferences in oh-my-goals.metta.

import { isDeepStrictEqual } from "node:util";

import {
  mettaCall,
  mettaFloat,
  mettaOne,
  mettaString,
  mettaSymbol,
  mettaTuple,
  sharedGoalChainerMetta,
  type Term,
} from "./metta.js";
import { createGoalScenario, type GoalScenario } from "./models.js";
import { assertDenseArray, assertKnownKeys, assertPlainRecord, ownValue } from "./records.js";

export const MOTIVATION_ENGINE = "GoalChainer motivation in MeTTa TS";

export interface MotivationOptions {
  /** Per-action, per-goal correlations in [-1, 1]. Declared goal coverage is
   * used when a correlation is omitted. */
  correlations?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Per-action risk in [0, 1]. The default is one minus evidence strength,
   * rounded to three decimal places by oh-my-goals.metta. */
  risks?: Readonly<Record<string, number>>;
}

interface Candidate {
  readonly id: string;
  readonly corr: readonly number[];
  readonly risk: number;
}

export interface MotivationResult {
  readonly engine: string;
  readonly individual_goals: readonly number[];
  readonly collective_goals: readonly number[];
  readonly candidates: readonly Candidate[];
  readonly goal_pull: Readonly<{ individual: string | null; collective: string | null }>;
  readonly subsystem_preference: Readonly<{
    individual: string | null;
    collective: string | null;
  }>;
  readonly consensus_scores: Readonly<Record<string, number>>;
  readonly consensus: string;
}

const VALID_RESULTS = new WeakSet<object>();

function finiteVector(
  input: readonly number[],
  field: string,
  bounds?: readonly [number, number],
): readonly number[] {
  assertDenseArray(input, field);
  const copy = [...input];
  copy.forEach((value, index) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (bounds !== undefined && (value < bounds[0] || value > bounds[1]))
    ) {
      const range = bounds === undefined ? "finite" : `within [${bounds[0]}, ${bounds[1]}]`;
      throw new RangeError(`${field}[${index}] must be ${range}`);
    }
  });
  return Object.freeze(copy);
}

function preferenceRecord(
  input: Readonly<{ individual: string | null; collective: string | null }>,
  field: string,
  candidateIds: ReadonlySet<string>,
  individualAvailable: boolean,
  collectiveAvailable: boolean,
): Readonly<{ individual: string | null; collective: string | null }> {
  assertPlainRecord(input, field);
  assertKnownKeys(input, field, ["individual", "collective"]);
  for (const [kind, available] of [
    ["individual", individualAvailable],
    ["collective", collectiveAvailable],
  ] as const) {
    const value = input[kind];
    if (value !== null && (typeof value !== "string" || !candidateIds.has(value))) {
      throw new RangeError(`${field}.${kind} must be null or a declared candidate ID`);
    }
    if (available !== (value !== null)) {
      throw new RangeError(`${field}.${kind} does not match the available goal subsystem`);
    }
  }
  return Object.freeze({ individual: input.individual, collective: input.collective });
}

function snapshotMotivationResult(input: MotivationResult): MotivationResult {
  assertPlainRecord(input, "motivation result");
  assertKnownKeys(input, "motivation result", [
    "engine",
    "individual_goals",
    "collective_goals",
    "candidates",
    "goal_pull",
    "subsystem_preference",
    "consensus_scores",
    "consensus",
  ]);
  if (input.engine !== MOTIVATION_ENGINE) {
    throw new RangeError(`motivation result engine must be ${MOTIVATION_ENGINE}`);
  }
  const individual = finiteVector(input.individual_goals, "individual goal vector", [0, 1]);
  const collective = finiteVector(input.collective_goals, "collective goal vector", [0, 1]);
  if (individual.length !== collective.length) {
    throw new RangeError("motivation goal vectors must have equal length");
  }
  individual.forEach((weight, index) => {
    if (weight > 0 && collective[index]! > 0) {
      throw new RangeError(`motivation goal index ${index} belongs to both subsystems`);
    }
  });
  assertDenseArray(input.candidates, "motivation candidates");
  if (input.candidates.length === 0) {
    throw new RangeError("motivation result requires at least one candidate");
  }
  const candidateIds = new Set<string>();
  const candidates = Object.freeze(input.candidates.map((candidate, index) => {
    assertPlainRecord(candidate, `motivation candidates[${index}]`);
    assertKnownKeys(candidate, `motivation candidates[${index}]`, ["id", "corr", "risk"]);
    if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
      throw new TypeError(`motivation candidates[${index}].id must be a nonblank string`);
    }
    if (candidateIds.has(candidate.id)) {
      throw new RangeError(`duplicate motivation candidate ID: ${candidate.id}`);
    }
    candidateIds.add(candidate.id);
    const corr = finiteVector(candidate.corr, `motivation candidates[${index}].corr`, [-1, 1]);
    if (corr.length !== individual.length) {
      throw new RangeError(`motivation candidates[${index}].corr has the wrong goal count`);
    }
    if (
      typeof candidate.risk !== "number" ||
      !Number.isFinite(candidate.risk) ||
      candidate.risk < 0 ||
      candidate.risk > 1
    ) {
      throw new RangeError(`motivation candidates[${index}].risk must be within [0, 1]`);
    }
    return Object.freeze({ id: candidate.id, corr, risk: candidate.risk });
  }));
  const individualAvailable = individual.some((weight) => weight > 0);
  const collectiveAvailable = collective.some((weight) => weight > 0);
  if (!individualAvailable && !collectiveAvailable) {
    throw new RangeError("motivation result requires a positive goal subsystem");
  }
  const goalPull = preferenceRecord(
    input.goal_pull,
    "motivation goal pull",
    candidateIds,
    individualAvailable,
    collectiveAvailable,
  );
  const subsystemPreference = preferenceRecord(
    input.subsystem_preference,
    "motivation subsystem preference",
    candidateIds,
    individualAvailable,
    collectiveAvailable,
  );
  assertPlainRecord(input.consensus_scores, "motivation consensus scores");
  const scoreIds = Object.keys(input.consensus_scores);
  const unknownScoreIds = scoreIds.filter((id) => !candidateIds.has(id));
  const missingScoreIds = [...candidateIds].filter(
    (id) => !Object.hasOwn(input.consensus_scores, id),
  );
  if (unknownScoreIds.length > 0 || missingScoreIds.length > 0) {
    throw new RangeError(
      `motivation consensus score IDs do not match candidates; unknown=${unknownScoreIds.join(",")}; missing=${missingScoreIds.join(",")}`,
    );
  }
  const consensusScores = Object.freeze(Object.fromEntries(scoreIds.map((id) => {
    const score = input.consensus_scores[id];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new RangeError(`motivation consensus score for ${id} must be finite`);
    }
    return [id, score];
  })));
  if (typeof input.consensus !== "string" || !candidateIds.has(input.consensus)) {
    throw new RangeError("motivation consensus must name a declared candidate");
  }
  return Object.freeze({
    engine: input.engine,
    individual_goals: individual,
    collective_goals: collective,
    candidates,
    goal_pull: goalPull,
    subsystem_preference: subsystemPreference,
    consensus_scores: consensusScores,
    consensus: input.consensus,
  });
}

function candidateTerm(candidate: Candidate): Term {
  return mettaCall(
    "Candidate",
    candidate.id,
    mettaTuple(candidate.corr.map(mettaFloat)),
    mettaFloat(candidate.risk),
  );
}

function goalTerm(goal: GoalScenario["goals"][number]): Term {
  return mettaCall(
    "Goal",
    mettaString(goal.id),
    mettaSymbol(goal.kind),
    mettaFloat(goal.weight),
    goal.required,
  );
}

function nativeCandidate(value: unknown, index: number, goalCount: number): Candidate {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== "Candidate" ||
    typeof value[1] !== "string" ||
    !Array.isArray(value[2]) ||
    typeof value[3] !== "number" ||
    !Number.isFinite(value[3]) ||
    value[3] < 0 ||
    value[3] > 1
  ) {
    throw new Error(`oh-my-goals.metta returned an invalid motivation candidate at index ${index}`);
  }
  const corr = finiteVector(value[2] as number[], `native motivation candidate ${index}`, [-1, 1]);
  if (corr.length !== goalCount) {
    throw new Error(`oh-my-goals.metta returned the wrong correlation count at index ${index}`);
  }
  return Object.freeze({ id: value[1], corr, risk: value[3] });
}

function optionalCandidate(value: unknown, path: string): string | null {
  if (Array.isArray(value) && value.length === 1 && value[0] === "None") return null;
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === "Some" &&
    typeof value[1] === "string"
  ) {
    return value[1];
  }
  throw new Error(`oh-my-goals.metta returned an invalid ${path}`);
}

function decodeMotivation(
  value: unknown,
  individual: readonly number[],
  collective: readonly number[],
  candidates: readonly Candidate[],
): MotivationResult {
  if (!Array.isArray(value) || value.length !== 7 || value[0] !== "MotivationResult") {
    throw new Error("oh-my-goals.metta returned an invalid motivation result");
  }
  const individualPull = optionalCandidate(value[1], "individual goal pull");
  const collectivePull = optionalCandidate(value[2], "collective goal pull");
  const individualPreference = optionalCandidate(value[3], "individual preference");
  const collectivePreference = optionalCandidate(value[4], "collective preference");
  if (!Array.isArray(value[5])) {
    throw new Error("oh-my-goals.metta returned invalid motivation consensus scores");
  }
  const consensusScores: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const row of value[5]) {
    if (
      !Array.isArray(row) ||
      row.length !== 3 ||
      row[0] !== "ConsensusScore" ||
      typeof row[1] !== "string" ||
      typeof row[2] !== "number" ||
      !Number.isFinite(row[2])
    ) {
      throw new Error("oh-my-goals.metta returned an invalid motivation score row");
    }
    consensusScores[row[1]] = row[2];
  }
  if (typeof value[6] !== "string") {
    throw new Error("oh-my-goals.metta returned an invalid motivation consensus action");
  }
  const result = snapshotMotivationResult({
    engine: MOTIVATION_ENGINE,
    individual_goals: individual,
    collective_goals: collective,
    candidates,
    goal_pull: { individual: individualPull, collective: collectivePull },
    subsystem_preference: {
      individual: individualPreference,
      collective: collectivePreference,
    },
    consensus_scores: consensusScores,
    consensus: value[6],
  });
  VALID_RESULTS.add(result);
  return result;
}

function nativeMotivation(
  individual: readonly number[],
  collective: readonly number[],
  candidates: readonly Candidate[],
): MotivationResult {
  const individualTerm = mettaTuple(individual.map(mettaFloat));
  const collectiveTerm = mettaTuple(collective.map(mettaFloat));
  const value = mettaOne(
    sharedGoalChainerMetta(),
    "gc-motivation-consensus",
    individualTerm,
    collectiveTerm,
    mettaTuple(candidates.map(candidateTerm)),
  );
  return decodeMotivation(value, individual, collective, candidates);
}

/** Validate and deeply freeze a motivation result through the native relation. */
export function createMotivationResult(input: MotivationResult): MotivationResult {
  if (input !== null && typeof input === "object" && VALID_RESULTS.has(input)) return input;
  const supplied = snapshotMotivationResult(input);
  const expected = nativeMotivation(
    supplied.individual_goals,
    supplied.collective_goals,
    supplied.candidates,
  );
  if (!isDeepStrictEqual(supplied, expected)) {
    throw new RangeError("motivation result is inconsistent with oh-my-goals.metta");
  }
  VALID_RESULTS.add(supplied);
  return supplied;
}

function finiteCorrelation(value: number, actionId: string, goalId: string): number {
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new RangeError(`correlation for ${actionId}/${goalId} must be finite and within [-1, 1]`);
  }
  return value;
}

/** Compute subsystem preferences and disagreement-penalized consensus in MeTTa. */
export function consensusDecision(
  scenario: GoalScenario,
  strengthByAction: Readonly<Record<string, number>> = {},
  options: MotivationOptions = {},
): MotivationResult {
  assertPlainRecord(strengthByAction, "evidence strengths");
  assertPlainRecord(options, "motivation options");
  assertKnownKeys(options, "motivation options", ["correlations", "risks"]);
  if (options.correlations !== undefined) {
    assertPlainRecord(options.correlations, "motivation correlations");
  }
  if (options.risks !== undefined) assertPlainRecord(options.risks, "motivation risks");
  const validatedScenario = createGoalScenario(scenario);
  const actionIds = new Set(validatedScenario.actions.map((action) => action.id));
  const goalIds = new Set(validatedScenario.goals.map((goal) => goal.id));
  for (const [actionId, strength] of Object.entries(strengthByAction)) {
    if (!actionIds.has(actionId)) {
      throw new RangeError(`evidence strengths reference unknown action ID: ${actionId}`);
    }
    if (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new RangeError(`evidence strength for ${actionId} must be within [0, 1]`);
    }
  }
  for (const [actionId, risk] of Object.entries(options.risks ?? {})) {
    if (!actionIds.has(actionId)) {
      throw new RangeError(`motivation risks reference unknown action ID: ${actionId}`);
    }
    if (typeof risk !== "number" || !Number.isFinite(risk) || risk < 0 || risk > 1) {
      throw new RangeError(`risk for ${actionId} must be finite and within [0, 1]`);
    }
  }
  for (const [actionId, correlations] of Object.entries(options.correlations ?? {})) {
    if (!actionIds.has(actionId)) {
      throw new RangeError(`motivation correlations reference unknown action ID: ${actionId}`);
    }
    assertPlainRecord(correlations, `motivation correlations.${actionId}`);
    for (const [goalId, correlation] of Object.entries(correlations)) {
      if (!goalIds.has(goalId)) {
        throw new RangeError(
          `motivation correlations.${actionId} references unknown goal ID: ${goalId}`,
        );
      }
      finiteCorrelation(correlation as number, actionId, goalId);
    }
  }

  const actions = validatedScenario.actions.map((action) => {
    const satisfied = new Set(action.satisfies);
    const actionCorrelations = ownValue(options.correlations, action.id);
    if (actionCorrelations !== undefined) {
      assertPlainRecord(actionCorrelations, `motivation correlations.${action.id}`);
    }
    const correlationSpecs = validatedScenario.goals.map((goal) => {
      const explicit = ownValue(actionCorrelations, goal.id);
      return explicit === undefined
        ? mettaCall("DefaultCorrelation", satisfied.has(goal.id))
        : mettaCall("ExplicitCorrelation", mettaFloat(explicit));
    });
    const strength = ownValue(strengthByAction, action.id) ?? action.defaultStrength;
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new RangeError(`evidence strength for ${action.id} must be within [0, 1]`);
    }
    const explicitRisk = ownValue(options.risks, action.id);
    const risk = explicitRisk === undefined
      ? mettaCall("DefaultRisk", mettaFloat(strength))
      : mettaCall("ExplicitRisk", mettaFloat(explicitRisk));
    return mettaCall(
      "MotivationAction",
      mettaString(action.id),
      mettaTuple(correlationSpecs),
      risk,
    );
  });
  const goals = mettaTuple(validatedScenario.goals.map(goalTerm));
  const groups = sharedGoalChainerMetta().evalJsMany([
    mettaCall("gc-motivation-mask", mettaSymbol("individual"), goals),
    mettaCall("gc-motivation-mask", mettaSymbol("collective"), goals),
    ...actions.map((action) => mettaCall("gc-motivation-candidate", action)),
  ]);
  if (groups.some((group) => group.length !== 1)) {
    throw new Error("oh-my-goals.metta returned a non-deterministic motivation projection");
  }
  const individualValue = groups[0]![0];
  const collectiveValue = groups[1]![0];
  if (!Array.isArray(individualValue) || !Array.isArray(collectiveValue)) {
    throw new Error("oh-my-goals.metta returned invalid motivation goal masks");
  }
  const individual = finiteVector(individualValue as number[], "native individual goals", [0, 1]);
  const collective = finiteVector(collectiveValue as number[], "native collective goals", [0, 1]);
  if (
    individual.length !== validatedScenario.goals.length ||
    collective.length !== validatedScenario.goals.length
  ) {
    throw new Error("oh-my-goals.metta returned invalid motivation scenario dimensions");
  }
  const candidates = groups.slice(2).map((group, index) =>
    nativeCandidate(group[0], index, validatedScenario.goals.length)
  );
  return nativeMotivation(individual, collective, candidates);
}

export function motivationSummary(result: MotivationResult): Record<string, unknown> {
  const validated = createMotivationResult(result);
  return {
    engine: validated.engine,
    goal_pull: validated.goal_pull,
    subsystem_preference: validated.subsystem_preference,
    consensus: validated.consensus,
  };
}
