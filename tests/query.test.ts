import { describe, expect, it } from "vitest";

import { typedMettaOf } from "../src/candidates.js";
import { TokenEmbeddingProvider } from "../src/embedding.js";
import type {
  AvailabilityReport,
  HyperbaseParse,
  HyperbaseParseBatch,
  HyperbaseParseItem,
  HyperbaseParser,
  ShAtom,
  ShEdge,
  ShNode,
  SpeechActMood,
} from "../src/hyperbase.js";
import { SemanticBackend } from "../src/semantic.js";
import { SemanticMemory } from "../src/semantic_memory.js";
import { InMemoryVectorIndex } from "../src/vector_index.js";
import { queryMemory } from "../src/query.js";

// SH-tree builders that mirror the real AlphaBeta output verified in
// ai-tmp/probe_query.ts. A shared subtree builder keeps the fixed arguments
// byte-identical between a question and its matching declarative, which is what
// the structural matcher relies on.
function atom(root: string, type: string, role = type): ShAtom {
  return { atom: true, atomStr: `${root}/${role}`, root, label: root, mainType: type[0]!, type, role };
}
function edge(type: string, mainType: string, argroles: string, connector: ShNode, children: ShNode[]): ShEdge {
  return { atom: false, edgeStr: `(${type})`, mainType, type, argroles, connector, children };
}
// (the (<mod> <noun>)), e.g. (the (public api))
function np(det: string, mod: string, noun: string): ShEdge {
  return edge("Cc", "C", "", atom(det, "Md"), [edge("Cc", "C", "", atom(mod, "Ma"), [atom(noun, "Cc")])]);
}
// (the <noun>), e.g. (the project)
function np1(det: string, noun: string): ShEdge {
  return edge("Cc", "C", "", atom(det, "Md"), [atom(noun, "Cc")]);
}
// (<verb>/Pv.so <subject> <object>)
function preserves(subject: ShNode, object: ShNode): ShEdge {
  return edge("Rv", "R", "so", atom("preserves", "Pv", "Pv.so"), [subject, object]);
}

const THE_PUBLIC_API = np("the", "public", "api");
const WHICH_ACTION = edge("C", "C", "am", atom("+", "B", "B.am"), [atom("which", "Ci"), atom("action", "Cc")]);
const WHAT = atom("what", "Cx");

// "Which database does the project use?" — object question with do-support: a
// relation whose argument is another relation. Not the supported subject form.
const WHICH_DATABASE_DOES = edge("Rv", "R", "x", atom("does", "Pv", "Pv.x"), [
  edge("Rv", "R", "os", atom("use", "Pv", "Pv.os"), [
    edge("C", "C", "am", atom("+", "B", "B.am"), [atom("which", "Ci"), atom("database", "Cc")]),
    np1("the", "project"),
  ]),
]);

function makeParse(tree: ShNode, mood: SpeechActMood): HyperbaseParse {
  return {
    text: "",
    tokens: [],
    sh: "",
    typedMetta: typedMettaOf(tree),
    rawMetta: "",
    tree,
    rootType: tree.type,
    rootMainType: tree.mainType,
    rootArgroles: tree.atom ? "" : tree.argroles,
    mood,
    polarity: "affirmative",
    interrogativeConcepts: [],
    coverage: { nTokens: 0, coveredPositions: [], uncoveredPositions: [], uncoveredTokens: [], contentComplete: true },
    diagnostics: {},
    failed: false,
    errors: [],
  };
}

function accepted(input: string, tree: ShNode, mood: SpeechActMood): HyperbaseParseItem {
  return { input, nParses: 1, parses: [makeParse(tree, mood)], quality: { accepted: true, reasons: [], rewriteFeedback: null }, error: null };
}
function rejected(input: string, reasons: string[], feedback: string): HyperbaseParseItem {
  return { input, nParses: 0, parses: [], quality: { accepted: false, reasons, rewriteFeedback: feedback }, error: null };
}

// A parser stub that returns canned parses keyed by question text, so the query
// pipeline can be exercised in CI without the Python parser.
class StubParser implements HyperbaseParser {
  readonly #items = new Map<string, HyperbaseParseItem>();
  register(item: HyperbaseParseItem): this {
    this.#items.set(item.input, item);
    return this;
  }
  async parse(statements: readonly string[]): Promise<HyperbaseParseBatch> {
    return {
      parser: "stub",
      spacyModel: "stub",
      items: statements.map(
        (input) => this.#items.get(input) ?? rejected(input, ["parse-failed"], "no canned parse"),
      ),
    };
  }
  async probe(): Promise<AvailabilityReport> {
    return { available: true, parser: "stub" };
  }
  async close(): Promise<void> {}
}

const WHICH_ACTION_Q = "Which action preserves the public API?";
const WHAT_Q = "What preserves the public API?";
const WHICH_DB_Q = "Which database does the project use?";

