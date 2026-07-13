import { describe, expect, it } from "vitest";

import {
  cosine,
  l2normalize,
  TokenEmbeddingProvider,
  tokenize,
} from "../src/embedding.js";
import {
  labelsOf,
  semanticCandidatesForEdge,
  propositionIdsOf,
  typedMettaOf,
} from "../src/candidates.js";
import {
  coercePolarity,
  scopeSpaceId,
  SemanticBackend,
  semanticCorroborations,
  semanticOptions,
} from "../src/semantic.js";
import type { ShAtom, ShEdge, ShNode } from "../src/hyperbase.js";
import {
  InMemoryVectorIndex,
  type EmbeddedCandidate,
  type SemanticCandidate,
} from "../src/vector_index.js";

const EMB = new TokenEmbeddingProvider(256);

function atom(root: string, type: string, role = type): ShAtom {
  return { atom: true, atomStr: `${root}/${role}`, root, label: root, mainType: type[0]!, type, role };
}
function edge(
  type: string,
  mainType: string,
  argroles: string,
  connector: ShNode,
  children: ShNode[],
): ShEdge {
  return { atom: false, edgeStr: `(${type})`, mainType, type, argroles, connector, children };
}

// (is/Pv.so (the/Md cat/Cc) happy/Ca)
const CAT_TREE: ShEdge = edge("Rv", "R", "so", atom("is", "Pv", "Pv.so"), [
  edge("Cc", "C", "", atom("the", "Md"), [atom("cat", "Cc")]),
  atom("happy", "Ca"),
]);

function candidate(overrides: Partial<SemanticCandidate>): SemanticCandidate {
  return {
    atom: "a",
    text: "the cat is happy",
    score: 0,
    spaceId: "omg:project:x",
    atomId: "p1:edge",
    unitType: "edge",
    edgeId: "p1",
    role: null,
    payload: {},
    ...overrides,
  };
}

function embedded(overrides: Partial<SemanticCandidate>): EmbeddedCandidate {
  const value = candidate(overrides);
  return { candidate: value, vector: EMB.embed(value.text) };
}

describe("token-hash embedding", () => {
  it("tokenizes on non-alphanumeric boundaries and lowercases", () => {
    expect(tokenize("The auth_refresh Test, FAILS!")).toEqual([
      "the",
      "auth",
      "refresh",
      "test",
      "fails",
    ]);
  });

  it("is deterministic and L2-normalized", () => {
    const a = EMB.embed("the public api must stay compatible");
    const b = EMB.embed("the public api must stay compatible");
    expect(a).toEqual(b);
    expect(cosine(a, a)).toBeCloseTo(1, 10);
    expect(a).toHaveLength(256);
  });

  it("is order-independent (bag of tokens)", () => {
    expect(EMB.embed("alpha beta gamma")).toEqual(EMB.embed("gamma alpha beta"));
  });

  it("returns a zero vector for text without tokens", () => {
    expect(EMB.embed("   !!!  ").every((x) => x === 0)).toBe(true);
  });

  it("scores overlapping text above disjoint text", () => {
    const query = EMB.embed("upgrade the database package");
    const near = EMB.embed("the database package upgrade plan");
    const far = EMB.embed("authentication token rotation policy");
    expect(cosine(query, near)).toBeGreaterThan(cosine(query, far));
  });

  it("rejects non-positive dimensions", () => {
    expect(() => new TokenEmbeddingProvider(0)).toThrow(/positive integer/);
  });

  it("normalizes a nonzero vector to unit length and leaves a zero vector at zero", () => {
    expect(cosine(l2normalize([3, 4]), l2normalize([3, 4]))).toBeCloseTo(1, 10);
    expect(l2normalize([0, 0])).toEqual([0, 0]);
  });
});

