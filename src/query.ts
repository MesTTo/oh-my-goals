// Natural-language query over memory. A question is parsed, compiled to a
// structural pattern when its form allows, matched exactly against active
// propositions, and, in parallel, retrieved semantically. The three result
// classes stay distinct: an exact structural match and a match that rests on a
// stored proof are entailed; a semantic-only match is labeled related, never a
// proof. The receipt records how each answer was reached.
//
// The exact compiler targets the structurally explicit subject question, the
// plan's first target: "Which action preserves the public API?" parses to
// `(preserves/Pv.so (+/B.am which/Ci action/Cc) (the (public api)))`, which shares
// its relation and argument roles with the declarative "The verified change
// preserves the public API." Only the questioned argument differs, so the WH-slot
// becomes a free variable and the rest must match. Object questions that need
// do-support ("which database does the project use?") do not compile to this form;
// they fall through to semantic retrieval and are reported as unsupported for exact
// matching rather than answered wrongly.
//
// The semantic hits are then anchored with the same exact checks that mettabase's
// matchx runs alongside semmatch: each hit reports which of the question's fixed
// entities it asserts in the same argument role, plus its own polarity and kind. A
// hit that shares the entities but paraphrases the relation ("safeguards the public
// API") anchors; a merely topical neighbour does not. Whether a paraphrase agrees or
// contradicts is left to the caller, because an embedding cannot separate a synonym
// from an antonym, so the anchor never promotes a semantic hit to an answer.

import { labelsOf, typedMettaOf } from "./candidates.js";
import type { HyperbaseParser, Polarity, ShNode, SpeechActMood } from "./hyperbase.js";
import {
  MEMORY_SCOPES,
  type MemoryKind,
  type MemoryScope,
  type StoredDerivation,
  type StoredProposition,
  type StoredSource,
} from "./memory.js";
import type { SemanticConfig } from "./semantic.js";
import type { SemanticMemory } from "./semantic_memory.js";

export type AnswerClass = "exact" | "reasoned";

export interface QueryBinding {
  /** SH argument role the WH-slot filled, e.g. `s`. */
  readonly role: string;
  /** The noun the question constrained the answer to, e.g. `action`, or null for a bare "what". */
  readonly slotType: string | null;
  /** The phrase that filled the slot, e.g. `the verified change`. */
  readonly value: string;
}

export interface QueryAnswer {
  readonly propositionId: string;
  readonly content: string;
  readonly answerClass: AnswerClass;
  readonly binding: QueryBinding | null;
  /** Proof paths for a reasoned answer; empty for an exact one. */
  readonly proofPaths: readonly StoredDerivation[];
  readonly sources: readonly StoredSource[];
  /** Aggregate truth of the supporting sources, or null when unsourced. */
  readonly truth: { readonly strength: number; readonly confidence: number } | null;
}

export interface RelatedMatch {
  readonly propositionId: string;
  readonly content: string;
  readonly score: number;
  readonly answerClass: "related";
  /** The question's fixed entities this proposition asserts in the same role, when
   * the question compiled. Non-empty marks an anchored paraphrase (same entities and
   * roles, possibly a different relation verb) rather than a merely topical neighbour. */
  readonly anchoredEntities: readonly string[];
  /** Polarity of the stored assertion. Travels with the hit because embedding
   * similarity cannot tell a synonym from an antonym; the caller weighs it. */
  readonly polarity: Polarity;
  readonly kind: MemoryKind;
}

export interface QueryReceipt {
  readonly question: string;
  /** Typed-MeTTa rendering of the parsed question, or null when it did not parse. */
  readonly normalizedQuery: string | null;
  readonly mood: SpeechActMood | null;
  /** Which retrieval paths produced results. */
  readonly modes: readonly ("exact" | "reasoned" | "semantic")[];
  readonly answers: readonly QueryAnswer[];
  readonly related: readonly RelatedMatch[];
  /** Precise reasons a question, or part of it, could not be answered exactly. */
  readonly unsupported: readonly string[];
  /** Controlled-English rewrite guidance when the question was rejected or misclassified. */
  readonly feedback: string | null;
  /** Active semantic provider, model, and threshold, or null when running record-only. */
  readonly semantic: SemanticConfig | null;
}

export interface QueryOptions {
  /** Restrict the search to one memory scope. Default: every active proposition. */
  readonly scope?: MemoryScope;
  /** Also list semantic matches even when exact answers were found. Default true. */
  readonly includeRelated?: boolean;
}

interface QueryArg {
  readonly role: string;
  readonly node: ShNode;
  readonly isSlot: boolean;
  readonly slotType: string | null;
}

interface QueryPattern {
  readonly relationRoot: string;
  readonly argroles: string;
  readonly args: readonly QueryArg[];
  readonly slotIndex: number;
}

function isAtom(node: ShNode): node is Extract<ShNode, { atom: true }> {
  return node.atom;
}

