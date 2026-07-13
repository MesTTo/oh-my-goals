// Memory-backed solving. Active memory propositions are projected into a
// GoalScenario and per-action evidence, then ranked through the existing native
// DecisionEngine. The projection is pure and deterministic, following the lesson
// from the GoalChainer original: reason over a small typed premise set, not over
// raw text.
//
// Goals, norms, and candidate actions are read from active memory. The dynamic
// signal is the set of active derived conclusions that structurally reference an
// action: a conflict conclusion forbids the action, a support conclusion raises its
// evidence. Because a derived conclusion is proof-only, retracting the observation
// it rests on invalidates the proof and deactivates the conclusion (Phase 2 reverse
// invalidation), so a recommendation changes when a conflict is derived and restores
// when the evidence is retracted. The solver reads this explicit active state and
// never guesses an observation's valence: the world-knowledge judgment that a test
// failure is a conflict lives in the agent's derivation, carried with a proof.
//
// A candidate action names a stable identifier as a `(+ action <id>)` compound, and
// a conclusion links to it by the identical compound. Advice (the ranked decisions)
// is reported separately from automatic-execution eligibility (ties and blocks),
// because a recommendation is never authority to act.

import { labelsOf, typedMettaOf } from "./candidates.js";
import type { ShNode } from "./hyperbase.js";
import {
  MEMORY_SCOPES,
  type MemoryScope,
  type MemorySpace,
  type StoredProposition,
} from "./memory.js";
import { mettaFloat, mettaOne, sharedGoalChainerMetta } from "./metta.js";
import {
  createCandidateAction,
  createEvidenceProjection,
  createGoal,
  createGoalScenario,
  createNorm,
  type CandidateAction,
  type DeonticStatus,
  type EvidenceProjection,
  type Goal,
  type GoalScenario,
  type Norm,
  type NormMode,
} from "./models.js";
import { DecisionEngine, type DecisionRanking, type EvidenceReasoner } from "./score.js";

// Relation verbs that classify a conclusion's effect on the action it references.
// Conflicts forbid; supports raise evidence. Kept small and explicit; an unmatched
// verb leaves the conclusion uncounted rather than guessed.
const CONFLICT_VERBS: ReadonlySet<string> = new Set([
  "conflicts",
  "conflict",
  "violates",
  "violate",
  "breaks",
  "break",
  "contradicts",
  "contradict",
]);
const SUPPORT_VERBS: ReadonlySet<string> = new Set([
  "satisfies",
  "satisfy",
  "supports",
  "support",
  "achieves",
  "achieve",
  "advances",
  "advance",
]);
// Deontic verbs that classify a norm's modality when it targets an action.
const OBLIGE_VERBS: ReadonlySet<string> = new Set([
  "requires",
  "require",
  "obliges",
  "oblige",
  "mandates",
  "mandate",
  "must",
  "shall",
]);
const FORBID_VERBS: ReadonlySet<string> = new Set([
  "prohibits",
  "prohibit",
  "forbids",
  "forbid",
  "bans",
  "ban",
  "disallows",
  "disallow",
]);
const PERMIT_VERBS: ReadonlySet<string> = new Set([
  "permits",
  "permit",
  "allows",
  "allow",
]);

// Evidence a supported action carries: strong strength and confidence, enough to
// clear the recommended gate. An action with no signal rests on its declared
// default instead, which reads as weak and asks for evidence rather than
// recommending on nothing.
const SUPPORTED_STRENGTH = 0.9;
const SUPPORTED_CONFIDENCE = 0.9;

function isAtom(node: ShNode): node is Extract<ShNode, { atom: true }> {
  return node.atom;
}

/** The root relation verb of a proposition tree, e.g. `conflicts`, or null. */
function rootRelationVerb(tree: ShNode): string | null {
  if (isAtom(tree) || tree.mainType !== "R") return null;
  return isAtom(tree.connector) ? tree.connector.root : null;
}

// Collect the identifiers a tree names as `(+ <type> <id>)` compounds: a `+`
// connector over two atoms, one of which is the type word. AlphaBeta renders
// "action upgrade_database" as (+/B action/Cc upgrade_database/Cc), and every
// proposition that mentions the same action repeats that identical compound, so a
// link is exact-structural, not fuzzy.
function collectEntityRefs(node: ShNode, type: string, into: Set<string>): void {
  if (isAtom(node)) return;
  if (isAtom(node.connector) && node.connector.root === "+" && node.children.length === 2) {
    const [a, b] = node.children;
    if (isAtom(a!) && isAtom(b!)) {
      if (a.label === type && b.label !== type) into.add(b.label);
      else if (b.label === type && a.label !== type) into.add(a.label);
    }
  }
  if (!isAtom(node.connector)) collectEntityRefs(node.connector, type, into);
  for (const child of node.children) collectEntityRefs(child, type, into);
}

