// Reconcile individual and collective goal preferences on @metta-ts.

import { add, div, mul, sub, type Term } from "@metta-ts/edsl";
import { flt, mabs, mettaDB, num, type MettaDB } from "./engine.js";
import { createGoalScenario, roundN, type GoalScenario } from "./models.js";
import { assertDenseArray, assertKnownKeys, assertPlainRecord, ownValue } from "./records.js";

export const MOTIVATION_ENGINE = "goal consensus on @metta-ts";

export interface MotivationOptions {
  /** Per-action, per-goal correlations in [-1, 1]. Declared goal coverage is
   * used when a correlation is omitted. */
  correlations?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Per-action risk in [0, 1]. The default is one minus evidence strength. */
  risks?: Readonly<Record<string, number>>;
}

interface Candidate {
  id: string;
  corr: number[];
  risk: number;
}

export interface MotivationResult {
  readonly engine: string;
  readonly individual_goals: readonly number[];
  readonly collective_goals: readonly number[];
  readonly candidates: readonly {
    readonly id: string;
    readonly corr: readonly number[];
    readonly risk: number;
  }[];
  readonly goal_pull: Readonly<{ individual: string | null; collective: string | null }>;
  readonly subsystem_preference: Readonly<{
    individual: string | null;
    collective: string | null;
  }>;
  readonly consensus_scores: Readonly<Record<string, number>>;
  readonly consensus: string;
}

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

function finiteDot(weights: readonly number[], correlations: readonly number[]): number {
  let level = weights.map((weight, index) => weight * correlations[index]!);
  if (level.length === 0) return 0;
  while (level.length > 1) {
    const next: number[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(level[index]! + (level[index + 1] ?? 0));
    }
    level = next;
  }
  const result = level[0]!;
  if (!Number.isFinite(result)) {
    throw new RangeError("motivation dot product must be finite");
  }
  return result;
}

function expectedBest(
  weights: readonly number[],
  candidates: MotivationResult["candidates"],
  withRisk: boolean,
): string {
  let best = candidates[0]!;
  let bestScore = finiteDot(weights, best.corr) - (withRisk ? best.risk : 0);
  for (const candidate of candidates.slice(1)) {
    const score = finiteDot(weights, candidate.corr) - (withRisk ? candidate.risk : 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best.id;
}

/** Validate and deeply freeze a motivation result before it enters a receipt. */
export function createMotivationResult(input: MotivationResult): MotivationResult {
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
  if (typeof input.engine !== "string" || input.engine.trim() === "") {
    throw new TypeError("motivation result engine must be a nonblank string");
  }
  const individual = finiteVector(input.individual_goals, "individual goal vector", [0, Infinity]);
  const collective = finiteVector(input.collective_goals, "collective goal vector", [0, Infinity]);
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
    if (typeof candidate.risk !== "number" || !Number.isFinite(candidate.risk) || candidate.risk < 0 || candidate.risk > 1) {
      throw new RangeError(`motivation candidates[${index}].risk must be within [0, 1]`);
    }
    return Object.freeze({ id: candidate.id, corr, risk: candidate.risk });
  }));
  assertPlainRecord(input.consensus_scores, "motivation consensus scores");
  const scoreIds = Object.keys(input.consensus_scores);
  const unknownScoreIds = scoreIds.filter((id) => !candidateIds.has(id));
  const missingScoreIds = [...candidateIds].filter((id) => !Object.hasOwn(input.consensus_scores, id));
  if (unknownScoreIds.length > 0 || missingScoreIds.length > 0) {
    throw new RangeError(
      `motivation consensus score IDs do not match candidates; unknown=${unknownScoreIds.join(",")}; missing=${missingScoreIds.join(",")}`,
    );
  }
  const providedConsensusScores = Object.freeze(Object.fromEntries(scoreIds.map((id) => {
    const score = input.consensus_scores[id];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new RangeError(`motivation consensus score for ${id} must be finite`);
    }
    return [id, score];
  })));
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
  const expectedGoalPull = {
    individual: individualAvailable ? expectedBest(individual, candidates, false) : null,
    collective: collectiveAvailable ? expectedBest(collective, candidates, false) : null,
  };
  const expectedSubsystemPreference = {
    individual: individualAvailable ? expectedBest(individual, candidates, true) : null,
    collective: collectiveAvailable ? expectedBest(collective, candidates, true) : null,
  };
  if (
    goalPull.individual !== expectedGoalPull.individual ||
    goalPull.collective !== expectedGoalPull.collective
  ) {
    throw new RangeError("motivation goal pull is inconsistent with candidates and goals");
  }
  if (
    subsystemPreference.individual !== expectedSubsystemPreference.individual ||
    subsystemPreference.collective !== expectedSubsystemPreference.collective
  ) {
    throw new RangeError("motivation subsystem preference is inconsistent with candidates and goals");
  }
  const expectedScoreEntries: Array<readonly [string, number]> = [];
  for (const candidate of candidates) {
    const individualScore = finiteDot(individual, candidate.corr) - candidate.risk;
    const collectiveScore = finiteDot(collective, candidate.corr) - candidate.risk;
    const expectedScore = individualAvailable && collectiveAvailable
      ? (individualScore + collectiveScore) / 2 -
        0.25 * Math.abs(individualScore - collectiveScore)
      : individualAvailable
        ? individualScore
        : collectiveScore;
    if (Math.abs(providedConsensusScores[candidate.id]! - expectedScore) > 1e-12) {
      throw new RangeError(`motivation consensus score is inconsistent for ${candidate.id}`);
    }
    expectedScoreEntries.push([candidate.id, expectedScore]);
  }
  const consensusScores = Object.freeze(Object.fromEntries(expectedScoreEntries));
  if (typeof input.consensus !== "string" || !candidateIds.has(input.consensus)) {
    throw new RangeError("motivation consensus must name a declared candidate");
  }
  const expectedConsensus = candidates.reduce((best, candidate) =>
    consensusScores[candidate.id]! > consensusScores[best.id]! ? candidate : best,
  ).id;
  if (input.consensus !== expectedConsensus) {
    throw new RangeError(`motivation consensus is inconsistent; expected ${expectedConsensus}`);
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

const dot = (goals: readonly number[], correlations: readonly number[]): Term => {
  let level: Term[] = goals.map((weight, index) =>
    mul(flt(weight), flt(correlations[index]!)),
  );
  if (level.length === 0) return 0;
  while (level.length > 1) {
    const next: Term[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1];
      next.push(right === undefined ? left : add(left, right));
    }
    level = next;
  }
  return level[0]!;
};

