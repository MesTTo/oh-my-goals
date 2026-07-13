import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  AlphaBetaHyperbaseParser,
  appendContract,
  CONTROLLED_ENGLISH_CONTRACT,
  createHyperbaseParser,
  HyperbaseUnavailableError,
  HyperbaseWorkerError,
  type AlphaBetaConfig,
  type HyperbaseParser,
  type ShAtom,
  type ShNode,
} from "../src/hyperbase.js";
import { ingestStatements } from "../src/ingest.js";
import { createMemorySpace } from "../src/memory.js";
import { TokenEmbeddingProvider } from "../src/embedding.js";
import { InMemoryVectorIndex } from "../src/vector_index.js";
import { propositionIdsOf } from "../src/candidates.js";
import { SemanticBackend, semanticOptions } from "../src/semantic.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE_WORKER = join(ROOT, "tests", "fixtures", "hb-fake-worker.mjs");

const open: AlphaBetaHyperbaseParser[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((parser) => parser.close()));
});

function fake(mode: string, extra: Partial<AlphaBetaConfig> = {}): AlphaBetaHyperbaseParser {
  const parser = new AlphaBetaHyperbaseParser({
    pythonPath: process.execPath,
    mettabaseDir: ROOT,
    workerScript: FAKE_WORKER,
    env: { FAKE_MODE: mode },
    ...extra,
  });
  open.push(parser);
  return parser;
}

function atomsOf(tree: ShNode): ShAtom[] {
  if (tree.atom) return [tree];
  return [tree.connector, ...tree.children].flatMap(atomsOf);
}

describe("adapter availability and configuration", () => {
  it("probes an available worker and reports its model", async () => {
    expect(await fake("ok").probe()).toEqual({
      available: true,
      parser: "alphabeta",
      spacyModel: "fake-en",
    });
  });

  it("reports unavailable and fails closed when unconfigured", async () => {
    const saved = {
      python: process.env.OH_MY_GOALS_HYPERBASE_PYTHON,
      dir: process.env.OH_MY_GOALS_METTABASE_DIR,
    };
    delete process.env.OH_MY_GOALS_HYPERBASE_PYTHON;
    delete process.env.OH_MY_GOALS_METTABASE_DIR;
    try {
      const parser = new AlphaBetaHyperbaseParser({});
      const report = await parser.probe();
      expect(report.available).toBe(false);
      expect(report.error).toMatch(/not configured/);
      await expect(parser.parse(["The subject adds the object."])).rejects.toBeInstanceOf(
        HyperbaseUnavailableError,
      );
    } finally {
      if (saved.python !== undefined) process.env.OH_MY_GOALS_HYPERBASE_PYTHON = saved.python;
      if (saved.dir !== undefined) process.env.OH_MY_GOALS_METTABASE_DIR = saved.dir;
    }
  });

  it("reports unavailable when the worker reports no model", async () => {
    const report = await fake("probe-nomodel").probe();
    expect(report.available).toBe(false);
    expect(report.error).toMatch(/no spaCy model/);
  });

  it("reports unavailable when the interpreter cannot be spawned", async () => {
    const report = await fake("ok", { pythonPath: join(ROOT, "no-such-interpreter") }).probe();
    expect(report.available).toBe(false);
    expect(report.error).toBeDefined();
  });
});

