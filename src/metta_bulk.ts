// Structural bulk operations selected by the native MeTTa rules for large inputs.

import {
  atomToJs,
  Atom,
  E,
  ExpressionAtom,
  GroundedAtom,
  MeTTa,
  S,
  SymbolAtom,
  ValueAtom,
  VariableAtom,
} from "@metta-ts/hyperon";
import { gfloat, hashOf } from "@metta-ts/core";
import { pythonFloatSum } from "./rounding.js";

const DECISION_STATUSES = new Set(["blocked", "recommended", "candidate", "weak"]);

function expressionChildren(atom: Atom, path: string): Atom[] {
  if (!(atom instanceof ExpressionAtom)) {
    throw new TypeError(`${path} must be an expression`);
  }
  return atom.children();
}

function structuralAtom(atom: Atom, path: string): Atom {
  const children = expressionChildren(atom, path);
  if (
    children.length === 2 &&
    children[0] instanceof SymbolAtom &&
    children[0].name() === "noeval"
  ) {
    return children[1]!;
  }
  return atom;
}

function structuralChildren(atom: Atom, path: string): Atom[] {
  return expressionChildren(structuralAtom(atom, path), path);
}

function symbolValue(atom: Atom, path: string): string {
  if (!(atom instanceof SymbolAtom)) throw new TypeError(`${path} must be a symbol`);
  return atom.name();
}

function identityAtom(atom: Atom, path: string): Atom {
  if (atom.iterate().some((part) => part instanceof VariableAtom)) {
    throw new TypeError(`${path} must be ground`);
  }
  return atom;
}

class AtomMap<Value> {
  private readonly buckets = new Map<number, Array<{ atom: Atom; value: Value }>>();

  get(atom: Atom): Value | undefined {
    return this.buckets.get(hashOf(atom.catom))
      ?.find((entry) => entry.atom.equals(atom))
      ?.value;
  }

  has(atom: Atom): boolean {
    return this.get(atom) !== undefined;
  }

  set(atom: Atom, value: Value): void {
    const hash = hashOf(atom.catom);
    const bucket = this.buckets.get(hash);
    const existing = bucket?.find((entry) => entry.atom.equals(atom));
    if (existing !== undefined) {
      existing.value = value;
    } else if (bucket === undefined) {
      this.buckets.set(hash, [{ atom, value }]);
    } else {
      bucket.push({ atom, value });
    }
  }
}

function finiteNumber(atom: Atom, path: string): number {
  const value = atomToJs(atom);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}

