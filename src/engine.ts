// Shared helpers for driving the @metta-ts engine through the typed eDSL.
// The reasoning math runs on the interpreter; these are the small pieces the
// engines reuse (min/abs as MeTTa, and reading a single numeric result).

import { If, mettaDB, MettaDB, le, ge, sub, type Term } from "@metta-ts/edsl";
import { GroundedAtom, type Atom } from "@metta-ts/hyperon";
import { gfloat } from "@metta-ts/core";

/** A Float-typed atom. ValueAtom grounds an integer-valued number as an Int, and
 * the engine's `/` floors two Ints, so a float operand is needed for true division. */
export const flt = (n: number): Atom => {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TypeError("float atom value must be a finite number");
  }
  return new GroundedAtom(gfloat(n));
};

/** (min a b) on the engine: there is no stdlib min, so branch on <=. */
export const mmin = (a: Term, b: Term): Term => If(le(a, b), a, b);

/** (abs x) on the engine. */
export const mabs = (x: Term): Term => If(ge(x, 0), x, sub(0, x));

/** Add any number of terms without relying on the JavaScript argument limit. */
export function addTerms(db: MettaDB, terms: Iterable<Term>): void {
  for (const term of terms) db.add(term);
}

/** Evaluate a term to a single number on the engine. */
export function num(db: MettaDB, term: Term): number {
  const values = db.evalJs(term);
  if (values.length !== 1 || typeof values[0] !== "number" || !Number.isFinite(values[0])) {
    throw new Error(
      `@metta-ts returned an invalid finite number: ${values.map(String).join(", ")}`,
    );
  }
  return values[0];
}

export { mettaDB, type MettaDB };