describe("adapter interpretation and quality gate (fake worker)", () => {
  it("accepts a declarative proposition and derives its facts", async () => {
    const batch = await fake("ok").parse(["The subject adds the object."]);
    expect(batch.spacyModel).toBe("fake-en");
    const item = batch.items[0]!;
    expect(item.quality.accepted).toBe(true);
    expect(item.quality.reasons).toEqual([]);
    const parse = item.parses[0]!;
    expect(parse.mood).toBe("declarative");
    expect(parse.polarity).toBe("affirmative");
    expect(parse.coverage.contentComplete).toBe(true);
    expect(parse.typedMetta).toContain("(sh (tag P v so ())");
  });

  it("marks a negated proposition through an Mn modifier", async () => {
    const batch = await fake("negated").parse(["The implementation adds no dependency."]);
    expect(batch.items[0]!.parses[0]!.polarity).toBe("negated");
  });

  it("keeps a declarative that carries a misclassified Ci concept declarative", async () => {
    const parse = (await fake("ci-declarative").parse(["x"])).items[0]!.parses[0]!;
    expect(parse.mood).toBe("declarative");
    expect(parse.interrogativeConcepts).toContain("that");
    expect((await fake("ci-declarative").parse(["x"])).items[0]!.quality.accepted).toBe(true);
  });

  it("recovers interrogative mood from a trailing question mark", async () => {
    const parse = (await fake("interrogative").parse(["Which action preserves it?"]))
      .items[0]!.parses[0]!;
    expect(parse.mood).toBe("interrogative");
  });

  it("recovers imperative mood from a subjectless object relation", async () => {
    const parse = (await fake("imperative").parse(["Upgrade the package."]))
      .items[0]!.parses[0]!;
    expect(parse.mood).toBe("imperative");
  });

  it("rejects coordination that parses to a non-relation root", async () => {
    const item = (await fake("coordination").parse(["The build passes and the tests fail."]))
      .items[0]!;
    expect(item.quality.accepted).toBe(false);
    expect(item.quality.reasons).toContain("no-root-relation");
    expect(item.quality.rewriteFeedback).toContain("controlled-English contract");
  });

  it("rejects a bare-atom root as not a proposition", async () => {
    const item = (await fake("atom-root").parse(["Database."])).items[0]!;
    expect(item.quality.reasons).toContain("no-root-relation");
  });

  it("rejects a statement that splits into several clauses", async () => {
    const item = (await fake("multiple-clauses").parse(["A. B."])).items[0]!;
    expect(item.nParses).toBe(2);
    expect(item.quality.reasons).toContain("multiple-clauses");
  });

  it("rejects and surfaces a per-sentence parser error", async () => {
    const item = (await fake("parser-error-item").parse(["???"])).items[0]!;
    expect(item.error).toMatch(/ValueError/);
    expect(item.quality.reasons).toContain("parser-error");
  });

  it("rejects a parse that leaves content tokens uncovered", async () => {
    const item = (await fake("incomplete-coverage").parse(["The subject adds leftover."]))
      .items[0]!;
    expect(item.parses[0]!.coverage.contentComplete).toBe(false);
    expect(item.quality.reasons).toContain("incomplete-coverage");
  });

  it("rejects a failed parse and a diagnostics-bearing parse", async () => {
    expect((await fake("failed-parse").parse(["x"])).items[0]!.quality.reasons).toContain(
      "parse-failed",
    );
    expect((await fake("diagnostics").parse(["x"])).items[0]!.quality.reasons).toContain(
      "structural-diagnostics",
    );
  });
});

describe("adapter worker-protocol failures", () => {
  it("throws when the worker returns a failure", async () => {
    await expect(fake("worker-error").parse(["x"])).rejects.toThrow(/model missing/);
  });

  it("throws when the worker emits an unknown atom main type", async () => {
    await expect(fake("malformed-tree").parse(["x"])).rejects.toBeInstanceOf(HyperbaseWorkerError);
  });

  it("throws when the worker emits non-JSON output", async () => {
    await expect(fake("badjson").parse(["x"])).rejects.toThrow(/non-JSON/);
  });

  it("throws when the worker crashes", async () => {
    await expect(fake("crash").parse(["x"])).rejects.toThrow(/exited/);
  });

  it("times out and reports the budget", async () => {
    await expect(fake("hang", { requestTimeoutMs: 300 }).parse(["x"])).rejects.toThrow(
      /timed out after 300 ms/,
    );
  });

  it("stays resident across a logical worker failure", async () => {
    const parser = fake("worker-error");
    await expect(parser.parse(["x"])).rejects.toThrow(/model missing/);
    await expect(parser.parse(["y"])).rejects.toThrow(/model missing/);
  });
});

describe("adapter request serialization and lifecycle", () => {
  it("serializes concurrent requests and maps each response to its request", async () => {
    const parser = fake("ok");
    const [a, b] = await Promise.all([parser.parse(["a"]), parser.parse(["b"])]);
    expect(a.items[0]!.input).toBe("a");
    expect(b.items[0]!.input).toBe("b");
  });

  it("reuses one resident worker for sequential requests", async () => {
    const parser = fake("ok");
    expect((await parser.parse(["first"])).items[0]!.quality.accepted).toBe(true);
    expect((await parser.parse(["second"])).items[0]!.quality.accepted).toBe(true);
  });

  it("closes idempotently and refuses work afterward", async () => {
    const parser = new AlphaBetaHyperbaseParser({
      pythonPath: process.execPath,
      mettabaseDir: ROOT,
      workerScript: FAKE_WORKER,
      env: { FAKE_MODE: "ok" },
    });
    expect((await parser.parse(["x"])).items[0]!.quality.accepted).toBe(true);
    await parser.close();
    await parser.close();
    await expect(parser.parse(["x"])).rejects.toBeInstanceOf(HyperbaseUnavailableError);
  });

  it("validates its statement input", async () => {
    const parser = fake("ok");
    await expect(parser.parse("nope" as never)).rejects.toThrow(/must be an array/);
    await expect(parser.parse([123 as never])).rejects.toThrow(/must be a string/);
  });
});

