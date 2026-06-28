// Truth-value kernels: the float arithmetic the reasoning engines call.
//
// These are the in-process TypeScript analogue of the registered SWI-Prolog /
// PeTTaChainer truth-value formulas. They are registered as @metta-ts grounded
// operations so the MeTTa reasoning programs can call them by name, exactly as
// the PeTTa programs called their Prolog kernels.

import { MeTTa, ValueAtom, type GroundedAtom, type Atom } from "@metta-ts/hyperon";

const num = (a: Atom): number => (a as GroundedAtom).jsValue<number>();

// ---- PLN (PeTTaChainer) ----------------------------------------------------

/** Modus-ponens deduction: Implication rule (rs,rc) applied to premise fact (fs,fc).
 * Source: PeTTaChainer TotalMpFormula with the (STV 0.2 0.2) NOT-premise fallback. */
export function deduce(
  rs: number,
  rc: number,
  fs: number,
  fc: number,
): [number, number] {
  const s = rs * fs + 0.2 * (1 - fs);
  const c = fs * Math.min(rc, fc) + (1 - fs) * Math.min(0.2, fc);
  return [s, c];
}

/** Count-space confidence -> evidence count, personality constant K = 800. */
const c2w = (c: number): number => (c * 800) / (1 - Math.min(c, 0.9999));

/** PLN revision (merge) of two beliefs about the same conclusion. Commutative. */
export function revise(
  [s1, c1]: [number, number],
  [s2, c2]: [number, number],
): [number, number] {
  const w1 = c2w(c1);
  const w2 = c2w(c2);
  const w = w1 + w2;
  return [(s1 * w1 + s2 * w2) / w, w / (w + 800)];
}

// ---- NAL <-> Subjective-Logic bridge --------------------------------------

/** PLN truth value (f,c) as a Subjective-Logic opinion (b,d,u,a), a=0.5.
 * b=cf, d=c(1-f), u=1-c. Expectation b + a*u recovers the NAL expectation. */
export function slOpinion(f: number, c: number): { b: number; d: number; u: number; a: number } {
  return { b: c * f, d: c * (1 - f), u: 1 - c, a: 0.5 };
}

/** NAL expectation of a belief: confidence*(strength - 0.5) + 0.5. */
export function nalExpectation(strength: number, confidence: number): number {
  return confidence * (strength - 0.5) + 0.5;
}

// ---- SNARS (Subjective-Logic NARS) ----------------------------------------

/** Map evidence (positive w+, negative w-) to an opinion, non-informative prior W=2. */
export function evidenceToOpinion(
  wPos: number,
  wNeg: number,
  a = 0.5,
): { b: number; d: number; u: number; a: number } {
  const total = wPos + wNeg + 2;
  return { b: wPos / total, d: wNeg / total, u: 2 / total, a };
}

/** SNARS chained deduction of two d=0 premises: b = b1*b2, u = 1 - b, a = 0.5. */
export function slDeduce(
  p1: { b: number; u: number; a: number },
  p2: { b: number; u: number; a: number },
): { b: number; d: number; u: number; a: number } {
  const b = p1.b * p2.b;
  return { b, d: 0, u: 1 - b, a: 0.5 };
}

/** Subjective-Logic projected expectation: b + a*u. */
export function slExpectation(o: { b: number; u: number; a: number }): number {
  return o.b + o.a * o.u;
}

// ---- registration ----------------------------------------------------------

/** Register the truth-value kernels as grounded ops on a MeTTa instance, so the
 * reasoning programs can call (pln-deduce ...), (pln-revise-s ...), etc. */
export function registerTruthOps(metta: MeTTa): void {
  metta.registerOperation("pln-deduce-s", (a: Atom[]) => [
    ValueAtom(deduce(num(a[0]!), num(a[1]!), num(a[2]!), num(a[3]!))[0]),
  ]);
  metta.registerOperation("pln-deduce-c", (a: Atom[]) => [
    ValueAtom(deduce(num(a[0]!), num(a[1]!), num(a[2]!), num(a[3]!))[1]),
  ]);
  metta.registerOperation("pln-revise-s", (a: Atom[]) => [
    ValueAtom(revise([num(a[0]!), num(a[1]!)], [num(a[2]!), num(a[3]!)])[0]),
  ]);
  metta.registerOperation("pln-revise-c", (a: Atom[]) => [
    ValueAtom(revise([num(a[0]!), num(a[1]!)], [num(a[2]!), num(a[3]!)])[1]),
  ]);
  metta.registerOperation("sl-expectation", (a: Atom[]) => [
    ValueAtom(slExpectation({ b: num(a[0]!), u: num(a[1]!), a: num(a[2]!) })),
  ]);
}