function safeInteger(atom: Atom, path: string): number {
  const value = finiteNumber(atom, path);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${path} must be a safe integer`);
  return value;
}

function booleanValue(atom: Atom, path: string): boolean {
  const value = atomToJs(atom);
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function tuple(values: readonly Atom[]): ExpressionAtom {
  return E(...values);
}

function float(value: number): GroundedAtom {
  return new GroundedAtom(gfloat(value));
}

function finiteSums(values: readonly number[], path: string): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError(`${path} produced a non-finite aggregate`);
  }
}

function goalFold(args: Atom[]): Atom[] {
  if (args.length !== 2) throw new TypeError("gc-goal-fold-atom expects two arguments");
  const goals = structuralChildren(args[0]!, "gc-goal-fold-atom goals");
  const satisfiedAtoms = structuralChildren(args[1]!, "gc-goal-fold-atom satisfied goals");
  const satisfied = new AtomMap<true>();
  satisfiedAtoms.forEach((atom, index) => {
    satisfied.set(
      identityAtom(atom, `gc-goal-fold-atom satisfied goals[${index}]`),
      true,
    );
  });

  const totalWeights: number[] = [];
  const coveredWeights: number[] = [];
  const individualWeights: number[] = [];
  const coveredIndividualWeights: number[] = [];
  const collectiveWeights: number[] = [];
  const coveredCollectiveWeights: number[] = [];
  const missing: Atom[] = [];

  const parsedGoals = goals.map((goal, index) => {
    const fields = expressionChildren(goal, `gc-goal-fold-atom goals[${index}]`);
    if (fields.length !== 5 || symbolValue(fields[0]!, `goals[${index}] tag`) !== "Goal") {
      throw new TypeError(`gc-goal-fold-atom goals[${index}] must be a Goal expression`);
    }
    const id = identityAtom(fields[1]!, `gc-goal-fold-atom goals[${index}] id`);
    const kind = symbolValue(fields[2]!, `gc-goal-fold-atom goals[${index}] kind`);
    if (kind !== "individual" && kind !== "collective") {
      throw new TypeError(`gc-goal-fold-atom goals[${index}] has an unsupported kind`);
    }
    const weight = finiteNumber(fields[3]!, `gc-goal-fold-atom goals[${index}] weight`);
    if (weight < 0) throw new RangeError(`gc-goal-fold-atom goals[${index}] weight is negative`);
    const required = booleanValue(fields[4]!, `gc-goal-fold-atom goals[${index}] required`);
    return { id, kind, weight, required };
  });
  for (let index = 0; index < parsedGoals.length; index += 1) {
    const { id, kind, weight, required } = parsedGoals[index]!;
    const isSatisfied = satisfied.has(id);
    totalWeights.push(weight);
    if (isSatisfied) coveredWeights.push(weight);
    if (kind === "individual") {
      individualWeights.push(weight);
      if (isSatisfied) coveredIndividualWeights.push(weight);
    } else {
      collectiveWeights.push(weight);
      if (isSatisfied) coveredCollectiveWeights.push(weight);
    }
    if (required && !isSatisfied) missing.push(id);
  }
  const totals = [
    pythonFloatSum(totalWeights),
    pythonFloatSum(coveredWeights),
    pythonFloatSum(individualWeights),
    pythonFloatSum(coveredIndividualWeights),
    pythonFloatSum(collectiveWeights),
    pythonFloatSum(coveredCollectiveWeights),
  ] as const;
  finiteSums(totals, "gc-goal-fold-atom");
  return [E(
    S("GoalFold"),
    ...totals.map(float),
    tuple(missing),
  )];
}

function packCandidate(args: Atom[]): Atom[] {
  if (args.length !== 3) throw new TypeError("gc-pack-candidate-atom expects three arguments");
  const id = identityAtom(args[0]!, "gc-pack-candidate-atom ID");
  const correlations = structuralChildren(
    args[1]!,
    "gc-pack-candidate-atom correlations",
  );
  correlations.forEach((correlation, index) => {
    const value = finiteNumber(
      correlation,
      `gc-pack-candidate-atom correlations[${index}]`,
    );
    if (value < -1 || value > 1) {
      throw new RangeError(`gc-pack-candidate-atom correlations[${index}] is outside [-1, 1]`);
    }
  });
  const risk = finiteNumber(args[2]!, "gc-pack-candidate-atom risk");
  if (risk < 0 || risk > 1) {
    throw new RangeError("gc-pack-candidate-atom risk is outside [0, 1]");
  }
  return [E(S("Candidate"), id, tuple(correlations), args[2]!)];
}

function canonicalAtom(runner: MeTTa, atom: Atom, path: string): Atom {
  if (!(atom instanceof ExpressionAtom)) return atom;
  const results = runner.evaluateAtom(atom);
  if (results.length !== 1) {
    throw new TypeError(`${path} must reduce to exactly one atom`);
  }
  return results[0]!;
}

function simpleGroundAtom(atom: Atom): boolean {
  if (
    atom instanceof ExpressionAtom ||
    atom.iterate().some((part) => part instanceof VariableAtom)
  ) {
    return false;
  }
  const value = atomToJs(atom);
  return typeof value !== "number" || Number.isFinite(value);
}

function areMotivationInputsSimple(args: readonly Atom[]): boolean {
  if (args.length !== 3) return false;
  try {
    const individual = structuralChildren(args[0]!, "motivation individual goals");
    const collective = structuralChildren(args[1]!, "motivation collective goals");
    const candidates = structuralChildren(args[2]!, "motivation candidates");
    const vectorsAreSimple = individual.every(simpleGroundAtom) &&
      collective.every(simpleGroundAtom);
    const candidatesAreSimple = candidates.every((candidate, index) => {
      const fields = expressionChildren(candidate, `motivation candidates[${index}]`);
      if (
        fields.length !== 4 ||
        !(fields[0] instanceof SymbolAtom) ||
        fields[0].name() !== "Candidate" ||
        !simpleGroundAtom(fields[1]!) ||
        !simpleGroundAtom(fields[3]!)
      ) {
        return false;
      }
      return structuralChildren(
        fields[2]!,
        `motivation candidates[${index}] correlations`,
      ).every(simpleGroundAtom);
    });
    return vectorsAreSimple && candidatesAreSimple;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function motivationInputsSimple(args: Atom[]): Atom[] {
  return [ValueAtom(areMotivationInputsSimple(args))];
}

function canonicalBoundedNumber(
  runner: MeTTa,
  atom: Atom,
  path: string,
  minimum: number,
  maximum: number,
): Atom {
  const canonical = canonicalAtom(runner, atom, path);
  boundedNumber(canonical, path, minimum, maximum);
  return canonical;
}

function boundedNumber(
  atom: Atom,
  path: string,
  minimum: number,
  maximum: number,
): number {
  const value = finiteNumber(atom, path);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${path} is outside [${minimum}, ${maximum}]`);
  }
  return value;
}

