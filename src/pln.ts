// PLN truth-value deduction and revision on @metta-ts.

import {
  If,
  Match,
  add,
  div,
  e,
  eq,
  mul,
  names,
  sub,
  vars,
  type Term,
} from "@metta-ts/edsl";
import { addTerms, mettaDB, mmin } from "./engine.js";
import {
  assertDenseArray,
  assertKnownKeys,
  assertPlainRecord,
  finiteProbability,
} from "./records.js";

export interface Belief {
  readonly strength: number;
  readonly confidence: number;
  readonly proof: string;
}

export interface PlnRule {
  readonly id: string;
  readonly predicate: string;
  readonly strength: number;
  readonly confidence: number;
}

export interface PlnFact {
  readonly id: string;
  readonly actionId: string;
  readonly predicate: string;
  readonly strength: number;
  readonly confidence: number;
}

export interface PlnProgram {
  actionIds: readonly string[];
  rules: readonly PlnRule[];
  facts: readonly PlnFact[];
}

export interface PlnResult {
  readonly actionIds: readonly string[];
  readonly beliefs: Readonly<Record<string, Readonly<Belief>>>;
  readonly deductionProgram: string;
  readonly rawOutputs: readonly string[];
  readonly proofOutputs: readonly string[];
}

const n = names<"pln-rule" | "pln-fact" | "pln-deduction">();
const ruleAtom = n["pln-rule"];
const factAtom = n["pln-fact"];
const deduction = n["pln-deduction"];

const deducedStrength = (ruleStrength: Term, factStrength: Term): Term =>
  add(mul(ruleStrength, factStrength), mul(0.2, sub(1, factStrength)));
const deducedConfidence = (
  ruleConfidence: Term,
  factConfidence: Term,
  factStrength: Term,
): Term =>
  add(
    mul(factStrength, mmin(ruleConfidence, factConfidence)),
    mul(sub(1, factStrength), mmin(0.2, factConfidence)),
  );
const confidenceToWeight = (confidence: Term): Term =>
  div(mul(confidence, 800), sub(1, mmin(confidence, 0.9999)));
const revisedStrength = (
  strength1: Term,
  confidence1: Term,
  strength2: Term,
  confidence2: Term,
): Term => {
  const weight1 = confidenceToWeight(confidence1);
  const weight2 = confidenceToWeight(confidence2);
  const totalWeight = add(weight1, weight2);
  return If(
    eq(totalWeight, 0),
    0.5,
    div(add(mul(strength1, weight1), mul(strength2, weight2)), totalWeight),
  );
};
const revisedConfidence = (confidence1: Term, confidence2: Term): Term =>
  div(
    add(confidenceToWeight(confidence1), confidenceToWeight(confidence2)),
    add(add(confidenceToWeight(confidence1), confidenceToWeight(confidence2)), 800),
  );

function uniqueIds(values: readonly string[], path: string): void {
  assertDenseArray(values, path);
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") throw new TypeError(`${path} must contain string IDs`);
    if (value.trim() === "") throw new RangeError(`${path} must not contain empty IDs`);
    if (seen.has(value)) throw new RangeError(`${path} contains duplicate ID: ${value}`);
    seen.add(value);
  }
}

function snapshotProgram(input: PlnProgram): PlnProgram {
  assertPlainRecord(input, "PLN program");
  assertKnownKeys(input, "PLN program", ["actionIds", "rules", "facts"]);
  assertDenseArray(input.actionIds, "actionIds");
  assertDenseArray(input.rules, "rules");
  assertDenseArray(input.facts, "facts");
  const actionIds = Object.freeze([...input.actionIds]);
  uniqueIds(actionIds, "actionIds");
  if (actionIds.length === 0) throw new RangeError("actionIds must not be empty");
  const rules = Object.freeze(input.rules.map((rule, index) => {
    assertPlainRecord(rule, `rules[${index}]`);
    assertKnownKeys(rule, `rules[${index}]`, ["id", "predicate", "strength", "confidence"]);
    if (typeof rule.id !== "string") throw new TypeError("rules must contain string IDs");
    if (typeof rule.predicate !== "string" || rule.predicate.trim() === "") {
      throw new TypeError(`rules[${index}].predicate must be a nonblank string`);
    }
    return Object.freeze({
      id: rule.id,
      predicate: rule.predicate,
      strength: finiteProbability(rule.strength, `rules[${index}].strength`),
      confidence: finiteProbability(rule.confidence, `rules[${index}].confidence`),
    });
  }));
  const facts = Object.freeze(input.facts.map((fact, index) => {
    assertPlainRecord(fact, `facts[${index}]`);
    assertKnownKeys(fact, `facts[${index}]`, [
      "id",
      "actionId",
      "predicate",
      "strength",
      "confidence",
    ]);
    if (typeof fact.id !== "string") throw new TypeError("facts must contain string IDs");
    if (typeof fact.actionId !== "string" || fact.actionId.trim() === "") {
      throw new TypeError(`facts[${index}].actionId must be a nonblank string`);
    }
    if (typeof fact.predicate !== "string" || fact.predicate.trim() === "") {
      throw new TypeError(`facts[${index}].predicate must be a nonblank string`);
    }
    return Object.freeze({
      id: fact.id,
      actionId: fact.actionId,
      predicate: fact.predicate,
      strength: finiteProbability(fact.strength, `facts[${index}].strength`),
      confidence: finiteProbability(fact.confidence, `facts[${index}].confidence`),
    });
  }));
  uniqueIds(rules.map((rule) => rule.id), "rules");
  uniqueIds(facts.map((fact) => fact.id), "facts");
  const actionIdSet = new Set(actionIds);
  const predicates = new Set(rules.map((rule) => rule.predicate));
  facts.forEach((fact, index) => {
    if (!actionIdSet.has(fact.actionId)) {
      throw new RangeError(`facts[${index}].actionId references unknown action: ${fact.actionId}`);
    }
    if (!predicates.has(fact.predicate)) {
      throw new RangeError(`facts[${index}].predicate has no matching rule: ${fact.predicate}`);
    }
  });
  return Object.freeze({ actionIds, rules, facts });
}