/** Whether a subtree carries an interrogative concept: `Cx` (what/who) or `Ci` (which). */
function containsInterrogative(node: ShNode): boolean {
  if (isAtom(node)) return node.type === "Cx" || node.type === "Ci";
  if (containsInterrogative(node.connector)) return true;
  return node.children.some(containsInterrogative);
}

/** The head noun a WH-slot constrains to (`action` in "which action"), or null. */
function slotTypeOf(node: ShNode): string | null {
  if (isAtom(node)) return node.type.startsWith("C") && node.type !== "Cx" && node.type !== "Ci" ? node.label : null;
  for (const child of [...node.children]) {
    const found = slotTypeOf(child);
    if (found !== null) return found;
  }
  return null;
}

// Map the connector's argrole letters to the child arguments in order. AlphaBeta
// lists the arguments in the same order as the argrole string, so position i of
// the argroles names the role of child i.
function argsWithRoles(edge: Extract<ShNode, { atom: false }>): { role: string; node: ShNode }[] {
  const roles = edge.argroles;
  return edge.children.map((node, index) => ({ role: roles[index] ?? "?", node }));
}

/** Compile a parsed question tree to a one-slot structural pattern, or null when
 * its form is not the supported subject question (nested relation, do-support,
 * coordination, or a number of WH-slots other than one). */
function extractPattern(tree: ShNode): QueryPattern | null {
  if (isAtom(tree) || tree.mainType !== "R") return null;
  if (!isAtom(tree.connector)) return null;
  const relationRoot = tree.connector.root;
  const args = argsWithRoles(tree);
  const compiled: QueryArg[] = [];
  let slotIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const { role, node } = args[index]!;
    // A nested relation argument is do-support or a subordinate clause; not this form.
    if (!isAtom(node) && node.mainType === "R") return null;
    const isSlot = containsInterrogative(node);
    if (isSlot) {
      if (slotIndex !== -1) return null; // more than one questioned argument
      slotIndex = index;
    }
    compiled.push({ role, node, isSlot, slotType: isSlot ? slotTypeOf(node) : null });
  }
  if (slotIndex === -1) return null; // no questioned argument to bind
  return { relationRoot, argroles: tree.argroles, args: compiled, slotIndex };
}

/** Match a pattern against a proposition tree: same relation and roles, every fixed
 * argument structurally equal, the slot free. Returns the slot's filled subtree. */
function matchProposition(pattern: QueryPattern, propTree: ShNode): ShNode | null {
  if (isAtom(propTree) || propTree.mainType !== "R") return null;
  if (!isAtom(propTree.connector) || propTree.connector.root !== pattern.relationRoot) return null;
  if (propTree.argroles !== pattern.argroles) return null;
  if (propTree.children.length !== pattern.args.length) return null;
  for (let index = 0; index < pattern.args.length; index += 1) {
    const arg = pattern.args[index]!;
    const propChild = propTree.children[index]!;
    if (arg.isSlot) continue;
    if (typedMettaOf(arg.node) !== typedMettaOf(propChild)) return null;
  }
  return propTree.children[pattern.slotIndex]!;
}

/** The question's fixed-argument entities that a proposition asserts in the same
 * role position: the exact entity-and-role check composed onto a semmatch hit.
 * Relation identity is not required, so a proposition that paraphrases the verb
 * ("safeguards" for "preserves") still anchors on its shared entities. What the
 * differing relation means, agreement or contradiction, is not decided here: an
 * embedding cannot separate a synonym from an antonym, so the relation and polarity
 * travel with the hit for the caller to weigh rather than being ruled a proof. */
function anchoredEntities(pattern: QueryPattern, propTree: ShNode): string[] {
  if (isAtom(propTree) || propTree.mainType !== "R") return [];
  if (propTree.argroles !== pattern.argroles) return [];
  if (propTree.children.length !== pattern.args.length) return [];
  const matched: string[] = [];
  for (let index = 0; index < pattern.args.length; index += 1) {
    const arg = pattern.args[index]!;
    if (arg.isSlot) continue;
    if (typedMettaOf(arg.node) === typedMettaOf(propTree.children[index]!)) {
      matched.push(phraseOf(arg.node));
    }
  }
  return matched;
}

/** The phrase a subtree spells, e.g. `the verified change`. */
function phraseOf(node: ShNode): string {
  return labelsOf(node).join(" ");
}

function aggregateTruth(
  sources: readonly StoredSource[],
): { strength: number; confidence: number } | null {
  const active = sources.filter((source) => source.state === "active");
  if (active.length === 0) return null;
  // The strongest active source stands for the proposition's support, matching how
  // the lifecycle keeps a proposition alive on its best surviving assertion.
  return active.reduce(
    (best, source) => (source.strength > best.strength ? { strength: source.strength, confidence: source.confidence } : best),
    { strength: active[0]!.strength, confidence: active[0]!.confidence },
  );
}

function toAnswer(proposition: StoredProposition, binding: QueryBinding | null): QueryAnswer {
  const reasoned = proposition.kind === "derived-conclusion" && proposition.derivations.length > 0;
  return {
    propositionId: proposition.id,
    content: proposition.content,
    answerClass: reasoned ? "reasoned" : "exact",
    binding,
    proofPaths: reasoned ? proposition.derivations : [],
    sources: proposition.sources,
    truth: aggregateTruth(proposition.sources),
  };
}

