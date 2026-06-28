// Action evidence from the deontic verdict + the PLN belief, on @metta-ts.
// Ports goal_chainer/metta_reasoner.py.
//
// Combines two reasoning results: deriveDeontic answers forbidden/obligated/
// permitted (defeasible + deontic), and gradeBeliefs grades how strongly each
// action is believed acceptable (PLN). Both run on @metta-ts. The rows here are
// what the DecisionEngine projects each action onto.

import { deriveDeontic, ACTION_ORDER } from "./deontic.js";
import { gradeBeliefs, type Belief } from "./pln.js";
import { nalExpectation, slOpinion } from "./truth.js";
import { round6, roundN, type CandidateAction, type EvidenceProjection } from "./models.js";
import { evidenceToDict, type IncidentEvidence } from "./evidence.js";

export const NATIVE_REASONER_SOURCE = "omega-core-metta-ts-lib-deontic-pln";

export interface ActionEvidenceRow {
  action_id: string;
  deontic: string;
  expectation: number;
  strength: number;
  confidence: number;
  opinion: { b: number; d: number; u: number; a: number };
  projection: string;
  proofs: string[];
}

const round4 = (x: number): number => roundN(x, 4);
const fixed4 = (x: number): string => x.toFixed(4);

function slOpinionRounded(f: number, c: number): { b: number; d: number; u: number; a: number } {
  const o = slOpinion(f, c);
  return { b: round4(o.b), d: round4(o.d), u: round4(o.u), a: 0.5 };
}

function actionRows(
  statusByAction: Record<string, string>,
  beliefs: Record<string, Belief>,
): ActionEvidenceRow[] {
  return ACTION_ORDER.map((actionId) => {
    const status = statusByAction[actionId] ?? "unregulated";
    const belief = beliefs[actionId]!;
    return {
      action_id: actionId,
      deontic: status,
      expectation: round6(nalExpectation(belief.strength, belief.confidence)),
      strength: round6(belief.strength),
      confidence: round6(belief.confidence),
      opinion: slOpinionRounded(belief.strength, belief.confidence),
      projection: `(Acceptable ${actionId}) (STV ${fixed4(belief.strength)} ${fixed4(belief.confidence)})`,
      proofs: [
        `deontic: lib_deontic derived ${status} for ${actionId}`,
        `belief: ${belief.proof}`,
      ],
    };
  });
}

export interface HyperbaseReasonResult {
  source: string;
  engine: string;
  execution: Record<string, string>;
  input: string;
  evidence: Record<string, unknown>;
  deontic_theory: string;
  deontic_conclusions: string;
  chainer_program: string;
  raw_outputs: string[];
  action_evidence: ActionEvidenceRow[];
}

/** Run the deontic engine and PLN over request-derived premises, on @metta-ts. */
export function reasonOverHyperbase(evidence: IncidentEvidence): HyperbaseReasonResult {
  const deontic = deriveDeontic(evidence);
  const { beliefs, program, rawOutputs } = gradeBeliefs(evidence);
  return {
    source: NATIVE_REASONER_SOURCE,
    engine: "lib_deontic + PLN",
    execution: {
      mode: "metta-ts",
      runtime: "@metta-ts",
      deontic_source: "OmegaClaw-Core lib_deontic (defeasible + SDL), reimplemented on @metta-ts",
      belief_source: "PLN contextual query on @metta-ts",
    },
    input: "evidence read from the request",
    evidence: evidenceToDict(evidence),
    deontic_theory: deontic.theory,
    deontic_conclusions: deontic.conclusions,
    chainer_program: program,
    raw_outputs: rawOutputs,
    action_evidence: actionRows(deontic.statusByAction, beliefs),
  };
}

/** Expose native conclusions as GoalChainer action evidence, like the Python class. */
export class HyperBaseMettaReasoner {
  readonly source = NATIVE_REASONER_SOURCE;
  private readonly byId: Record<string, ActionEvidenceRow>;

  constructor(result: HyperbaseReasonResult) {
    this.byId = {};
    for (const row of result.action_evidence) this.byId[row.action_id] = row;
  }

  project(action: CandidateAction): EvidenceProjection {
    const row = this.byId[action.id];
    if (!row) throw new Error(`reasoner returned no evidence for ${action.id}`);
    return {
      strength: row.strength,
      confidence: row.confidence,
      source: this.source,
      projection: row.projection,
      proofs: row.proofs,
      deontic: row.deontic,
      expectation: row.expectation,
    };
  }
}