function parser(): StubParser {
  return new StubParser()
    .register(accepted(WHICH_ACTION_Q, preserves(WHICH_ACTION, THE_PUBLIC_API), "interrogative"))
    .register(accepted(WHAT_Q, preserves(WHAT, THE_PUBLIC_API), "interrogative"))
    .register(accepted(WHICH_DB_Q, WHICH_DATABASE_DOES, "interrogative"));
}

async function memoryWith(...facts: { content: string; tree: ShEdge }[]): Promise<SemanticMemory> {
  const backend = new SemanticBackend(new TokenEmbeddingProvider(256), new InMemoryVectorIndex());
  const memory = await SemanticMemory.open({ backend, repository: "demo" });
  for (const fact of facts) {
    await memory.remember({
      content: fact.content,
      scope: "project",
      kind: "observation",
      sources: [{ type: "tool", reference: "test", strength: 0.9, confidence: 0.8 }],
      tree: typedMettaOf(fact.tree),
      shTree: JSON.stringify(fact.tree),
      polarity: "affirmative",
    });
  }
  return memory;
}

describe("queryMemory exact structural path", () => {
  it("answers a subject WH-question by binding the questioned argument", async () => {
    const memory = await memoryWith({
      content: "The verified change preserves the public API.",
      tree: preserves(np("the", "verified", "change"), THE_PUBLIC_API),
    });
    const receipt = await queryMemory(parser(), memory, WHICH_ACTION_Q, { scope: "project" });

    expect(receipt.modes).toContain("exact");
    expect(receipt.answers).toHaveLength(1);
    const answer = receipt.answers[0]!;
    expect(answer.answerClass).toBe("exact");
    expect(answer.content).toBe("The verified change preserves the public API.");
    expect(answer.binding).toEqual({ role: "s", slotType: "action", value: "the verified change" });
    expect(answer.truth).toEqual({ strength: 0.9, confidence: 0.8 });
    memory.close();
  });

  it("binds a bare 'what' subject question the same way", async () => {
    const memory = await memoryWith({
      content: "The verified change preserves the public API.",
      tree: preserves(np("the", "verified", "change"), THE_PUBLIC_API),
    });
    const receipt = await queryMemory(parser(), memory, WHAT_Q, { scope: "project" });
    expect(receipt.answers[0]!.binding).toEqual({ role: "s", slotType: null, value: "the verified change" });
    memory.close();
  });

  it("returns every matching proposition and excludes non-matching relations", async () => {
    const memory = await memoryWith(
      { content: "The verified change preserves the public API.", tree: preserves(np("the", "verified", "change"), THE_PUBLIC_API) },
      { content: "The tested fix preserves the public API.", tree: preserves(np("the", "tested", "fix"), THE_PUBLIC_API) },
      // Different object: same relation, must not match "the public API" query.
      { content: "The hotfix preserves the build cache.", tree: preserves(np1("the", "hotfix"), np("the", "build", "cache")) },
    );
    const receipt = await queryMemory(parser(), memory, WHICH_ACTION_Q, { scope: "project", includeRelated: false });
    expect(receipt.answers.map((a) => a.binding!.value).sort()).toEqual(["the tested fix", "the verified change"]);
    memory.close();
  });

  it("does not match a relation with the same words in a different structure", async () => {
    // "The public API preserves the verified change." — object and subject swapped.
    const memory = await memoryWith({
      content: "The public API preserves the verified change.",
      tree: preserves(THE_PUBLIC_API, np("the", "verified", "change")),
    });
    const receipt = await queryMemory(parser(), memory, WHICH_ACTION_Q, { scope: "project", includeRelated: false });
    expect(receipt.answers).toEqual([]);
    memory.close();
  });
});

