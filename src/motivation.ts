// Individual vs collective goals as a MetaMo-style consensus on @metta-ts.
// Ports goal_chainer/motivation.py.
//
// The original ran MetaMo's consensusAction on PeTTa (and imported a Python
// helper, so it could not run on a pure-TS runtime). Here the same consensus runs
// on @metta-ts: each candidate action is an atom carrying its goal correlations
// and risk; a MeTTa rule folds the individual and collective subsystem scores
// through the grounded consensus kernel
//   consensus = (scoreI + scoreC)/2 - 0.25*|scoreI - scoreC|,  score = goals.corr - risk.
// The disagreement penalty is the principled fairness floor: an action one
// subsystem loves and the other hates is penalised.

import { MeTTa, ValueAtom, type GroundedAtom, type Atom } from "@metta-ts/hyperon";
import { runMettaLines } from "./runtime.js";
import { roundN } from "./models.js";
import type { GoalScenario } from "./models.js";

const ENGINE = "MetaMo consensusAction (OpenPsi/MAGUS) on @metta-ts";
const num = (a: Atom): number => (a as GroundedAtom).jsValue<number>();

// How each action correlates with (preserve_privacy, restore_service, coordinate_team).
const CORRELATIONS: Record<string, Record<string, number>> = {
  publish_raw_log: { preserve_privacy: -1.0, restore_service: 1.0, coordinate_team: 1.0 },
  publish_redacted_summary: { preserve_privacy: 1.0, restore_service: 0.9, coordinate_team: 0.7 },
  hold_external_update: { preserve_privacy: 1.0, restore_service: 0.0, coordinate_team: 0.0 },
};

const correlation = (actionId: string, goalId: string): number =>
  CORRELATIONS[actionId]?.[goalId] ?? 0.0;

interface Candidate {
  id: string;
  corr: number[];
  risk: number;
}

const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
const score = (goals: number[], c: Candidate, withRisk: boolean): number =>
  dot(goals, c.corr) - (withRisk ? c.risk : 0);
const best = (goals: number[], candidates: Candidate[], withRisk: boolean): string =>
  candidates.reduce((bestC, c) =>
    score(goals, c, withRisk) > score(goals, bestC, withRisk) ? c : bestC,
  ).id;

export interface MotivationResult {
  engine: string;
  individual_goals: number[];
  collective_goals: number[];
  candidates: { id: string; corr: number[]; risk: number }[];
  goal_pull: { individual: string; collective: string };
  subsystem_preference: { individual: string; collective: string };
  consensus_scores: Record<string, number>;
  consensus: string;
}

/** Run the individual+collective consensus over the scenario's actions, using
 * each action's PLN strength to derive its risk. */
export function consensusDecision(
  scenario: GoalScenario,
  strengthByAction: Record<string, number>,
): MotivationResult {
  const goals = scenario.goals;
  const individual = goals.map((g) => (g.kind === "individual" ? 1.0 : 0.0));
  const collective = goals.map((g) => (g.kind === "collective" ? 1.0 : 0.0));

  const candidates: Candidate[] = scenario.actions.map((action) => ({
    id: action.id,
    corr: goals.map((g) => correlation(action.id, g.id)),
    risk: roundN(1.0 - strengthByAction[action.id]!, 3),
  }));

  // The consensus kernel closes over the goal vectors; the MeTTa rule supplies
  // each candidate's correlations and risk.
  const register = (metta: MeTTa): void => {
    metta.registerOperation("mm-consensus", (a: Atom[]) => {
      const corr = [num(a[0]!), num(a[1]!), num(a[2]!)];
      const risk = num(a[3]!);
      const sI = dot(individual, corr) - risk;
      const sC = dot(collective, corr) - risk;
      return [ValueAtom((sI + sC) / 2 - 0.25 * Math.abs(sI - sC))];
    });
  };

  const candLines = candidates.map(
    (c) => `(cand ${c.id} ${c.corr[0]} ${c.corr[1]} ${c.corr[2]} ${c.risk})`,
  );
  const queries = candidates
    .map(
      (c) =>
        `!(match &self (cand ${c.id} $c1 $c2 $c3 $r) (cons ${c.id} (mm-consensus $c1 $c2 $c3 $r)))`,
    )
    .join("\n");
  const program = `${candLines.join("\n")}\n${queries}\n`;
  const lines = runMettaLines(program, register);

  const consensusScores: Record<string, number> = {};
  for (const line of lines) {
    const m = line.match(/\(cons (\S+) (-?[0-9.eE+-]+)\)/);
    if (m) consensusScores[m[1]!] = Number(m[2]);
  }
  for (const c of candidates) {
    if (!(c.id in consensusScores)) throw new Error(`MetaMo consensus returned no value for ${c.id}`);
  }
  const chosen = candidates.reduce((bestC, c) =>
    consensusScores[c.id]! > consensusScores[bestC.id]! ? c : bestC,
  ).id;

  return {
    engine: ENGINE,
    individual_goals: individual,
    collective_goals: collective,
    candidates: candidates.map((c) => ({ id: c.id, corr: c.corr, risk: c.risk })),
    goal_pull: {
      individual: best(individual, candidates, false),
      collective: best(collective, candidates, false),
    },
    subsystem_preference: {
      individual: best(individual, candidates, true),
      collective: best(collective, candidates, true),
    },
    consensus_scores: consensusScores,
    consensus: chosen,
  };
}

/** The compact motivation view both the decision and solve reports carry. */
export function motivationSummary(m: MotivationResult | null): Record<string, unknown> | null {
  if (m === null) return null;
  return {
    engine: m.engine,
    goal_pull: m.goal_pull,
    subsystem_preference: m.subsystem_preference,
    consensus: m.consensus,
  };
}