describe("in-memory vector index", () => {
  it("replaces a candidate with the same space and id, appends anonymous ones", () => {
    const index = new InMemoryVectorIndex();
    index.upsert([embedded({ atomId: "p1:edge", text: "first" })]);
    index.upsert([embedded({ atomId: "p1:edge", text: "second" })]);
    expect(index.size()).toBe(1);
    index.upsert([embedded({ atomId: null, text: "anon" })]);
    index.upsert([embedded({ atomId: null, text: "anon" })]);
    expect(index.size()).toBe(3);
  });

  it("hard-filters by space id and slices to top-k by descending score", () => {
    const index = new InMemoryVectorIndex();
    index.upsert([
      embedded({ atomId: "a", text: "upgrade the database package", spaceId: "omg:project:a" }),
      embedded({ atomId: "b", text: "rotate the authentication token", spaceId: "omg:project:a" }),
      embedded({ atomId: "c", text: "upgrade the database package", spaceId: "omg:project:b" }),
    ]);
    const hits = index.search({
      spaceId: "omg:project:a",
      vector: EMB.embed("upgrade database"),
      topK: 1,
      threshold: null,
      filters: {},
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.atomId).toBe("a");
  });

  it("matches filters against attributes then payload keys", () => {
    const index = new InMemoryVectorIndex();
    index.upsert([
      embedded({ atomId: "s", unitType: "source", text: "cat", epistemicKind: "goal", payload: { candidate_kind: "source" } }),
      embedded({ atomId: "e", unitType: "edge", text: "cat", polarity: "negated" }),
    ]);
    const vector = EMB.embed("cat");
    const search = (filters: Record<string, unknown>) =>
      index.search({ spaceId: "omg:project:x", vector, topK: 10, threshold: null, filters });
    expect(search({ unitType: "source" })).toHaveLength(1);
    expect(search({ polarity: "negated" })).toHaveLength(1);
    expect(search({ epistemicKind: "goal" })).toHaveLength(1);
    expect(search({ candidate_kind: "source" })).toHaveLength(1);
  });

  it("drops candidates below an explicit threshold", () => {
    const index = new InMemoryVectorIndex();
    index.upsert([embedded({ atomId: "a", text: "unrelated words entirely" })]);
    const hits = index.search({
      spaceId: "omg:project:x",
      vector: EMB.embed("nothing in common here"),
      topK: 10,
      threshold: 0.5,
      filters: {},
    });
    expect(hits).toEqual([]);
  });

  it("deletes candidates by id and reindexes for later upserts", () => {
    const index = new InMemoryVectorIndex();
    index.upsert([
      embedded({ atomId: "p1:edge", text: "cat" }),
      embedded({ atomId: "p1:source", text: "cat" }),
      embedded({ atomId: "p2:edge", text: "cat" }),
    ]);
    index.delete("omg:project:x", ["p1:edge", "p1:source"]);
    expect(index.size()).toBe(1);
    index.upsert([embedded({ atomId: "p2:edge", text: "dog" })]);
    expect(index.size()).toBe(1);
  });

  it("deletes every candidate of a proposition by edge id, scoped to the space", () => {
    const index = new InMemoryVectorIndex();
    index.upsert([
      embedded({ atomId: "p1:edge", edgeId: "p1", text: "cat" }),
      embedded({ atomId: "p1:arg:s:0", edgeId: "p1", text: "the cat" }),
      embedded({ atomId: "p2:edge", edgeId: "p2", text: "dog" }),
      embedded({ atomId: "p1:edge", edgeId: "p1", text: "cat", spaceId: "omg:project:other" }),
    ]);
    index.deleteByEdge("omg:project:x", ["p1"]);
    expect(index.size()).toBe(2);
    const remaining = index.search({
      spaceId: "omg:project:x",
      vector: EMB.embed("cat dog"),
      topK: 10,
      threshold: null,
      filters: {},
    });
    expect(remaining.map((c) => c.edgeId)).toEqual(["p2"]);
  });

  it("requires a positive top-k", () => {
    const index = new InMemoryVectorIndex();
    expect(() =>
      index.search({ spaceId: "x", vector: EMB.embed("a"), topK: 0, threshold: null, filters: {} }),
    ).toThrow(/positive integer/);
  });
});

describe("candidate decomposition", () => {
  it("emits the source, edge, subtree, connector, and argument units in order", () => {
    const candidates = semanticCandidatesForEdge({
      tree: CAT_TREE,
      edgeId: "p1",
      spaceId: "omg:project:x",
      sourceText: "The cat is happy.",
      polarity: "affirmative",
      epistemicKind: "observation",
    });
    expect(candidates.map((c) => c.atomId)).toEqual([
      "p1:source",
      "p1:edge",
      "p1:subtree:0",
      "p1:connector:0",
      "p1:arg:s:0",
      "p1:arg:o:1",
      "p1:subtree:1",
      "p1:connector:1",
      "p1:subtree:1:arg:UnknownRole:0",
    ]);
    const source = candidates[0]!;
    expect(source.unitType).toBe("source");
    expect(source.text).toBe("The cat is happy.");
    expect(source.polarity).toBe("affirmative");
    expect(source.epistemicKind).toBe("observation");
    const edgeUnit = candidates[1]!;
    expect(edgeUnit.text).toBe("is the cat happy");
    expect(edgeUnit.payload.tags).toEqual(["P", "v", "so"]);
    const argS = candidates.find((c) => c.atomId === "p1:arg:s:0")!;
    expect(argS.role).toBe("s");
    expect(argS.text).toBe("the cat");
  });

  it("renders typed MeTTa for atoms, edges, and nested subtrees", () => {
    expect(typedMettaOf(CAT_TREE)).toBe(
      '(sh (tag P v so ()) "is" (args ((arg s (sh (tag M d NoRoles ()) "the" ' +
        '(args ((arg UnknownRole (sh-atom (tag C c NoRoles ()) "cat")))))) ' +
        '(arg o (sh-atom (tag C a NoRoles ()) "happy")))))',
    );
    expect(labelsOf(CAT_TREE)).toEqual(["is", "the", "cat", "happy"]);
  });

  it("omits the source unit when no source text is given", () => {
    const candidates = semanticCandidatesForEdge({ tree: CAT_TREE, edgeId: "p1", spaceId: "s" });
    expect(candidates.some((c) => c.unitType === "source")).toBe(false);
  });

  it("maps candidate ids back to their proposition ids", () => {
    expect(propositionIdsOf(["p1:edge", "p1:arg:s:0", "p2:source"]).sort()).toEqual(["p1", "p2"]);
  });
});

describe("semantic backend", () => {
  function backend(): SemanticBackend {
    return new SemanticBackend(new TokenEmbeddingProvider(256), new InMemoryVectorIndex());
  }

  it("indexes a decomposition and retrieves it by paraphrase overlap", async () => {
    const be = backend();
    await be.indexProposition(
      semanticCandidatesForEdge({
        tree: CAT_TREE,
        edgeId: "p1",
        spaceId: "omg:project:x",
        sourceText: "The cat is happy.",
      }),
    );
    const hits = await be.search("omg:project:x", "is the cat happy", semanticOptions({ topK: 3 }));
    expect(hits.length).toBeGreaterThan(0);
    expect(propositionIdsOf(hits.map((h) => h.atomId!))).toContain("p1");
  });

  it("adds a string candidate and requires a positive score to match", async () => {
    const be = backend();
    await be.addCandidate("omg:user", "note-1", "prefer explicit types");
    expect(await be.matches("prefer explicit types", "prefer explicit types")).toBe(true);
    expect(await be.matches("prefer explicit types", "utterly different content")).toBe(false);
    expect(await be.score("alpha", "omega")).toBe(0);
    expect(await be.matches("alpha", "omega")).toBe(false);
  });

  it("removes indexed candidates", async () => {
    const be = backend();
    const cands = semanticCandidatesForEdge({ tree: CAT_TREE, edgeId: "p1", spaceId: "omg:project:x" });
    await be.indexProposition(cands);
    be.remove("omg:project:x", cands.map((c) => c.atomId!));
    expect(await be.search("omg:project:x", "cat", semanticOptions())).toEqual([]);
  });

  it("reports its active provider and index", () => {
    expect(backend().config()).toEqual({
      embeddingProvider: "Local",
      embeddingModel: "token-hash",
      dimensions: 256,
      index: "InMemory",
      defaultTopK: 10,
    });
  });

  it("maps scopes to distinct space ids", () => {
    expect(scopeSpaceId("user")).toBe("omg:user");
    expect(scopeSpaceId("project", { repositoryId: "repo-42" })).toBe("omg:project:repo-42");
    expect(scopeSpaceId("session", { sessionId: "s7" })).toBe("omg:session:s7");
    expect(scopeSpaceId("derived", { repositoryId: "repo-42" })).toBe("omg:derived:repo-42");
  });
});

describe("anchored corroboration", () => {
  it("corroborates only the true paraphrase, gated by anchor, polarity, threshold", async () => {
    const items = [
      { id: "s1", anchor: "berlin|germany", text: "is the capital of", polarity: 1 },
      { id: "s2", anchor: "berlin|germany", text: "is the capital city of", polarity: 1 },
      { id: "s3", anchor: "paris|france", text: "is the capital of", polarity: 1 },
      { id: "s4", anchor: "berlin|germany", text: "is not the capital of", polarity: -1 },
      { id: "s5", anchor: "berlin|germany", text: "is the largest city of", polarity: 1 },
    ];
    const pairs = await semanticCorroborations(EMB, items, 0.6);
    expect(pairs.map((p) => [p.a, p.b])).toEqual([["s1", "s2"]]);
  });

  it("coerces polarity from booleans, numbers, and text", () => {
    expect(coercePolarity(true)).toBe(1);
    expect(coercePolarity(-3)).toBe(-1);
    expect(coercePolarity("negative")).toBe(-1);
    expect(coercePolarity("yes")).toBe(1);
  });
});

// Byte-identical typed-MeTTa parity with the real parser's projection.
const realParserConfigured =
  (process.env.OH_MY_GOALS_METTABASE_DIR ?? "") !== "" &&
  (process.env.OH_MY_GOALS_HYPERBASE_PYTHON ?? "") !== "";

describe.skipIf(!realParserConfigured)("candidate rendering parity with the real parser", () => {
  it("reproduces the parser's typed projection for nested and edge-connector trees", async () => {
    const { createHyperbaseParser } = await import("../src/hyperbase.js");
    const parser = createHyperbaseParser();
    try {
      const batch = await parser.parse([
        "The user requires that the public API remains compatible.",
        "Does action upgrade_database modify the authentication module?",
        "The command npm run build writes dist/index.js.",
      ]);
      for (const item of batch.items) {
        const parse = item.parses[0]!;
        expect(typedMettaOf(parse.tree)).toBe(parse.typedMetta);
      }
    } finally {
      await parser.close();
    }
  });
});