function motivationCandidate(
  runner: MeTTa,
  atom: Atom,
  index: number,
  operation: string,
): Atom {
  const path = `${operation} candidates[${index}]`;
  const fields = expressionChildren(atom, path);
  if (
    fields.length !== 4 ||
    symbolValue(fields[0]!, `${path} tag`) !== "Candidate"
  ) {
    throw new TypeError(`${path} is invalid`);
  }
  const id = identityAtom(
    canonicalAtom(runner, fields[1]!, `${path} ID`),
    `${path} ID`,
  );
  const correlations = structuralChildren(
    fields[2]!,
    `${path} correlations`,
  ).map((correlation, correlationIndex) =>
    canonicalBoundedNumber(
      runner,
      correlation,
      `${path} correlations[${correlationIndex}]`,
      -1,
      1,
    )
  );
  const riskAtom = canonicalBoundedNumber(
    runner,
    fields[3]!,
    `${path} risk`,
    0,
    1,
  );
  return E(S("Candidate"), id, tuple(correlations), riskAtom);
}

function motivationPullLeaves(args: Atom[]): Atom[] {
  if (args.length !== 3) {
    throw new TypeError("gc-motivation-pull-tree-atom expects three arguments");
  }
  const individualAtoms = structuralChildren(
    args[0]!,
    "gc-motivation-pull-tree-atom individual goals",
  );
  const collectiveAtoms = structuralChildren(
    args[1]!,
    "gc-motivation-pull-tree-atom collective goals",
  );
  if (individualAtoms.length !== collectiveAtoms.length) {
    throw new RangeError("gc-motivation-pull-tree-atom goal vectors must have equal length");
  }
  const individual = individualAtoms.map((atom, index) => boundedNumber(
    atom,
    `gc-motivation-pull-tree-atom individual goals[${index}]`,
    0,
    1,
  ));
  const collective = collectiveAtoms.map((atom, index) => boundedNumber(
    atom,
    `gc-motivation-pull-tree-atom collective goals[${index}]`,
    0,
    1,
  ));
  const candidateAtoms = structuralChildren(
    args[2]!,
    "gc-motivation-pull-tree-atom candidates",
  );
  if (candidateAtoms.length === 0) {
    throw new RangeError("gc-motivation-pull-tree-atom candidates must not be empty");
  }
  const ids = new AtomMap<true>();
  const leaves = candidateAtoms.map((candidate, candidateIndex) => {
    const path = `gc-motivation-pull-tree-atom candidates[${candidateIndex}]`;
    const fields = expressionChildren(candidate, path);
    if (
      fields.length !== 4 ||
      symbolValue(fields[0]!, `${path} tag`) !== "Candidate"
    ) {
      throw new TypeError(`${path} is invalid`);
    }
    const id = identityAtom(fields[1]!, `${path} ID`);
    if (ids.has(id)) {
      throw new RangeError(`duplicate motivation candidate identity at index ${candidateIndex}`);
    }
    ids.set(id, true);
    const correlations = structuralChildren(fields[2]!, `${path} correlations`).map(
      (atom, correlationIndex) => boundedNumber(
        atom,
        `${path} correlations[${correlationIndex}]`,
        -1,
        1,
      ),
    );
    if (correlations.length !== individual.length) {
      throw new RangeError(`${path} has the wrong correlation count`);
    }
    const risk = boundedNumber(fields[3]!, `${path} risk`, 0, 1);
    const individualPull = pythonFloatSum(
      individual.map((value, index) => value * correlations[index]!),
    );
    const collectivePull = pythonFloatSum(
      collective.map((value, index) => value * correlations[index]!),
    );
    finiteSums([individualPull, collectivePull, risk], path);
    return E(
      S("MotivationPullLeaf"),
      id,
      float(individualPull),
      float(collectivePull),
      fields[3]!,
    );
  });
  return leaves;
}

