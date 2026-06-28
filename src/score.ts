// Rank actions by goal coverage, derived deontic status, and graded evidence.
// Ports goal_chainer/scoring.py + native_score.py + gc_score.pl.
//
// Two score paths, matching the original:
//  - native (when MetaMo consensus is supplied): the combined score and status run
//    on @metta-ts as the gc-score / gc-status MeTTa relations (gc_score.pl moved
//    onto the runtime), 0.54*motivation + 0.38*(strength*confidence) + bonus.
//  - offline (no consensus): the Python _combined_score, 0.42*goal + 0.38*evidence
//    + 0.12*fairness_floor + bonus, computed directly in TypeScript.

import { runMettaLines } from "./runtime.js";
import type { CandidateAction, Decision, EvidenceProjection, Goal, GoalScenario } from "./models.js";

const BLOCKING_STATUSES = new Set(["forbidden", "conflict"]);

// gc_score.pl, as MeTTa relations on @metta-ts.
const SCORE_ENGINE = `
(= (gc-score $d $s $c $m)
   (if (== $d forbidden) -1.0
   (if (== $d conflict) -1.0
   (+ (* 0.54 $m) (+ (* 0.38 (* $s $c)) (if (== $d obligated) 0.1 0.0))))))
(= (gc-status $d $score $missing)
   (if (== $d forbidden) blocked
   (if (== $d conflict) blocked
   (if (and (>= $score 0.72) (== $missing 0)) recommended
   (if (>= $score 0.5) candidate weak)))))
(= (gc-decide $d $s $c $m $missing)
   (decide (gc-score $d $s $c $m) (gc-status $d (gc-score $d $s $c $m) $missing)))
`;

const f6 = (x: number): string => x.toFixed(6);

interface NativeVerdict {
  score: number;
  status: string;
}

/** Compute (score, status) per action on @metta-ts via the gc-decide relation. */
function nativeDecide(
  rows: { deontic: string; strength: number; confidence: number; motivation: number; missing: number }[],
): NativeVerdict[] {
  const calls = rows
    .map((r) => `!(gc-decide ${r.deontic} ${f6(r.strength)} ${f6(r.confidence)} ${f6(r.motivation)} ${r.missing})`)
    .join("\n");
  const lines = runMettaLines(SCORE_ENGINE + calls + "\n");
  const verdicts: NativeVerdict[] = [];
  for (const line of lines) {
    const m = line.match(/\(decide (-?[0-9.eE+-]+) (blocked|recommended|candidate|weak)\)/);
    if (m) verdicts.push({ score: Number(m[1]), status: m[2]! });
  }
  if (verdicts.length !== rows.length) {
    throw new Error(`gc-decide returned ${verdicts.length} of ${rows.length}: ${lines.join(" ")}`);
  }
  return verdicts;
}

interface Reasoner {
  source: string;
  project(action: CandidateAction): EvidenceProjection;
}

export class DecisionEngine {
  constructor(
    private readonly reasoner: Reasoner,
    private readonly motivationScores: Record<string, number> = {},
  ) {}

  rank(scenario: GoalScenario): Decision[] {
    const motivation = normalizedMotivation(scenario, this.motivationScores);
    const native = this.nativeDecisions(scenario, motivation);
    const decisions = scenario.actions.map((action) =>
      this.evaluateAction(scenario, action, motivation[action.id], native[action.id]),
    );
    return decisions.sort((a, b) => b.score - a.score);
  }

  private nativeDecisions(
    scenario: GoalScenario,
    motivation: Record<string, number>,
  ): Record<string, NativeVerdict> {
    if (Object.keys(motivation).length === 0) return {};
    const rows = scenario.actions.map((action) => {
      const evidence = this.reasoner.project(action);
      const missing = missingRequiredGoals(scenario.goals, action.satisfies).length > 0 ? 1 : 0;
      return {
        deontic: evidence.deontic,
        strength: evidence.strength,
        confidence: evidence.confidence,
        motivation: motivation[action.id]!,
        missing,
      };
    });
    const verdicts = nativeDecide(rows);
    const out: Record<string, NativeVerdict> = {};
    scenario.actions.forEach((action, i) => (out[action.id] = verdicts[i]!));
    return out;
  }