describe("controlled-English contract", () => {
  it("exposes the nine ingestion rules", () => {
    expect(CONTROLLED_ENGLISH_CONTRACT).toHaveLength(9);
    expect(CONTROLLED_ENGLISH_CONTRACT).toContain(
      "Do not combine several independent claims with coordination.",
    );
  });

  it("appends every rule to rewrite guidance", () => {
    const message = appendContract("Rejected.");
    expect(message).toContain("Rejected.");
    for (const rule of CONTROLLED_ENGLISH_CONTRACT) {
      expect(message).toContain(rule);
    }
  });

  it("exports a default factory that builds the AlphaBeta parser", () => {
    const parser: HyperbaseParser = createHyperbaseParser();
    expect(parser).toBeInstanceOf(AlphaBetaHyperbaseParser);
  });
});

describe("memory ingestion through the parser (fake worker)", () => {
  it("stores an admissible declarative with its real tree and marks it active", async () => {
    const memory = createMemorySpace();
    const [result] = await ingestStatements(fake("ok"), memory, [
      {
        content: "The subject adds the object.",
        scope: "project",
        kind: "observation",
        sources: [{ type: "tool", reference: "review" }],
      },
    ]);
    expect(result!.stored).toBe(true);
    if (result!.stored) {
      expect(memory.isActive(result!.proposition.id)).toBe(true);
      expect(result!.proposition.tree).toBe(result!.tree);
      expect(memory.activeInScope("project")).toEqual([result!.proposition.id]);
    }
  });

  it("refuses to store a question as an assertion", async () => {
    const memory = createMemorySpace();
    const [result] = await ingestStatements(fake("interrogative"), memory, [
      {
        content: "Which action preserves it?",
        scope: "project",
        kind: "observation",
        sources: [{ type: "user", reference: "q" }],
      },
    ]);
    expect(result!.stored).toBe(false);
    if (!result!.stored) expect(result!.reasons).toContain("interrogative-not-assertion");
    expect(memory.activeInScope("project")).toEqual([]);
  });

  it("stores an imperative as a goal but refuses it for other kinds", async () => {
    const memory = createMemorySpace();
    const asGoal = await ingestStatements(fake("imperative"), memory, [
      {
        content: "Upgrade the package.",
        scope: "project",
        kind: "goal",
        sources: [{ type: "user", reference: "ask" }],
      },
    ]);
    expect(asGoal[0]!.stored).toBe(true);

    const asObservation = await ingestStatements(fake("imperative"), memory, [
      {
        content: "Upgrade the package.",
        scope: "project",
        kind: "observation",
        sources: [{ type: "user", reference: "ask" }],
      },
    ]);
    expect(asObservation[0]!.stored).toBe(false);
    if (!asObservation[0]!.stored) {
      expect(asObservation[0]!.reasons).toContain("imperative-requires-goal-kind");
    }
  });

  it("returns rewrite feedback and stores nothing for coordination", async () => {
    const memory = createMemorySpace();
    const [result] = await ingestStatements(fake("coordination"), memory, [
      {
        content: "The build passes and the tests fail.",
        scope: "project",
        kind: "observation",
        sources: [{ type: "tool", reference: "ci" }],
      },
    ]);
    expect(result!.stored).toBe(false);
    if (!result!.stored) {
      expect(result!.reasons).toContain("no-root-relation");
      expect(result!.feedback).toContain("Write one asserted proposition per sentence.");
    }
  });

  it("indexes a stored proposition's candidates into a semantic backend", async () => {
    const memory = createMemorySpace();
    const backend = new SemanticBackend(new TokenEmbeddingProvider(256), new InMemoryVectorIndex());
    const [result] = await ingestStatements(
      fake("ok"),
      memory,
      [
        {
          content: "The subject adds the object.",
          scope: "project",
          kind: "observation",
          sources: [{ type: "tool", reference: "review" }],
        },
      ],
      { backend, identity: { repositoryId: "repo-1" } },
    );
    expect(result!.stored).toBe(true);
    if (result!.stored) {
      const hits = await backend.search("omg:project:repo-1", "the subject adds the object", semanticOptions());
      expect(propositionIdsOf(hits.map((h) => h.atomId!))).toContain(result!.proposition.id);
    }
  });

  it("validates ingestion input", async () => {
    const memory = createMemorySpace();
    await expect(
      ingestStatements(fake("ok"), memory, [
        { content: "  ", scope: "project", kind: "observation", sources: [] },
      ]),
    ).rejects.toThrow(/content must not be empty/);
    await expect(
      ingestStatements(fake("ok"), memory, [
        { content: "A.", scope: "nowhere" as never, kind: "observation", sources: [] },
      ]),
    ).rejects.toThrow(/scope must be one of/);
  });
});

// The real AlphaBeta parser needs a mettabase checkout, a Python interpreter with
// spaCy en_core_web_trf and the atomizer, and several GB of RAM. These run only
// when OH_MY_GOALS_METTABASE_DIR and OH_MY_GOALS_HYPERBASE_PYTHON point at them,
// mirroring the pinned-source parity gate.
const realParserConfigured =
  (process.env.OH_MY_GOALS_METTABASE_DIR ?? "") !== "" &&
  (process.env.OH_MY_GOALS_HYPERBASE_PYTHON ?? "") !== "";

