// GoalChainer PLN deduction and revision through goalchainer.metta.

import {
  mettaCall,
  mettaFloat,
  mettaString,
  mettaTuple,
  sharedGoalChainerMetta,
  type Term,
} from "./metta.js";
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

interface NativeDeduction {
  readonly ruleId: string;
  readonly factId: string;
  readonly strength: number;
  readonly confidence: number;
}

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

function ruleTerm(rule: PlnRule): Term {
  return mettaCall(
    "PlnRule",
    mettaString(rule.id),
    mettaString(rule.predicate),
    mettaFloat(rule.strength),
    mettaFloat(rule.confidence),
  );
}

function factTerm(fact: PlnFact): Term {
  return mettaCall(
    "PlnFact",
    mettaString(fact.id),
    mettaString(fact.actionId),
    mettaString(fact.predicate),
    mettaFloat(fact.strength),
    mettaFloat(fact.confidence),
  );
}

function finiteTruthValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`goalchainer.metta returned an invalid ${path}`);
  }
  return value;
}

function nativeDeduction(value: unknown, actionId: string): NativeDeduction {
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== "Deduced" ||
    typeof value[1] !== "string" ||
    typeof value[2] !== "string"
  ) {
    throw new Error(`PLN returned an invalid deduction for action ${actionId}`);
  }
  return Object.freeze({
    ruleId: value[1],
    factId: value[2],
    strength: finiteTruthValue(value[3], `${actionId} deduction strength`),
    confidence: finiteTruthValue(value[4], `${actionId} deduction confidence`),
  });
}

function proofNode(value: unknown, actionId: string): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`PLN returned an invalid proof for action ${actionId}`);
  }
  if (
    value[0] === "RuleProof" &&
    value.length === 3 &&
    typeof value[1] === "string" &&
    typeof value[2] === "string"
  ) {
    return `(rule-proof ${JSON.stringify(value[1])} ${JSON.stringify(value[2])})`;
  }
  if (value[0] === "Revision" && value.length === 3) {
    return `(revision ${proofNode(value[1], actionId)} ${proofNode(value[2], actionId)})`;
  }
  if (value[0] === "RevisionSequence" && value.length === 2) {
    return `(revision-sequence ${proofNode(value[1], actionId)})`;
  }
  if (value[0] === "ProofSequenceNode" && value.length === 3) {
    return `(proof-sequence ${proofNode(value[1], actionId)} ${proofNode(value[2], actionId)})`;
  }
  throw new Error(`PLN returned an invalid proof node for action ${actionId}`);
}

function readActionResult(
  value: unknown,
  actionId: string,
  ruleIndex: ReadonlyMap<string, number>,
  factIndex: ReadonlyMap<string, number>,
): {
  belief: Belief;
  raw: string;
  proofOutput: string;
} {
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== "PlnResult") {
    throw new Error(`PLN returned an invalid result for action: ${actionId}`);
  }
  if (!Array.isArray(value[2])) {
    throw new Error(`PLN returned invalid deductions for action: ${actionId}`);
  }
  const deductions = value[2].map((entry) => nativeDeduction(entry, actionId));
  if (deductions.length === 0 || !Array.isArray(value[1]) || value[1][0] === "NoBelief") {
    throw new Error(`PLN returned no belief for action: ${actionId}`);
  }
  if (value[1].length !== 4 || value[1][0] !== "Belief") {
    throw new Error(`PLN returned an invalid belief for action: ${actionId}`);
  }
  const strength = finiteTruthValue(value[1][1], `${actionId} belief strength`);
  const confidence = finiteTruthValue(value[1][2], `${actionId} belief confidence`);
  proofNode(value[1][3], actionId);
  const flatProofs = deductions.map(
    (deduction) =>
      `(rule-proof ${JSON.stringify(deduction.ruleId)} ${JSON.stringify(deduction.factId)})`,
  );
  const proofTerm = flatProofs.length === 1
    ? flatProofs[0]!
    : `(merge/revision ${flatProofs.join(" ")})`;
  const proof = `(: ${proofTerm} (Acceptable ${JSON.stringify(actionId)}) (STV ${strength} ${confidence}))`;
  const rows = deductions.map((deduction) => [
    ruleIndex.get(deduction.ruleId),
    factIndex.get(deduction.factId),
    deduction.ruleId,
    deduction.factId,
    deduction.strength,
    deduction.confidence,
  ]);
  if (rows.some((row) => row[0] === undefined || row[1] === undefined)) {
    throw new Error(`PLN returned an unknown rule or fact for action: ${actionId}`);
  }
  return {
    belief: Object.freeze({ strength, confidence, proof }),
    raw: JSON.stringify(rows),
    proofOutput: proof,
  };
}

/** Deduce one acceptability belief per requested action in MeTTa.
 *
 * Facts match rules by predicate. Multiple deductions are merged in declared
 * rule and fact order with count-space revision using K=800.
 */
export function gradeBeliefs(input: PlnProgram): PlnResult {
  const program = snapshotProgram(input);
  const rules = program.rules.map(ruleTerm);
  const facts = program.facts.map(factTerm);
  const queries = program.actionIds.map((actionId) => mettaCall(
    "gc-pln-evaluate",
    mettaString(actionId),
    mettaTuple(rules),
    mettaTuple(facts),
  ));
  const groups = sharedGoalChainerMetta().evalJsMany(queries);
  const ruleIndexes = new Map(program.rules.map((rule, index) => [rule.id, index]));
  const factIndexes = new Map(program.facts.map((fact, index) => [fact.id, index]));
  const beliefEntries: Array<readonly [string, Belief]> = [];
  const rawOutputs: string[] = [];
  const proofOutputs: string[] = [];
  groups.forEach((values, index) => {
    const actionId = program.actionIds[index]!;
    if (values.length !== 1) {
      throw new Error(`PLN returned ${values.length} results for action: ${actionId}`);
    }
    const decoded = readActionResult(values[0], actionId, ruleIndexes, factIndexes);
    beliefEntries.push([actionId, decoded.belief]);
    rawOutputs.push(decoded.raw);
    proofOutputs.push(decoded.proofOutput);
  });
  return Object.freeze({
    actionIds: program.actionIds,
    beliefs: Object.freeze(Object.fromEntries(beliefEntries)),
    deductionProgram: [
      ...rules.map(String),
      ...facts.map(String),
      ...queries.map((query) => `!${String(query)}`),
    ].join("\n"),
    rawOutputs: Object.freeze(rawOutputs),
    proofOutputs: Object.freeze(proofOutputs),
  });
}