// The exact and reasoned paths: compile, then match every active proposition in
// scope. A matched derived conclusion is reasoned (it rests on a stored proof); a
// matched stored fact is exact.
function exactAnswers(
  memory: SemanticMemory,
  pattern: QueryPattern,
  scope: MemoryScope | undefined,
): QueryAnswer[] {
  const ids = scope === undefined ? memory.activePropositions() : memory.activeInScope(scope);
  const answers: QueryAnswer[] = [];
  const slotRole = pattern.args[pattern.slotIndex]!.role;
  const slotType = pattern.args[pattern.slotIndex]!.slotType;
  for (const id of ids) {
    const proposition = memory.get(id);
    if (proposition === undefined || proposition.shTree === undefined) continue;
    const propTree = JSON.parse(proposition.shTree) as ShNode;
    const filled = matchProposition(pattern, propTree);
    if (filled === null) continue;
    answers.push(toAnswer(proposition, { role: slotRole, slotType, value: phraseOf(filled) }));
  }
  return answers;
}

/** Answer an English question against memory. Returns exact and reasoned answers
 * (entailed), semantically related matches (never a proof), and the receipt of how
 * each was reached. */
export async function queryMemory(
  parser: HyperbaseParser,
  memory: SemanticMemory,
  question: string,
  options: QueryOptions = {},
): Promise<QueryReceipt> {
  if (typeof question !== "string" || question.trim() === "") {
    throw new RangeError("query question must not be empty");
  }
  if (options.scope !== undefined && !MEMORY_SCOPES.includes(options.scope)) {
    throw new RangeError(`scope must be one of: ${MEMORY_SCOPES.join(", ")}`);
  }
  const scope = options.scope;
  const includeRelated = options.includeRelated ?? true;
  const semanticConfig = memory.config() ?? null;

  const batch = await parser.parse([question]);
  const item = batch.items[0]!;
  const base = {
    question,
    semantic: semanticConfig,
  } as const;

  if (!item.quality.accepted) {
    return {
      ...base,
      normalizedQuery: null,
      mood: null,
      modes: [],
      answers: [],
      related: [],
      unsupported: item.quality.reasons,
      feedback: item.quality.rewriteFeedback ?? null,
    };
  }

  const parse = item.parses[0]!;
  const normalizedQuery = parse.typedMetta;
  if (parse.mood !== "interrogative") {
    return {
      ...base,
      normalizedQuery,
      mood: parse.mood,
      modes: [],
      answers: [],
      related: [],
      unsupported: ["not-a-question"],
      feedback: `"${question}" reads as ${parse.mood}, not a question. Store a statement with remember; ask a question ending in "?".`,
    };
  }

  const pattern = extractPattern(parse.tree);
  const unsupported: string[] = [];
  let answers: QueryAnswer[] = [];
  if (pattern === null) {
    unsupported.push("no-exact-compilation");
  } else {
    answers = exactAnswers(memory, pattern, scope);
  }

  // Semantic retrieval runs when exact matching found nothing or was not possible,
  // and, when includeRelated is set, alongside exact answers to surface neighbours.
  const related: RelatedMatch[] = [];
  const runSemantic = includeRelated || answers.length === 0;
  if (runSemantic) {
    const entailed = new Set(answers.map((answer) => answer.propositionId));
    const searchScopes = scope === undefined ? [...MEMORY_SCOPES] : [scope];
    const bestByProposition = new Map<string, RelatedMatch>();
    for (const searchScope of searchScopes) {
      for (const hit of await memory.search(question, searchScope)) {
        if (entailed.has(hit.proposition.id)) continue;
        const existing = bestByProposition.get(hit.proposition.id);
        if (existing === undefined || hit.candidate.score > existing.score) {
          bestByProposition.set(hit.proposition.id, {
            propositionId: hit.proposition.id,
            content: hit.proposition.content,
            score: hit.candidate.score,
            answerClass: "related",
            anchoredEntities:
              pattern !== null && hit.proposition.shTree !== undefined
                ? anchoredEntities(pattern, JSON.parse(hit.proposition.shTree) as ShNode)
                : [],
            polarity: hit.proposition.polarity === "negated" ? "negated" : "affirmative",
            kind: hit.proposition.kind,
          });
        }
      }
    }
    related.push(...[...bestByProposition.values()].sort((a, b) => b.score - a.score));
  }

  const modes: ("exact" | "reasoned" | "semantic")[] = [];
  if (answers.some((answer) => answer.answerClass === "exact")) modes.push("exact");
  if (answers.some((answer) => answer.answerClass === "reasoned")) modes.push("reasoned");
  if (related.length > 0) modes.push("semantic");

  return {
    ...base,
    normalizedQuery,
    mood: parse.mood,
    modes,
    answers,
    related,
    unsupported,
    feedback: null,
  };
}