function motivationPullTree(args: Atom[]): Atom[] {
  return [balancedTree(
    motivationPullLeaves(args),
    "MotivationPullEmpty",
    "MotivationPullNode",
  )];
}

function validatedMotivationConsensusBridge(args: Atom[], runner: MeTTa): Atom[] {
  if (args.length !== 3) {
    throw new TypeError("gc-motivation-consensus-bridge-atom expects three arguments");
  }
  const individualAtom = structuralAtom(
    args[0]!,
    "gc-motivation-consensus-bridge-atom individual goals",
  );
  const collectiveAtom = structuralAtom(
    args[1]!,
    "gc-motivation-consensus-bridge-atom collective goals",
  );
  const individual = structuralChildren(
    individualAtom,
    "gc-motivation-consensus-bridge-atom individual goals",
  ).map((value, index) => canonicalBoundedNumber(
    runner,
    value,
    `gc-motivation-consensus-bridge-atom individual goals[${index}]`,
    0,
    1,
  ));
  const collective = structuralChildren(
    collectiveAtom,
    "gc-motivation-consensus-bridge-atom collective goals",
  ).map((value, index) => canonicalBoundedNumber(
    runner,
    value,
    `gc-motivation-consensus-bridge-atom collective goals[${index}]`,
    0,
    1,
  ));
  if (individual.length !== collective.length) {
    throw new RangeError("gc-motivation-consensus-bridge-atom goal vectors must have equal length");
  }
  const canonicalIndividual = tuple(individual);
  const canonicalCollective = tuple(collective);

  const candidates = structuralChildren(
    args[2]!,
    "gc-motivation-consensus-bridge-atom candidates",
  ).map((candidate, index) =>
    motivationCandidate(runner, candidate, index, "gc-motivation-consensus-bridge-atom")
  );
  if (candidates.length === 0) {
    throw new RangeError("gc-motivation-consensus-bridge-atom candidates must not be empty");
  }
  const ids = new AtomMap<true>();
  candidates.forEach((candidate, index) => {
    const fields = expressionChildren(candidate, `candidates[${index}]`);
    const id = fields[1]!;
    if (ids.has(id)) {
      throw new RangeError(`duplicate motivation candidate identity at index ${index}`);
    }
    ids.set(id, true);
    const correlations = structuralChildren(
      fields[2]!,
      `gc-motivation-consensus-bridge-atom candidates[${index}] correlations`,
    );
    if (correlations.length !== individual.length) {
      throw new RangeError(
        `gc-motivation-consensus-bridge-atom candidates[${index}] has the wrong correlation count`,
      );
    }
  });

  return [E(
    S("gc-motivation-consensus-canonical"),
    canonicalIndividual,
    canonicalCollective,
    tuple(candidates),
  )];
}

function motivationConsensusBridge(args: Atom[], runner: MeTTa): Atom[] {
  try {
    return validatedMotivationConsensusBridge(args, runner);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return invalidMotivationConsensus();
    }
    throw error;
  }
}

function invalidMotivationConsensus(): Atom[] {
  return [E(S("InvalidMotivationConsensus"))];
}