describe("queryMemory result classes", () => {
  it("labels a matched derived conclusion as reasoned with its proof path", async () => {
    const backend = new SemanticBackend(new TokenEmbeddingProvider(256), new InMemoryVectorIndex());
    const memory = await SemanticMemory.open({ backend, repository: "demo" });
    const premise = await memory.remember({
      content: "The change passed every test.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "tool", reference: "ci" }],
    });
    const conclusion = await memory.remember({
      content: "The verified change preserves the public API.",
      scope: "project",
      kind: "derived-conclusion",
      sources: [{ type: "tool", reference: "inference" }],
      tree: typedMettaOf(preserves(np("the", "verified", "change"), THE_PUBLIC_API)),
      shTree: JSON.stringify(preserves(np("the", "verified", "change"), THE_PUBLIC_API)),
      polarity: "affirmative",
    });
    await memory.addProof(conclusion.id, "rule-verified-preserves", [premise.id]);

    const receipt = await queryMemory(parser(), memory, WHICH_ACTION_Q, { scope: "project", includeRelated: false });
    expect(receipt.modes).toContain("reasoned");
    const answer = receipt.answers.find((a) => a.propositionId === conclusion.id)!;
    expect(answer.answerClass).toBe("reasoned");
    expect(answer.proofPaths).toHaveLength(1);
    expect(answer.proofPaths[0]!.rule).toBe("rule-verified-preserves");
    memory.close();
  });

  it("labels a semantic match related, never entailed, and never as an answer", async () => {
    const memory = await memoryWith(
      { content: "The verified change preserves the public API.", tree: preserves(np("the", "verified", "change"), THE_PUBLIC_API) },
      // Opposite polarity, semantically near: must surface as related, not an answer.
      { content: "The risky patch breaks the public API.", tree: edge("Rv", "R", "so", atom("breaks", "Pv", "Pv.so"), [np("the", "risky", "patch"), THE_PUBLIC_API]) },
    );
    const receipt = await queryMemory(parser(), memory, WHICH_ACTION_Q, { scope: "project" });
    expect(receipt.answers.map((a) => a.content)).toEqual(["The verified change preserves the public API."]);
    expect(receipt.related.map((r) => r.content)).toContain("The risky patch breaks the public API.");
    expect(receipt.related.every((r) => r.answerClass === "related")).toBe(true);
    // The antonym neighbour anchors on the shared object and carries its polarity,
    // but is never promoted past "related": the anchor asserts shared entities, not
    // agreement, since an embedding cannot tell "breaks" from "preserves".
    const breaks = receipt.related.find((r) => r.content.includes("breaks"))!;
    expect(breaks.anchoredEntities).toEqual(["the public api"]);
    expect(breaks.polarity).toBe("affirmative");
    memory.close();
  });

  it("anchors a paraphrased neighbour on shared entities but not a different-object one", async () => {
    const memory = await memoryWith(
      // Same object "the public API", paraphrased relation verb: anchors.
      { content: "The tested fix safeguards the public API.", tree: edge("Rv", "R", "so", atom("safeguards", "Pv", "Pv.so"), [np("the", "tested", "fix"), THE_PUBLIC_API]) },
      // Same relation and roles, different object: shares no questioned entity.
      { content: "The tested fix reworks the error handling.", tree: edge("Rv", "R", "so", atom("reworks", "Pv", "Pv.so"), [np("the", "tested", "fix"), np("the", "error", "handling")]) },
    );
    const receipt = await queryMemory(parser(), memory, WHICH_ACTION_Q, { scope: "project" });
    expect(receipt.answers).toEqual([]); // no exact "preserves" fact is stored
    const safeguard = receipt.related.find((r) => r.content.includes("safeguards"))!;
    expect(safeguard.anchoredEntities).toEqual(["the public api"]);
    expect(safeguard.answerClass).toBe("related");
    const rework = receipt.related.find((r) => r.content.includes("reworks"));
    if (rework !== undefined) expect(rework.anchoredEntities).toEqual([]);
    memory.close();
  });
});

describe("queryMemory unsupported and misuse", () => {
  it("reports no exact compilation for an object question and falls back to semantic", async () => {
    const memory = await memoryWith({ content: "The project uses PostgreSQL.", tree: edge("Rv", "R", "so", atom("uses", "Pv", "Pv.so"), [np1("the", "project"), atom("postgresql", "Cp")]) });
    const receipt = await queryMemory(parser(), memory, WHICH_DB_Q, { scope: "project" });
    expect(receipt.answers).toEqual([]);
    expect(receipt.unsupported).toContain("no-exact-compilation");
    expect(receipt.related.map((r) => r.content)).toContain("The project uses PostgreSQL.");
    // The question never compiled to a pattern, so no fixed entities exist to anchor on.
    expect(receipt.related.every((r) => r.anchoredEntities.length === 0)).toBe(true);
    memory.close();
  });

  it("guides the caller when a statement is submitted instead of a question", async () => {
    const memory = await memoryWith();
    const declarative = "The project uses PostgreSQL.";
    const stub = parser().register(accepted(declarative, edge("Rv", "R", "so", atom("uses", "Pv", "Pv.so"), [np1("the", "project"), atom("postgresql", "Cp")]), "declarative"));
    const receipt = await queryMemory(stub, memory, declarative, { scope: "project" });
    expect(receipt.answers).toEqual([]);
    expect(receipt.unsupported).toContain("not-a-question");
    expect(receipt.feedback).toContain("not a question");
    memory.close();
  });

  it("passes a parser rejection and its feedback through the receipt", async () => {
    const memory = await memoryWith();
    const stub = parser().register(rejected("blah blah", ["no-root-relation"], "Write one asserted proposition per sentence."));
    const receipt = await queryMemory(stub, memory, "blah blah", { scope: "project" });
    expect(receipt.normalizedQuery).toBeNull();
    expect(receipt.unsupported).toContain("no-root-relation");
    expect(receipt.feedback).toContain("one asserted proposition");
    memory.close();
  });

  it("reports the active semantic provider in the receipt", async () => {
    const memory = await memoryWith({ content: "The verified change preserves the public API.", tree: preserves(np("the", "verified", "change"), THE_PUBLIC_API) });
    const receipt = await queryMemory(parser(), memory, WHICH_ACTION_Q, { scope: "project" });
    expect(receipt.semantic?.embeddingProvider).toBe("Local");
    memory.close();
  });

  it("rejects an empty question", async () => {
    const memory = await memoryWith();
    await expect(queryMemory(parser(), memory, "   ", {})).rejects.toThrow(/must not be empty/);
    memory.close();
  });
});