const scoreExpr = (goals: readonly number[], candidate: Candidate, withRisk: boolean): Term => {
  const score = dot(goals, candidate.corr);
  return withRisk ? sub(score, flt(candidate.risk)) : score;
};

function bestBy(
  db: MettaDB,
  goals: readonly number[],
  candidates: readonly Candidate[],
  withRisk: boolean,
): string {
  let best = candidates[0]!;
  let bestScore = num(db, scoreExpr(goals, best, withRisk));
  for (const candidate of candidates.slice(1)) {
    const score = num(db, scoreExpr(goals, candidate, withRisk));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best.id;
}

function finiteCorrelation(value: number, actionId: string, goalId: string): number {
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new RangeError(`correlation for ${actionId}/${goalId} must be finite and within [-1, 1]`);
  }
  return value;
}

function candidateRisk(
  actionId: string,
  defaultStrength: number,
  options: MotivationOptions,
): number {
  const risk = ownValue(options.risks, actionId) ?? roundN(1 - defaultStrength, 3);
  if (!Number.isFinite(risk) || risk < 0 || risk > 1) {
    throw new RangeError(`risk for ${actionId} must be finite and within [0, 1]`);
  }
  return risk;
}

/** Compute each subsystem preference and the disagreement-penalized consensus.
 *
 * The caller may provide negative or graded correlations. When omitted, an
 * action correlates 1 with each goal listed in `satisfies` and 0 otherwise.
 */
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

  const db = mettaDB();
  const individual = validatedScenario.goals.map((goal) =>
    goal.kind === "individual" ? goal.weight : 0,
  );
  const collective = validatedScenario.goals.map((goal) =>
    goal.kind === "collective" ? goal.weight : 0,
  );
  const hasIndividual = individual.some((weight) => weight > 0);
  const hasCollective = collective.some((weight) => weight > 0);

  const candidates: Candidate[] = validatedScenario.actions.map((action) => {
    const declared = new Set(action.satisfies);
    const actionCorrelations = ownValue(options.correlations, action.id);
    if (actionCorrelations !== undefined) {
      assertPlainRecord(actionCorrelations, `motivation correlations.${action.id}`);
    }
    const corr = validatedScenario.goals.map((goal) =>
      finiteCorrelation(
        ownValue(actionCorrelations, goal.id) ?? (declared.has(goal.id) ? 1 : 0),
        action.id,
        goal.id,
      ),
    );
    const strength = ownValue(strengthByAction, action.id) ?? action.defaultStrength;
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new RangeError(`evidence strength for ${action.id} must be within [0, 1]`);
    }
    return {
      id: action.id,
      corr,
      risk: candidateRisk(action.id, strength, options),
    };
  });

  const consensusScores = Object.fromEntries(candidates.map((candidate) => {
    const individualScore = scoreExpr(individual, candidate, true);
    const collectiveScore = scoreExpr(collective, candidate, true);
    const combined = hasIndividual && hasCollective
      ? sub(
          div(add(individualScore, collectiveScore), 2),
          mul(0.25, mabs(sub(individualScore, collectiveScore))),
        )
      : hasIndividual
        ? individualScore
        : collectiveScore;
    const score = num(db, combined);
    return [candidate.id, score] as const;
  }));

  const consensus = candidates.reduce((best, candidate) =>
    consensusScores[candidate.id]! > consensusScores[best.id]! ? candidate : best,
  ).id;

  return createMotivationResult({
    engine: MOTIVATION_ENGINE,
    individual_goals: individual,
    collective_goals: collective,
    candidates: candidates.map((candidate) => ({ ...candidate, corr: [...candidate.corr] })),
    goal_pull: {
      individual: hasIndividual ? bestBy(db, individual, candidates, false) : null,
      collective: hasCollective ? bestBy(db, collective, candidates, false) : null,
    },
    subsystem_preference: {
      individual: hasIndividual ? bestBy(db, individual, candidates, true) : null,
      collective: hasCollective ? bestBy(db, collective, candidates, true) : null,
    },
    consensus_scores: consensusScores,
    consensus,
  });
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