// Route raw direct inputs before MeTTa can expand reducible data terms.
function motivationConsensus(args: Atom[], runner: MeTTa): Atom[] {
  if (args.length !== 3) return invalidMotivationConsensus();
  try {
    const individual = structuralChildren(args[0]!, "motivation individual goals");
    const collective = structuralChildren(args[1]!, "motivation collective goals");
    const candidates = structuralChildren(args[2]!, "motivation candidates");
    if (
      individual.length > 8 ||
      collective.length > 8 ||
      candidates.length > 8 ||
      !areMotivationInputsSimple(args)
    ) {
      return motivationConsensusBridge(args, runner);
    }
    return [E(
      S("gc-motivation-consensus-expressions"),
      structuralAtom(args[0]!, "motivation individual goals"),
      structuralAtom(args[1]!, "motivation collective goals"),
      structuralAtom(args[2]!, "motivation candidates"),
    )];
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return invalidMotivationConsensus();
    }
    throw error;
  }
}

function motivationScoreRow(atom: Atom, index: number): { readonly atom: Atom; readonly id: Atom } {
  const fields = expressionChildren(atom, `gc-motivation-score-tree-atom rows[${index}]`);
  if (
    fields.length !== 7 ||
    symbolValue(fields[0]!, `gc-motivation-score-tree-atom rows[${index}] tag`) !==
      "MotivationScoreRow"
  ) {
    throw new TypeError(`gc-motivation-score-tree-atom rows[${index}] is invalid`);
  }
  const id = identityAtom(fields[1]!, `gc-motivation-score-tree-atom rows[${index}] ID`);
  fields.slice(2).forEach((score, scoreIndex) => {
    finiteNumber(score, `gc-motivation-score-tree-atom rows[${index}] score[${scoreIndex}]`);
  });
  return { atom, id };
}

function motivationScoreTree(args: Atom[]): Atom[] {
  if (args.length !== 1) {
    throw new TypeError("gc-motivation-score-tree-atom expects one argument");
  }
  const rows = structuralChildren(args[0]!, "gc-motivation-score-tree-atom rows")
    .map(motivationScoreRow);
  if (rows.length === 0) {
    throw new RangeError("gc-motivation-score-tree-atom rows must not be empty");
  }
  const ids = new AtomMap<true>();
  rows.forEach(({ id }, index) => {
    if (ids.has(id)) {
      throw new RangeError(`duplicate motivation score identity at row ${index}`);
    }
    ids.set(id, true);
  });
  return [balancedTree(
    rows.map(({ atom }) => E(S("MotivationScoreLeaf"), atom)),
    "MotivationScoreEmpty",
    "MotivationScoreNode",
  )];
}

interface RankedRow {
  readonly atom: Atom;
  readonly action: Atom;
  readonly order: number;
  readonly score: number;
}

function rankDecisionRows(args: Atom[]): Atom[] {
  if (args.length !== 2) {
    throw new TypeError("gc-rank-decision-rows-atom expects two arguments");
  }
  const rowAtoms = structuralChildren(args[0]!, "gc-rank-decision-rows-atom rows");
  if (rowAtoms.length === 0) {
    throw new RangeError("gc-rank-decision-rows-atom rows must not be empty");
  }
  const epsilon = finiteNumber(args[1]!, "gc-rank-decision-rows-atom epsilon");
  if (epsilon < 0) throw new RangeError("gc-rank-decision-rows-atom epsilon must be nonnegative");
  const actions = new AtomMap<true>();
  const orders = new Set<number>();
  const rows = rowAtoms.map((row, inputIndex): RankedRow => {
    const fields = expressionChildren(row, `gc-rank-decision-rows-atom rows[${inputIndex}]`);
    if (
      fields.length !== 5 ||
      symbolValue(fields[0]!, `rows[${inputIndex}] tag`) !== "DecisionRow"
    ) {
      throw new TypeError(`gc-rank-decision-rows-atom rows[${inputIndex}] is invalid`);
    }
    const action = identityAtom(
      fields[1]!,
      `gc-rank-decision-rows-atom rows[${inputIndex}] action`,
    );
    if (actions.has(action)) {
      throw new RangeError(`duplicate decision action identity at row ${inputIndex}`);
    }
    actions.set(action, true);
    const order = safeInteger(fields[2]!, `gc-rank-decision-rows-atom rows[${inputIndex}] order`);
    if (order < 0 || orders.has(order)) {
      throw new RangeError(`invalid or duplicate decision order at row ${inputIndex}`);
    }
    orders.add(order);
    const score = finiteNumber(fields[3]!, `gc-rank-decision-rows-atom rows[${inputIndex}] score`);
    const status = symbolValue(fields[4]!, `gc-rank-decision-rows-atom rows[${inputIndex}] status`);
    if (!DECISION_STATUSES.has(status)) {
      throw new TypeError(`unsupported decision status at row ${inputIndex}`);
    }
    return { atom: row, action, order, score };
  });

  const sorted = [...rows].sort((left, right) => {
    if (left.score > right.score) return -1;
    if (left.score < right.score) return 1;
    return left.order - right.order;
  });
  const bestScore = sorted[0]!.score;
  const tied: Atom[] = [];
  for (const row of sorted) {
    if (Math.abs(row.score - bestScore) > epsilon) break;
    tied.push(row.action);
  }
  return [E(
    S("BulkRanking"),
    tuple(sorted.map((row) => row.atom)),
    tuple(tied),
    float(tied.length),
  )];
}