  private evaluateAction(
    scenario: GoalScenario,
    action: CandidateAction,
    motivation: number | undefined,
    native: NativeVerdict | undefined,
  ): Decision {
    const evidence = this.reasoner.project(action);
    const goalScores = goalCoverage(scenario.goals, action.satisfies);
    const deontic = evidence.deontic;
    const missingRequired = missingRequiredGoals(scenario.goals, action.satisfies);

    const warnings: string[] = [];
    if (missingRequired.length > 0) warnings.push("missing required goals: " + missingRequired.join(", "));
    if (BLOCKING_STATUSES.has(deontic)) warnings.push(`native deontic status: ${deontic}`);

    let score: number;
    let status: string;
    if (native !== undefined) {
      score = native.score;
      status = native.status;
    } else {
      score = combinedScore(goalScores, evidence, deontic, motivation);
      status = decisionStatus(deontic, score, missingRequired);
    }

    const metadata: Record<string, string> = { deontic_expectation: f6(evidence.expectation) };
    if (motivation !== undefined) metadata.motivation = motivation.toFixed(4);
    if (native !== undefined) metadata.score_engine = "metta-ts";

    return {
      actionId: action.id,
      label: action.label,
      status,
      score,
      goalScore: goalScores.all,
      individualScore: goalScores.individual,
      collectiveScore: goalScores.collective,
      evidence,
      normStatus: deontic,
      normReasons: [`expectation=${evidence.expectation.toFixed(3)}`],
      satisfiedGoals: [...action.satisfies],
      missingRequiredGoals: missingRequired,
      warnings,
      metadata,
    };
  }
}

function normalizedMotivation(
  scenario: GoalScenario,
  motivationScores: Record<string, number>,
): Record<string, number> {
  const values = scenario.actions
    .filter((a) => a.id in motivationScores)
    .map((a) => motivationScores[a.id]!);
  if (values.length < scenario.actions.length || values.length === 0) return {};
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const out: Record<string, number> = {};
  for (const a of scenario.actions) {
    out[a.id] = span ? (motivationScores[a.id]! - low) / span : 1.0;
  }
  return out;
}

interface GoalScores {
  all: number;
  individual: number;
  collective: number;
}

function goalCoverage(goals: readonly Goal[], satisfied: readonly string[]): GoalScores {
  const satisfiedSet = new Set(satisfied);
  const individual = goals.filter((g) => g.kind === "individual");
  const collective = goals.filter((g) => g.kind === "collective");
  return {
    all: weightedCoverage(goals, satisfiedSet),
    individual: weightedCoverage(individual, satisfiedSet),
    collective: weightedCoverage(collective, satisfiedSet),
  };
}

function weightedCoverage(goals: readonly Goal[], satisfied: Set<string>): number {
  const total = goals.reduce((s, g) => s + g.weight, 0);
  if (total === 0) return 0.0;
  const covered = goals.filter((g) => satisfied.has(g.id)).reduce((s, g) => s + g.weight, 0);
  return covered / total;
}

function missingRequiredGoals(goals: readonly Goal[], satisfied: readonly string[]): string[] {
  const satisfiedSet = new Set(satisfied);
  return goals.filter((g) => g.required && !satisfiedSet.has(g.id)).map((g) => g.id);
}

function combinedScore(
  goalScores: GoalScores,
  evidence: EvidenceProjection,
  deontic: string,
  motivation: number | undefined,
): number {
  if (BLOCKING_STATUSES.has(deontic)) return -1.0;
  const deonticBonus = deontic === "obligated" ? 0.1 : 0.0;
  const evidenceScore = evidence.strength * evidence.confidence;
  if (motivation !== undefined) {
    return 0.54 * motivation + 0.38 * evidenceScore + deonticBonus;
  }
  const fairnessFloor = Math.min(goalScores.individual, goalScores.collective);
  return 0.42 * goalScores.all + 0.38 * evidenceScore + 0.12 * fairnessFloor + deonticBonus;
}

function decisionStatus(deontic: string, score: number, missingRequired: string[]): string {
  if (BLOCKING_STATUSES.has(deontic)) return "blocked";
  if (score >= 0.72 && missingRequired.length === 0) return "recommended";
  if (score >= 0.5) return "candidate";
  return "weak";
}