/** Action identifiers a proposition names, e.g. `upgrade_database`. */
export function actionReferences(tree: ShNode): string[] {
  const refs = new Set<string>();
  collectEntityRefs(tree, "action", refs);
  return [...refs];
}

function treeOf(proposition: StoredProposition): ShNode | null {
  if (proposition.shTree === undefined) return null;
  return JSON.parse(proposition.shTree) as ShNode;
}

function normModeOf(verb: string): NormMode | null {
  if (OBLIGE_VERBS.has(verb)) return "oblige";
  if (FORBID_VERBS.has(verb)) return "forbid";
  if (PERMIT_VERBS.has(verb)) return "permit";
  return null;
}

// Higher-authority scopes carry higher norm priority, so a user norm outranks a
// project norm on the same action.
const SCOPE_PRIORITY: Readonly<Record<MemoryScope, number>> = Object.freeze({
  user: 3,
  project: 2,
  derived: 1,
  session: 0,
});

export interface ActionEvidenceTrace {
  readonly actionId: string;
  readonly strength: number;
  readonly confidence: number;
  readonly deontic: DeonticStatus;
  /** Active conflict conclusions forbidding this action. */
  readonly conflicts: readonly string[];
  /** Active support conclusions raising this action's evidence. */
  readonly supports: readonly string[];
}

export interface SolveDiagnostics {
  /** Norm propositions that named no known action, so they were not applied. */
  readonly unlinkedNorms: readonly string[];
  /** Action propositions that named no `(+ action <id>)` identifier. */
  readonly actionsWithoutIdentifier: readonly string[];
  /** A baseline goal was synthesized because no goal was active. */
  readonly syntheticGoal: boolean;
  /** Propositions that could not be projected, with the reason. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

export interface SolveReceipt {
  readonly scope: MemoryScope;
  /** Advice: the ranked decisions, best first. */
  readonly ranking: DecisionRanking;
  /** The single recommended action, or null when none is (a tie, a block, or empty). */
  readonly recommended: string | null;
  /** Automatic-execution eligibility, kept separate from advice. */
  readonly automaticExecutionAllowed: boolean;
  readonly tiedActionIds: readonly string[];
  readonly blockedActionIds: readonly string[];
  /** The scenario projected from memory. */
  readonly scenario: GoalScenario;
  readonly evidence: readonly ActionEvidenceTrace[];
  readonly diagnostics: SolveDiagnostics;
  /** Memory proposition id behind each scenario goal, norm, and action. */
  readonly provenance: {
    readonly goals: Readonly<Record<string, string>>;
    readonly norms: Readonly<Record<string, string>>;
    readonly actions: Readonly<Record<string, string>>;
  };
}

export interface SolveOptions {
  readonly scope: MemoryScope;
  readonly title?: string;
  /** Normalized per-action motivation, keyed by projected action id. */
  readonly motivationScores?: Readonly<Record<string, number>>;
}

interface ProjectedAction {
  readonly action: CandidateAction;
  readonly propositionId: string;
}

interface Projection {
  readonly scenario: GoalScenario;
  readonly actions: readonly ProjectedAction[];
  readonly goalIds: readonly string[];
  readonly diagnostics: SolveDiagnostics;
  readonly provenance: SolveReceipt["provenance"];
}

