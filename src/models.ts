// Data models for goal, norm, and evidence-aware action ranking.
// Ports goal_chainer/models.py. Internal fields are camelCase; the serialized
// report dicts (decisionToDict) use snake_case to match the Python JSON exactly.

export type GoalKind = "individual" | "collective";
export type NormMode = "oblige" | "permit" | "forbid";

export interface Goal {
  id: string;
  owner: string;
  statement: string;
  weight: number;
  kind: GoalKind;
  required: boolean;
}

export interface Norm {
  id: string;
  mode: NormMode;
  targetAction: string;
  reason: string;
  priority: number;
}

export interface CandidateAction {
  id: string;
  label: string;
  description: string;
  satisfies: readonly string[];
  evidenceQuery: string;
  evidenceAtoms: readonly string[];
  defaultStrength: number;
  defaultConfidence: number;
}

export interface EvidenceProjection {
  strength: number;
  confidence: number;
  source: string;
  projection: string | null;
  proofs: readonly string[];
  deontic: string;
  expectation: number;
}

export interface GoalScenario {
  title: string;
  goals: readonly Goal[];
  norms: readonly Norm[];
  actions: readonly CandidateAction[];
  notes: readonly string[];
}

export interface Decision {
  actionId: string;
  label: string;
  status: string;
  score: number;
  goalScore: number;
  individualScore: number;
  collectiveScore: number;
  evidence: EvidenceProjection;
  normStatus: string;
  normReasons: readonly string[];
  satisfiedGoals: readonly string[];
  missingRequiredGoals: readonly string[];
  warnings: readonly string[];
  metadata: Record<string, string>;
}

/** Round to 6 decimal places the way Python's round() does for these reports. */
export function round6(x: number): number {
  return roundN(x, 6);
}

/** Banker's-rounding-free round to n places, matching Python's round() for our values. */
export function roundN(x: number, n: number): number {
  const f = 10 ** n;
  return Math.round((x + Number.EPSILON) * f) / f;
}

/** Serialize a Decision to the snake_case dict shape goal_chainer emits. */
export function decisionToDict(d: Decision): Record<string, unknown> {
  return {
    action_id: d.actionId,
    label: d.label,
    status: d.status,
    score: round6(d.score),
    goal_score: round6(d.goalScore),
    individual_score: round6(d.individualScore),
    collective_score: round6(d.collectiveScore),
    evidence: {
      strength: round6(d.evidence.strength),
      confidence: round6(d.evidence.confidence),
      source: d.evidence.source,
      projection: d.evidence.projection,
      proofs: [...d.evidence.proofs],
    },
    norm_status: d.normStatus,
    norm_reasons: [...d.normReasons],
    satisfied_goals: [...d.satisfiedGoals],
    missing_required_goals: [...d.missingRequiredGoals],
    warnings: [...d.warnings],
    metadata: { ...d.metadata },
  };
}