function flattenMotivationConsensusTree(args: Atom[]): Atom[] {
  if (args.length !== 1) {
    throw new TypeError("gc-flatten-motivation-consensus-tree-atom expects one argument");
  }
  const scores: Atom[] = [];
  const pending: Array<{ atom: Atom; path: string }> = [{
    atom: structuralAtom(args[0]!, "gc-flatten-motivation-consensus-tree-atom tree"),
    path: "tree",
  }];
  while (pending.length > 0) {
    const { atom, path } = pending.pop()!;
    const fields = expressionChildren(atom, path);
    const tag = fields[0] instanceof SymbolAtom ? fields[0].name() : undefined;
    if (tag === "MotivationConsensusEmpty" && fields.length === 1) continue;
    if (tag === "MotivationConsensusNode" && fields.length === 3) {
      pending.push({ atom: structuralAtom(fields[2]!, `${path}.right`), path: `${path}.right` });
      pending.push({ atom: structuralAtom(fields[1]!, `${path}.left`), path: `${path}.left` });
      continue;
    }
    if (tag === "MotivationConsensusLeaf" && fields.length === 2) {
      const scoreFields = expressionChildren(fields[1]!, `${path}.score`);
      if (
        scoreFields.length !== 3 ||
        symbolValue(scoreFields[0]!, `${path}.score tag`) !== "ConsensusScore"
      ) {
        throw new TypeError(`${path} contains an invalid consensus score`);
      }
      identityAtom(scoreFields[1]!, `${path}.score ID`);
      finiteNumber(scoreFields[2]!, `${path}.score value`);
      scores.push(fields[1]!);
      continue;
    }
    throw new TypeError(`${path} must be a motivation consensus tree`);
  }
  return [tuple(scores)];
}

interface PlnRuleAtom {
  readonly id: Atom;
  readonly predicate: Atom;
  readonly strength: Atom;
  readonly confidence: Atom;
}

interface PlnFactAtom {
  readonly id: Atom;
  readonly action: Atom;
  readonly predicate: Atom;
  readonly strength: Atom;
  readonly confidence: Atom;
}

function plnRule(atom: Atom, index: number): PlnRuleAtom {
  const fields = expressionChildren(atom, `gc-pln-match-tree-atom rules[${index}]`);
  if (fields.length !== 5 || symbolValue(fields[0]!, `rules[${index}] tag`) !== "PlnRule") {
    throw new TypeError(`gc-pln-match-tree-atom rules[${index}] must be a PlnRule`);
  }
  const id = identityAtom(fields[1]!, `gc-pln-match-tree-atom rules[${index}] id`);
  const predicate = identityAtom(
    fields[2]!,
    `gc-pln-match-tree-atom rules[${index}] predicate`,
  );
  for (const [field, value] of [["strength", fields[3]!], ["confidence", fields[4]!]] as const) {
    const number = finiteNumber(value, `gc-pln-match-tree-atom rules[${index}] ${field}`);
    if (number < 0 || number > 1) {
      throw new RangeError(`gc-pln-match-tree-atom rules[${index}] ${field} is outside [0, 1]`);
    }
  }
  return { id, predicate, strength: fields[3]!, confidence: fields[4]! };
}