/** Project active goal, norm, and action propositions in one scope into a scenario. */
function projectScenario(memory: MemorySpace, scope: MemoryScope, title: string): Projection {
  const skipped: { id: string; reason: string }[] = [];
  const goalProvenance: Record<string, string> = {};
  const goals: Goal[] = [];
  for (const id of memory.activeOfKind(scope, "goal")) {
    const proposition = memory.get(id);
    if (proposition === undefined) continue;
    const tree = treeOf(proposition);
    const required = tree !== null && (rootRelationVerb(tree) !== null) && OBLIGE_VERBS.has(rootRelationVerb(tree)!);
    goals.push(
      createGoal({
        id,
        owner: proposition.sources[0]?.type ?? "memory",
        statement: proposition.content,
        weight: 1,
        kind: "individual",
        required,
      }),
    );
    goalProvenance[id] = id;
  }
  let syntheticGoal = false;
  if (goals.length === 0) {
    // A scenario needs a positive goal weight; with no goal in memory, evaluate the
    // actions against a single neutral progress goal.
    goals.push(
      createGoal({
        id: "goal:baseline",
        owner: "memory",
        statement: "Make progress on the task.",
        weight: 1,
        kind: "individual",
        required: false,
      }),
    );
    syntheticGoal = true;
  }
  const goalIds = goals.map((goal) => goal.id);

  const actionProvenance: Record<string, string> = {};
  const projectedActions: ProjectedAction[] = [];
  const actionsWithoutIdentifier: string[] = [];
  const seenActionIds = new Set<string>();
  for (const id of memory.activeOfKind(scope, "action")) {
    const proposition = memory.get(id);
    if (proposition === undefined) continue;
    const tree = treeOf(proposition);
    const refs = tree === null ? [] : actionReferences(tree);
    let actionId = refs[0];
    if (actionId === undefined) {
      actionId = id;
      actionsWithoutIdentifier.push(id);
    }
    if (seenActionIds.has(actionId)) {
      skipped.push({ id, reason: `duplicate action identifier ${actionId}` });
      continue;
    }
    seenActionIds.add(actionId);
    projectedActions.push({
      // Every action is evaluated against all active goals; per-action goal
      // satisfaction is not derived from English in this release.
      action: createCandidateAction({
        id: actionId,
        label: proposition.content,
        description: proposition.content,
        satisfies: goalIds,
      }),
      propositionId: id,
    });
    actionProvenance[actionId] = id;
  }

  const normProvenance: Record<string, string> = {};
  const norms: Norm[] = [];
  const unlinkedNorms: string[] = [];
  for (const id of memory.activeOfKind(scope, "norm")) {
    const proposition = memory.get(id);
    if (proposition === undefined) continue;
    const tree = treeOf(proposition);
    const verb = tree === null ? null : rootRelationVerb(tree);
    const mode = verb === null ? null : normModeOf(verb);
    const refs = tree === null ? [] : actionReferences(tree);
    const targetAction = refs.find((ref) => seenActionIds.has(ref));
    if (mode === null || targetAction === undefined) {
      unlinkedNorms.push(id);
      continue;
    }
    norms.push(
      createNorm({
        id,
        mode,
        targetAction,
        reason: proposition.content,
        priority: SCOPE_PRIORITY[scope],
      }),
    );
    normProvenance[id] = id;
  }

  if (projectedActions.length === 0) {
    throw new RangeError(
      `no active candidate actions in ${scope} memory; store an action proposition (e.g. "Action <id> ...") before solving`,
    );
  }
  const scenario = createGoalScenario({
    title,
    goals,
    norms,
    actions: projectedActions.map((entry) => entry.action),
  });
  return {
    scenario,
    actions: projectedActions,
    goalIds,
    diagnostics: Object.freeze({
      unlinkedNorms: Object.freeze(unlinkedNorms),
      actionsWithoutIdentifier: Object.freeze(actionsWithoutIdentifier),
      syntheticGoal,
      skipped: Object.freeze(skipped),
    }),
    provenance: Object.freeze({
      goals: Object.freeze(goalProvenance),
      norms: Object.freeze(normProvenance),
      actions: Object.freeze(actionProvenance),
    }),
  };
}

interface ActionSignal {
  readonly conflicts: string[];
  readonly supports: string[];
}

// Scan active derived conclusions in scope once, bucketing each by the action it
// references and whether it conflicts with or supports that action.
function collectActionSignals(
  memory: MemorySpace,
  scope: MemoryScope,
): Map<string, ActionSignal> {
  const signals = new Map<string, ActionSignal>();
  const signal = (actionId: string): ActionSignal => {
    let entry = signals.get(actionId);
    if (entry === undefined) {
      entry = { conflicts: [], supports: [] };
      signals.set(actionId, entry);
    }
    return entry;
  };
  for (const id of memory.activeOfKind(scope, "derived-conclusion")) {
    const proposition = memory.get(id);
    if (proposition === undefined) continue;
    const tree = treeOf(proposition);
    if (tree === null) continue;
    const verb = rootRelationVerb(tree);
    if (verb === null) continue;
    const kind = CONFLICT_VERBS.has(verb) ? "conflict" : SUPPORT_VERBS.has(verb) ? "support" : null;
    if (kind === null) continue;
    for (const actionId of actionReferences(tree)) {
      if (kind === "conflict") signal(actionId).conflicts.push(id);
      else signal(actionId).supports.push(id);
    }
  }
  return signals;
}

