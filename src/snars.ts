// Assess a GoalChainer claim with a Subjective-Logic NARS deduction on @metta-ts.
// Ports goal_chainer/snars_query.py (the derive_incident path).
//
// The original asserted beliefs into the user's SNARS kernel on PeTTa (believe!,
// ask!, why!). Here the same subjective-logic deduction runs on @metta-ts: each
// premise is a belief from evidence (9 positive, 0 negative -> opinion via the
// W=2 non-informative prior), and the two premises chain through a deduction that
// calls the grounded SL kernels. The numbers are identical to the SNARS run:
// premise opinions (0.818182, 0, 0.181818, 0.5), derived (0.669421, 0, 0.330579,
// 0.5), projected expectation 0.834711.

import { MeTTa, ValueAtom, type GroundedAtom, type Atom } from "@metta-ts/hyperon";
import { runMettaLines } from "./runtime.js";
import { evidenceToOpinion } from "./truth.js";
import { extractEvidence } from "./evidence.js";
import { round6 } from "./models.js";

const num = (a: Atom): number => (a as GroundedAtom).jsValue<number>();

const ENGINE = "SNARS deduction (Subjective-Logic NARS) on @metta-ts";

interface Opinion {
  b: number;
  d: number;
  u: number;
  a: number;
}

const roundOpinion = (o: Opinion): Opinion => ({
  b: round6(o.b),
  d: round6(o.d),
  u: round6(o.u),
  a: round6(o.a),
});

// Render a float the way Python's repr does (so 0 -> "0.0"), for the why receipt.
function pyFloat(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

function opinionStr(o: Opinion): string {
  return `(Opinion ${pyFloat(o.b)} ${pyFloat(o.d)} ${pyFloat(o.u)} ${pyFloat(o.a)})`;
}

// The SL deduction kernels, registered so the MeTTa chain can call them.
function registerSlOps(metta: MeTTa): void {
  metta.registerOperation("sl-ded-b", (a: Atom[]) => [ValueAtom(num(a[0]!) * num(a[1]!))]);
  metta.registerOperation("sl-ded-u", (a: Atom[]) => [ValueAtom(1 - num(a[0]!) * num(a[1]!))]);
  metta.registerOperation("sl-ded-e", (a: Atom[]) => {
    const b = num(a[0]!) * num(a[1]!);
    return [ValueAtom(b + 0.5 * (1 - b))];
  });
}

/** Believe `subject is middle` and `middle is conclusion`, run SL forward
 * deduction on @metta-ts, and return the derived opinion + proof. */
export function derive(
  subject: string,
  middle: string,
  conclusion: string,
): {
  claim: string;
  engine: string;
  derived: boolean;
  opinion: Opinion;
  expectation: number;
  proof: { rule: string; premises: { statement: string; opinion: Opinion }[] };
  why: string;
} {
  const p1 = evidenceToOpinion(9.0, 0.0);
  const p2 = evidenceToOpinion(9.0, 0.0);
  // The deduction chains the two premises through the grounded SL kernels.
  const program = `
(premise p1 (op ${p1.b} ${p1.u}))
(premise p2 (op ${p2.b} ${p2.u}))
(= (derive)
   (match &self (premise p1 (op $b1 $u1))
     (match &self (premise p2 (op $b2 $u2))
       (derived (sl-ded-b $b1 $b2) (sl-ded-u $b1 $b2) (sl-ded-e $b1 $b2)))))
!(derive)
`;
  const lines = runMettaLines(program, registerSlOps);
  const m = lines.join(" ").match(/\(derived (-?[0-9.eE+-]+) (-?[0-9.eE+-]+) (-?[0-9.eE+-]+)\)/);
  if (!m) throw new Error(`SNARS deduction returned no result: ${lines.join(" ")}`);
  const opinion: Opinion = { b: Number(m[1]), d: 0, u: Number(m[2]), a: 0.5 };
  const expectation = Number(m[3]);

  const s1 = `${subject} is ${middle}.`;
  const s2 = `${middle} is ${conclusion}.`;
  const why =
    `(because ded ((premise "${s1}" ${opinionStr(p1)}) ` +
    `(premise "${s2}" ${opinionStr(p2)})) ())`;
  return {
    claim: `${subject} is ${conclusion}`,
    engine: ENGINE,
    derived: true,
    opinion: roundOpinion(opinion),
    expectation: round6(expectation),
    proof: {
      rule: "deduction",
      premises: [
        { statement: s1, opinion: roundOpinion(p1) },
        { statement: s2, opinion: roundOpinion(p2) },
      ],
    },
    why,
  };
}

/** Ground the deduction in the request itself, as derive_incident does. */
export function deriveIncident(request: string): Record<string, unknown> {
  const evidence = extractEvidence(request);
  const grounding = evidence.riskGrounding || "the incident request";
  const result = derive("publish_raw_log", "risky_action", "forbidden_action");
  return {
    ...result,
    grounding,
    privacy_at_stake: evidence.sensitiveCategories.length > 0 && !evidence.publicDeclared,
    evidence_provenance: evidence.provenance,
  };
}