describe.skipIf(!realParserConfigured)("real AlphaBeta parser fixtures", () => {
  let parser: HyperbaseParser;

  beforeAll(async () => {
    parser = createHyperbaseParser();
    const report = await parser.probe();
    if (!report.available) {
      throw new Error(`HyperBase parser configured but unavailable: ${report.error}`);
    }
    return async () => {
      await parser.close();
    };
  });

  async function only(statement: string) {
    const batch = await parser.parse([statement]);
    return batch.items[0]!;
  }

  it("accepts a subject-predicate-object observation and keeps code identifiers whole", async () => {
    const item = await only("The test auth_refresh fails after action upgrade_database.");
    expect(item.quality.accepted).toBe(true);
    const roots = atomsOf(item.parses[0]!.tree).map((atom) => atom.root);
    expect(roots).toContain("auth_refresh");
    expect(roots).toContain("upgrade_database");
  });

  it("preserves a nested that-complement without collapsing attribution", async () => {
    const item = await only("The user requires that the public API remains compatible.");
    expect(item.quality.accepted).toBe(true);
    const atoms = atomsOf(item.parses[0]!.tree);
    expect(atoms.some((atom) => atom.root === "requires")).toBe(true);
    expect(atoms.some((atom) => atom.type === "Tx" && atom.root === "that")).toBe(true);
    expect(atoms.some((atom) => atom.root === "remains")).toBe(true);
  });

  it("keeps an agent hypothesis attributed to the agent", async () => {
    const item = await only("The agent hypothesizes that action deploy_preview is acceptable.");
    expect(item.quality.accepted).toBe(true);
    expect(item.parses[0]!.tree.atom).toBe(false);
    const connector = (item.parses[0]!.tree as { connector: ShAtom }).connector;
    expect(connector.root).toBe("hypothesizes");
  });

  it("accepts evidence for a nested conclusion and reads it as declarative", async () => {
    const item = await only(
      "The test output supports the proposition that action deploy_preview is acceptable.",
    );
    expect(item.quality.accepted).toBe(true);
    expect(item.parses[0]!.mood).toBe("declarative");
  });

  it("detects negation as negated polarity", async () => {
    const item = await only("The implementation adds no dependency.");
    expect(item.quality.accepted).toBe(true);
    expect(item.parses[0]!.polarity).toBe("negated");
  });

  it("reads a which-question as interrogative and surfaces the concept", async () => {
    const item = await only("Which action preserves the public API?");
    expect(item.parses[0]!.mood).toBe("interrogative");
    expect(item.parses[0]!.interrogativeConcepts).toContain("which");
  });

  it("reads a yes-or-no question as interrogative", async () => {
    const item = await only("Does action upgrade_database modify the authentication module?");
    expect(item.parses[0]!.mood).toBe("interrogative");
  });

  it("reads an imperative as imperative mood", async () => {
    const item = await only("Upgrade the database package.");
    expect(item.parses[0]!.mood).toBe("imperative");
  });

  it("rejects ambiguous coordination as not a single proposition", async () => {
    const item = await only("The build passes and the tests fail.");
    expect(item.quality.accepted).toBe(false);
    expect(item.quality.reasons).toContain("no-root-relation");
  });

  it("keeps code symbols, paths, and commands through the parse", async () => {
    const item = await only("The command npm run build writes dist/index.js.");
    expect(item.quality.accepted).toBe(true);
    const parse = item.parses[0]!;
    const atoms = atomsOf(parse.tree);
    expect(atoms.some((atom) => atom.root === "npm")).toBe(true);
    expect(atoms.some((atom) => atom.label === "index.js")).toBe(true);
    expect(parse.coverage.contentComplete).toBe(true);
  });

  it("ingests a real declarative into memory and rejects a real question", async () => {
    const memory = createMemorySpace();
    const results = await ingestStatements(parser, memory, [
      {
        content: "The user requires that the public API remains compatible.",
        scope: "project",
        kind: "user-statement",
        sources: [{ type: "user", reference: "request" }],
      },
      {
        content: "Which action preserves the public API?",
        scope: "project",
        kind: "observation",
        sources: [{ type: "user", reference: "request" }],
      },
    ]);
    expect(results[0]!.stored).toBe(true);
    expect(results[1]!.stored).toBe(false);
    if (results[0]!.stored) {
      expect(memory.isActive(results[0]!.proposition.id)).toBe(true);
      expect(results[0]!.proposition.tree).toContain("(sh (tag P v so ())");
    }
    expect(memory.activeInScope("project")).toHaveLength(1);
  });
});