/** Project each action's evidence from the active derived conclusions that
 * reference it. A conflict forbids the action; a support raises its strength. */
export class MemoryEvidenceReasoner implements EvidenceReasoner {
  readonly source = "memory";
  readonly #signals: Map<string, ActionSignal>;
  readonly #traces = new Map<string, ActionEvidenceTrace>();
  readonly #db = sharedGoalChainerMetta();

  constructor(memory: MemorySpace, scope: MemoryScope) {
    this.#signals = collectActionSignals(memory, scope);
  }

  /** The evidence traces built during projection, one per queried action. */
  traces(): ActionEvidenceTrace[] {
    return [...this.#traces.values()];
  }

  project(action: CandidateAction): EvidenceProjection {
    const stable = createCandidateAction(action);
    const signal = this.#signals.get(stable.id) ?? { conflicts: [], supports: [] };
    const forbidden = signal.conflicts.length > 0;
    // A conflict blocks through the deontic gate, independent of the score. A
    // support lifts an otherwise-default action above a bare candidate. With
    // neither, the action rests on its declared default.
    const supported = signal.supports.length > 0 && !forbidden;
    const strength = supported ? SUPPORTED_STRENGTH : stable.defaultStrength;
    const confidence = supported ? SUPPORTED_CONFIDENCE : stable.defaultConfidence;
    const deontic: DeonticStatus = forbidden ? "forbidden" : "unregulated";
    const proofs = [...signal.conflicts, ...signal.supports];
    const expectation = mettaOne(
      this.#db,
      "gc-evidence-expectation",
      mettaFloat(strength),
      mettaFloat(confidence),
    );
    if (typeof expectation !== "number" || !Number.isFinite(expectation)) {
      throw new Error("oh-my-goals.metta returned an invalid evidence expectation");
    }
    this.#traces.set(stable.id, {
      actionId: stable.id,
      strength,
      confidence,
      deontic,
      conflicts: Object.freeze([...signal.conflicts]),
      supports: Object.freeze([...signal.supports]),
    });
    return createEvidenceProjection({
      strength,
      confidence,
      source: this.source,
      projection: null,
      proofs,
      deontic,
      expectation,
    });
  }
}

function assertScope(scope: unknown): MemoryScope {
  if (typeof scope !== "string" || !MEMORY_SCOPES.includes(scope as MemoryScope)) {
    throw new RangeError(`scope must be one of: ${MEMORY_SCOPES.join(", ")}`);
  }
  return scope as MemoryScope;
}

/** Solve a decision from active memory: project the scenario and evidence, then
 * rank through the native DecisionEngine. Advice and automatic-execution
 * eligibility are reported separately. */
export function solveFromMemory(memory: MemorySpace, options: SolveOptions): SolveReceipt {
  const scope = assertScope(options.scope);
  const title = options.title ?? `Solve in ${scope} memory`;
  const projection = projectScenario(memory, scope, title);
  const reasoner = new MemoryEvidenceReasoner(memory, scope);
  const engine = new DecisionEngine(reasoner, options.motivationScores ?? {});
  const ranking = engine.rankWithReceipt(projection.scenario);

  const blockedActionIds = ranking.decisions
    .filter((decision) => decision.status === "blocked")
    .map((decision) => decision.actionId);
  // A single top-scorer leaves tiedActionIds a singleton; a genuine tie has more
  // than one leader. Recommend only a clear, unblocked, recommended winner.
  const isTie = ranking.tiedActionIds.length > 1;
  const leader = ranking.decisions[0];
  const recommended =
    leader !== undefined && leader.status === "recommended" && !isTie
      ? leader.actionId
      : null;

  // Order the evidence traces to match the ranked decisions for a stable receipt.
  const traceById = new Map(reasoner.traces().map((trace) => [trace.actionId, trace]));
  const evidence = ranking.decisions
    .map((decision) => traceById.get(decision.actionId))
    .filter((trace): trace is ActionEvidenceTrace => trace !== undefined);

  return {
    scope,
    ranking,
    recommended,
    automaticExecutionAllowed: ranking.automaticExecutionAllowed,
    tiedActionIds: ranking.tiedActionIds,
    blockedActionIds: Object.freeze(blockedActionIds),
    scenario: projection.scenario,
    evidence: Object.freeze(evidence),
    diagnostics: projection.diagnostics,
    provenance: projection.provenance,
  };
}