type DeductionRow = [number, number, string, string, number, number];

function deductionRow(value: unknown, actionId: string): DeductionRow {
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number" ||
    typeof value[2] !== "string" ||
    typeof value[3] !== "string" ||
    typeof value[4] !== "number" ||
    typeof value[5] !== "number" ||
    !Number.isFinite(value[4]) ||
    !Number.isFinite(value[5])
  ) {
    throw new Error(`PLN returned an invalid deduction for action ${actionId}`);
  }
  return value as DeductionRow;
}

function revisedTruthValue(value: unknown, actionId: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number" ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    value[0] < 0 ||
    value[0] > 1 ||
    value[1] < 0 ||
    value[1] > 1
  ) {
    throw new Error(`PLN returned an invalid revised truth value for action ${actionId}`);
  }
  return value as [number, number];
}

/** Deduce one acceptability belief per requested action.
 *
 * Facts match rules by predicate. Multiple deductions for one action are
 * merged in input order with count-space revision using K=800.
 */
export function gradeBeliefs(input: PlnProgram): PlnResult {
  const program = snapshotProgram(input);

  const db = mettaDB();
  const ruleAtoms = program.rules.map((rule, index) =>
    ruleAtom(index, rule.predicate, rule.id, rule.strength, rule.confidence),
  );
  const factAtoms = program.facts.map((fact, index) =>
    factAtom(
      index,
      fact.actionId,
      fact.id,
      fact.predicate,
      fact.strength,
      fact.confidence,
    ),
  );
  addTerms(db, ruleAtoms);
  addTerms(db, factAtoms);

  const q = vars<{
    action: string;
    ruleIndex: number;
    factIndex: number;
    ruleId: string;
    factId: string;
    predicate: string;
    ruleStrength: number;
    ruleConfidence: number;
    factStrength: number;
    factConfidence: number;
  }>();
  const deductionHead = deduction(q.action);
  const deductionBody = Match(
      factAtom(
        q.factIndex,
        q.action,
        q.factId,
        q.predicate,
        q.factStrength,
        q.factConfidence,
      ),
      Match(
        ruleAtom(
          q.ruleIndex,
          q.predicate,
          q.ruleId,
          q.ruleStrength,
          q.ruleConfidence,
        ),
        e(
          q.ruleIndex,
          q.factIndex,
          q.ruleId,
          q.factId,
          deducedStrength(q.ruleStrength, q.factStrength),
          deducedConfidence(q.ruleConfidence, q.factConfidence, q.factStrength),
        ),
      ),
    );
  db.rule(deductionHead, deductionBody);

  const beliefEntries: Array<readonly [string, Belief]> = [];
  const rawOutputs: string[] = [];
  const proofOutputs: string[] = [];
  for (const actionId of program.actionIds) {
    const rows = db.evalJs(deduction(actionId)).map((row) => deductionRow(row, actionId));
    rows.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    rawOutputs.push(JSON.stringify(rows));
    if (rows.length === 0) {
      throw new Error(`PLN returned no belief for action: ${actionId}`);
    }

    let strength = rows[0]![4];
    let confidence = rows[0]![5];
    for (const row of rows.slice(1)) {
      [strength, confidence] = revisedTruthValue(
        db.evalJs(
          e(
            revisedStrength(strength, confidence, row[4], row[5]),
            revisedConfidence(confidence, row[5]),
          ),
        )[0],
        actionId,
      );
    }

    const proofs = rows.map(
      (row) => `(rule-proof ${JSON.stringify(row[2])} ${JSON.stringify(row[3])})`,
    );
    const proofTerm =
      proofs.length === 1 ? proofs[0]! : `(merge/revision ${proofs.join(" ")})`;
    const proof = `(: ${proofTerm} (Acceptable ${JSON.stringify(actionId)}) (STV ${strength} ${confidence}))`;
    beliefEntries.push([actionId, Object.freeze({ strength, confidence, proof })]);
    proofOutputs.push(proof);
  }

  return Object.freeze({
    actionIds: program.actionIds,
    beliefs: Object.freeze(Object.fromEntries(beliefEntries)),
    deductionProgram: [
      ...ruleAtoms.map(String),
      ...factAtoms.map(String),
      `(= ${deductionHead} ${deductionBody})`,
      ...program.actionIds.map((actionId) => `!${deduction(actionId)}`),
    ].join("\n"),
    rawOutputs: Object.freeze(rawOutputs),
    proofOutputs: Object.freeze(proofOutputs),
  });
}