function plnFact(atom: Atom, index: number): PlnFactAtom {
  const fields = expressionChildren(atom, `gc-pln-match-tree-atom facts[${index}]`);
  if (fields.length !== 6 || symbolValue(fields[0]!, `facts[${index}] tag`) !== "PlnFact") {
    throw new TypeError(`gc-pln-match-tree-atom facts[${index}] must be a PlnFact`);
  }
  const id = identityAtom(fields[1]!, `gc-pln-match-tree-atom facts[${index}] id`);
  const action = identityAtom(fields[2]!, `gc-pln-match-tree-atom facts[${index}] action`);
  const predicate = identityAtom(
    fields[3]!,
    `gc-pln-match-tree-atom facts[${index}] predicate`,
  );
  for (const [field, value] of [["strength", fields[4]!], ["confidence", fields[5]!]] as const) {
    const number = finiteNumber(value, `gc-pln-match-tree-atom facts[${index}] ${field}`);
    if (number < 0 || number > 1) {
      throw new RangeError(`gc-pln-match-tree-atom facts[${index}] ${field} is outside [0, 1]`);
    }
  }
  return {
    id,
    action,
    predicate,
    strength: fields[4]!,
    confidence: fields[5]!,
  };
}

function balancedTree(leaves: readonly Atom[], emptyName: string, nodeName: string): Atom {
  if (leaves.length === 0) return E(S(emptyName));
  const build = (start: number, end: number): Atom => {
    if (end - start === 1) return leaves[start]!;
    const middle = start + Math.floor((end - start) / 2);
    return E(S(nodeName), build(start, middle), build(middle, end));
  };
  return build(0, leaves.length);
}

function plnMatchTree(args: Atom[]): Atom[] {
  if (args.length !== 3) throw new TypeError("gc-pln-match-tree-atom expects three arguments");
  const targetAction = identityAtom(args[0]!, "gc-pln-match-tree-atom action");
  const rules = structuralChildren(args[1]!, "gc-pln-match-tree-atom rules").map(plnRule);
  const facts = structuralChildren(args[2]!, "gc-pln-match-tree-atom facts").map(plnFact);
  const byPredicate = new AtomMap<PlnFactAtom[]>();
  for (const fact of facts) {
    if (!fact.action.equals(targetAction)) continue;
    const matching = byPredicate.get(fact.predicate);
    if (matching === undefined) byPredicate.set(fact.predicate, [fact]);
    else matching.push(fact);
  }
  const leaves: Atom[] = [];
  for (const rule of rules) {
    for (const fact of byPredicate.get(rule.predicate) ?? []) {
      leaves.push(E(
        S("PlnMatchLeaf"),
        rule.id,
        fact.id,
        rule.strength,
        rule.confidence,
        fact.strength,
        fact.confidence,
      ));
    }
  }
  return [balancedTree(leaves, "PlnMatchEmpty", "PlnMatchNode")];
}

/** Register bounded structural operations used by the native MeTTa rules. */
export function registerGoalChainerBulkOperations(runner: MeTTa): void {
  runner.registerOperation("gc-goal-fold-atom", goalFold);
  runner.registerOperation("gc-pack-candidate-atom", packCandidate);
  runner.registerOperation("gc-motivation-pull-tree-atom", motivationPullTree);
  runner.registerOperation(
    "gc-motivation-consensus-bridge-atom",
    (args) => motivationConsensusBridge(args, runner),
  );
  runner.registerOperation("gc-motivation-inputs-simple-atom", motivationInputsSimple);
  runner.registerOperation(
    "gc-motivation-consensus",
    (args) => motivationConsensus(args, runner),
  );
  runner.registerOperation("gc-motivation-score-tree-atom", motivationScoreTree);
  runner.registerOperation("gc-rank-decision-rows-atom", rankDecisionRows);
  runner.registerOperation(
    "gc-flatten-motivation-consensus-tree-atom",
    flattenMotivationConsensusTree,
  );
  runner.registerOperation("gc-pln-match-tree-atom", plnMatchTree);
}
