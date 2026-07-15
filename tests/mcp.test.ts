import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryDurableStore } from "../src/durable_store.js";
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
import { typedMettaOf } from "../src/candidates.js";
import type { ClaimExtractor, ExtractionResult } from "../src/extractor.js";
import { createMemoryMcpServer, createMemoryRuntime, type MemoryRuntime } from "../src/mcp.js";
import type { ParsedPaper, RawCandidate, ResearchWorker, RetractionRecord, SearchOptions } from "../src/research.js";

// Minimal SH-tree builders and a canned parser, so the server can be exercised in
// CI without the Python parser.
function atom(root: string, type: string): ShAtom {
  return { atom: true, atomStr: `${root}/${type}`, root, label: root, mainType: type[0]!, type, role: type };
}
function edge(type: string, mainType: string, argroles: string, connector: ShNode, children: ShNode[]): ShEdge {
  return { atom: false, edgeStr: "()", mainType, type, argroles, connector, children };
}
function plus(type: string, id: string): ShEdge {
  return edge("C", "C", "am", atom("+", "B"), [atom(type, "Cc"), atom(id, "Cc")]);
}
function np1(det: string, noun: string): ShEdge {
  return edge("Cc", "C", "", atom(det, "Md"), [atom(noun, "Cc")]);
}
function relation(verb: string, subject: ShNode, object: ShNode): ShEdge {
  return edge("Rv", "R", "so", atom(verb, "Pv"), [subject, object]);
}
const WHICH_ACTION = edge("C", "C", "am", atom("+", "B"), [atom("which", "Ci"), atom("action", "Cc")]);

function makeParse(tree: ShNode, mood: SpeechActMood, polarity: "affirmative" | "negated"): HyperbaseParse {
  return {
    text: "", tokens: [], sh: "", typedMetta: typedMettaOf(tree), rawMetta: "", tree,
    rootType: tree.type, rootMainType: tree.mainType, rootArgroles: tree.atom ? "" : tree.argroles,
    mood, polarity, interrogativeConcepts: [],
    coverage: { nTokens: 0, coveredPositions: [], uncoveredPositions: [], uncoveredTokens: [], contentComplete: true },
    diagnostics: {}, failed: false, errors: [],
  };
}
function accepted(input: string, tree: ShNode, mood: SpeechActMood, polarity: "affirmative" | "negated" = "affirmative"): HyperbaseParseItem {
  return { input, nParses: 1, parses: [makeParse(tree, mood, polarity)], quality: { accepted: true, reasons: [], rewriteFeedback: null }, error: null };
}
function rejected(input: string): HyperbaseParseItem {
  return { input, nParses: 0, parses: [], quality: { accepted: false, reasons: ["no-root-relation"], rewriteFeedback: "Write one asserted proposition per sentence." }, error: null };
}

const GOAL = "The user requires that the public API remains compatible.";
const ACT_A = "Action a_upgrade updates the database package.";
const ACT_B = "Action a_adapter updates the database package.";
const SUP_A = "Action a_upgrade satisfies the goal.";
const SUP_B = "Action a_adapter satisfies the goal.";
const OBS = "The test fails after action a_upgrade.";
const CONFLICT = "Action a_upgrade conflicts with the constraint.";
const QUESTION = "Which action updates the database package?";
const REVISED_GOAL = "The user requires that the public API stays stable.";
const REVIEW_A = "The reviewer approved a_upgrade.";
const REVIEW_B = "The reviewer approved a_adapter.";
const BAD = "Do this and that and everything at once.";
const CLAIM = "The transformer improves translation.";
const CLAIM2 = "The transformer reduces the cost.";
// A claim the extractor proposes that the stub parser rejects until it is rewritten.
const NEEDS_REWRITE = "needs a rewrite before it will parse";
const NEVER_PARSES = "never parses no matter what";

class StubParser implements HyperbaseParser {
  readonly #items = new Map<string, HyperbaseParseItem>();
  constructor() {
    const put = (item: HyperbaseParseItem) => this.#items.set(item.input, item);
    put(accepted(GOAL, relation("requires", np1("the", "user"), np1("the", "api")), "declarative"));
    put(accepted(ACT_A, relation("updates", plus("action", "a_upgrade"), np1("the", "package")), "declarative"));
    put(accepted(ACT_B, relation("updates", plus("action", "a_adapter"), np1("the", "package")), "declarative"));
    put(accepted(SUP_A, relation("satisfies", plus("action", "a_upgrade"), np1("the", "goal")), "declarative"));
    put(accepted(SUP_B, relation("satisfies", plus("action", "a_adapter"), np1("the", "goal")), "declarative"));
    put(accepted(OBS, relation("fails", np1("the", "test"), plus("action", "a_upgrade")), "declarative"));
    put(accepted(CONFLICT, relation("conflicts", plus("action", "a_upgrade"), np1("the", "constraint")), "declarative"));
    put(accepted(QUESTION, relation("updates", WHICH_ACTION, np1("the", "package")), "interrogative"));
    put(accepted(REVISED_GOAL, relation("requires", np1("the", "user"), np1("the", "api")), "declarative"));
    put(accepted(REVIEW_A, relation("approved", np1("the", "reviewer"), plus("action", "a_upgrade")), "declarative"));
    put(accepted(REVIEW_B, relation("approved", np1("the", "reviewer"), plus("action", "a_adapter")), "declarative"));
    put(accepted(CLAIM, relation("improves", plus("model", "transformer"), np1("the", "translation")), "declarative"));
    put(accepted(CLAIM2, relation("reduces", plus("model", "transformer"), np1("the", "cost")), "declarative"));
    put(rejected(BAD));
  }
  async parse(statements: readonly string[]): Promise<HyperbaseParseBatch> {
    return { parser: "stub", spacyModel: "stub", items: statements.map((input) => this.#items.get(input) ?? rejected(input)) };
  }
  async probe(): Promise<AvailabilityReport> {
    return { available: true, parser: "stub" };
  }
  async close(): Promise<void> {}
}

// A canned research worker: a few papers and a mutable retracted set, so a test
// can flip a work to retracted and drive check_retractions without the network.
class StubResearchWorker implements ResearchWorker {
  readonly papers = new Map<string, ParsedPaper>();
  readonly retracted = new Set<string>();
  constructor() {
    this.papers.set("1706.03762", {
      metadata: { title: "Attention Is All You Need", arxivId: "1706.03762", authors: ["Vaswani"], year: 2017, abstract: "The Transformer." },
      sections: [{ heading: "Introduction", text: "We propose the Transformer." }],
      references: [{ raw: "Bahdanau et al. 2015", doi: "10.1/prior" }],
    });
    this.papers.set("10.1/bad", {
      metadata: { title: "A Contested Result", doi: "10.1/bad", authors: ["B. Author"], year: 2019 },
      sections: [],
      references: [],
    });
  }
  async fetchAndParse(id: string): Promise<ParsedPaper> {
    const paper = this.papers.get(id);
    if (paper === undefined) throw new Error(`no such paper: ${id}`);
    return paper;
  }
  async retractionStatus(dois: readonly string[]): Promise<readonly RetractionRecord[]> {
    return dois.map((doi) =>
      this.retracted.has(doi) ? { doi, status: "retracted" as const, notice: `${doi}-notice` } : { doi, status: "active" as const },
    );
  }
  // The Attention paper is returned by both sources (so ranking must fuse and
  // dedup it), the contested result by one source only.
  async search(_query: string, _options?: SearchOptions): Promise<readonly RawCandidate[]> {
    return [
      { metadata: { title: "Attention Is All You Need", arxivId: "1706.03762" }, source: "semanticScholar", citationCount: 100000 },
      {
        metadata: { title: "Attention Is All You Need", doi: "10.1/attn", arxivId: "1706.03762", openAlexId: "W1" },
        source: "openAlex",
        citationCount: 99000,
      },
      { metadata: { title: "A Contested Result", doi: "10.1/bad" }, source: "openAlex", citationCount: 5 },
    ];
  }
  async close(): Promise<void> {}
}

// A scripted extractor: it proposes one claim the parser accepts, one that only
// parses after a rewrite, and one that never parses. So a test drives the whole
// propose -> validate -> rewrite -> drop loop without a live model.
class StubClaimExtractor implements ClaimExtractor {
  readonly model = "stub-llm";
  extractCalls = 0;
  rewriteCalls = 0;
  async extract(): Promise<ExtractionResult> {
    this.extractCalls += 1;
    return {
      model: this.model,
      claims: [
        { text: CLAIM, locator: { section: "Results", quote: "BLEU rose" }, confidence: 0.9 },
        { text: NEEDS_REWRITE, locator: { section: "Abstract", quote: "the cost falls" }, confidence: 0.6 },
        { text: NEVER_PARSES, locator: { section: "Intro", quote: "unparseable" }, confidence: 0.3 },
      ],
    };
  }
  async rewrite(claim: string): Promise<string> {
    this.rewriteCalls += 1;
    return claim === NEEDS_REWRITE ? CLAIM2 : NEVER_PARSES;
  }
}

interface Harness {
  readonly client: Client;
  readonly runtime: MemoryRuntime;
  readonly worker: StubResearchWorker;
  readonly extractor: StubClaimExtractor;
  close(): Promise<void>;
}

async function connect(): Promise<Harness> {
  const worker = new StubResearchWorker();
  const extractor = new StubClaimExtractor();
  const runtime = await createMemoryRuntime({
    store: new InMemoryDurableStore(),
    parser: new StubParser(),
    researchWorker: worker,
    extractor,
    embedding: new TokenEmbeddingProvider(256),
    repository: "demo",
  });
  const server = createMemoryMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    runtime,
    worker,
    extractor,
    async close() {
      await client.close();
      await server.close();
      await runtime.close();
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ data: any; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  return { data: result.structuredContent as any, isError: result.isError === true };
}

const USER = { type: "user", reference: "request" };
const TOOL = { type: "tool", reference: "npm test" };

let harness: Harness;
beforeEach(async () => {
  harness = await connect();
});
afterEach(async () => {
  await harness.close();
});

describe("MCP surface discovery", () => {
  it("exposes the ten tools, two prompts, and three resources", async () => {
    const tools = (await harness.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "add_claim",
      "check_retractions",
      "explain",
      "find_papers",
      "forget",
      "ingest_paper",
      "query",
      "remember",
      "revise",
      "solve",
    ]);
    const prompts = (await harness.client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["controlled-english", "problem-solving"]);
    const resources = (await harness.client.listResources()).resources.map((r) => r.uri).sort();
    expect(resources).toEqual(["omg://memory/removal-authority", "omg://memory/schema", "omg://memory/scopes"]);
  });

  it("reports the project identity in the scopes resource", async () => {
    const read = await harness.client.readResource({ uri: "omg://memory/scopes" });
    const body = JSON.parse(read.contents[0]!.text as string);
    expect(body.repository).toBe("demo");
    expect(Object.keys(body.scopes)).toContain("project");
  });

  it("serves the controlled-english contract as a prompt", async () => {
    const prompt = await harness.client.getPrompt({ name: "controlled-english" });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain("one asserted proposition per sentence");
  });
});

describe("remember", () => {
  it("stores parsed propositions and reports rejections with rewrite feedback", async () => {
    const good = await call(harness.client, "remember", { statements: [GOAL], scope: "project", kind: "goal", source: USER });
    expect(good.data.results[0].stored).toBe(true);
    expect(good.data.results[0].id).toMatch(/^prop-/);

    const bad = await call(harness.client, "remember", { statements: [BAD], scope: "project", kind: "observation", source: USER });
    expect(bad.data.results[0].stored).toBe(false);
    expect(bad.data.results[0].feedback).toContain("one asserted proposition");
  });

  it("validates arguments and rejects an unknown scope at the protocol layer", async () => {
    const result = await harness.client.callTool({ name: "remember", arguments: { statements: [GOAL], scope: "nowhere", kind: "goal", source: USER } });
    expect(result.isError).toBe(true);
  });
});

describe("query", () => {
  it("answers a subject question by binding each matching action", async () => {
    await call(harness.client, "remember", { statements: [ACT_A, ACT_B], scope: "project", kind: "action", source: USER });
    const { data } = await call(harness.client, "query", { question: QUESTION, scope: "project" });
    expect(data.answers.map((a: any) => a.binding.value).sort()).toEqual(["+ action a_adapter", "+ action a_upgrade"]);
    expect(data.modes).toContain("exact");
  });
});

describe("the fixture task: a failed test changes the decision and retraction restores it", () => {
  it("blocks the conflicted action, then restores the tie when the evidence is forgotten", async () => {
    await call(harness.client, "remember", { statements: [GOAL], scope: "project", kind: "goal", source: USER });
    await call(harness.client, "remember", { statements: [ACT_A, ACT_B], scope: "project", kind: "action", source: USER });
    // Derived supports make both actions recommended, so the untouched state is a tie.
    // Each support conclusion rests on an observation premise, so it can be recomputed.
    const reviewA = await call(harness.client, "remember", { statements: [REVIEW_A], scope: "project", kind: "observation", source: USER });
    const reviewB = await call(harness.client, "remember", { statements: [REVIEW_B], scope: "project", kind: "observation", source: USER });
    await call(harness.client, "remember", { statements: [SUP_A], scope: "project", kind: "derived-conclusion", source: USER, premises: [reviewA.data.results[0].id] });
    await call(harness.client, "remember", { statements: [SUP_B], scope: "project", kind: "derived-conclusion", source: USER, premises: [reviewB.data.results[0].id] });

    const before = await call(harness.client, "solve", { scope: "project" });
    expect(before.data.recommended).toBeNull();
    expect(before.data.tiedActionIds.slice().sort()).toEqual(["a_adapter", "a_upgrade"]);
    expect(before.data.automaticExecutionAllowed).toBe(false);

    // A failing test, then the conflict it entails, blocks a_upgrade.
    const obs = await call(harness.client, "remember", { statements: [OBS], scope: "project", kind: "observation", source: TOOL });
    const obsId = obs.data.results[0].id;
    await call(harness.client, "remember", { statements: [CONFLICT], scope: "project", kind: "derived-conclusion", source: TOOL, premises: [obsId] });

    const during = await call(harness.client, "solve", { scope: "project" });
    expect(during.data.blockedActionIds).toEqual(["a_upgrade"]);
    expect(during.data.recommended).toBe("a_adapter");
    expect(during.data.automaticExecutionAllowed).toBe(true);

    // Forgetting the observation invalidates the conflict's proof, restoring the tie.
    const forgotten = await call(harness.client, "forget", { propositionIds: [obsId], mode: "retract" });
    expect(forgotten.data.results[0].ok).toBe(true);
    const after = await call(harness.client, "solve", { scope: "project" });
    expect(after.data.blockedActionIds).toEqual([]);
    expect(after.data.recommended).toBeNull();
    expect(after.data.tiedActionIds.slice().sort()).toEqual(["a_adapter", "a_upgrade"]);
  });
});

describe("revise, forget preview, and explain", () => {
  it("supersedes a proposition, keeping the old one inactive", async () => {
    const stored = await call(harness.client, "remember", { statements: [GOAL], scope: "project", kind: "goal", source: USER });
    const id = stored.data.results[0].id;
    const revised = await call(harness.client, "revise", { id, statement: REVISED_GOAL, source: USER });
    expect(revised.isError).toBe(false);
    expect(revised.data.superseded.id).toBe(id);
    expect(revised.data.superseded.active).toBe(false);
    expect(revised.data.replacement.active).toBe(true);
    const explained = await call(harness.client, "explain", { id });
    expect(explained.data.active).toBe(false);
    expect(explained.data.supersededBy).toBe(revised.data.replacement.id);
  });

  it("rejects a stale revision on revise", async () => {
    const stored = await call(harness.client, "remember", { statements: [GOAL], scope: "project", kind: "goal", source: USER });
    const id = stored.data.results[0].id;
    const stale = await call(harness.client, "revise", { id, statement: REVISED_GOAL, source: USER, expectedRevision: 99 });
    expect(stale.isError).toBe(true);
  });

  it("previews a forget without changing state", async () => {
    const stored = await call(harness.client, "remember", { statements: [GOAL], scope: "project", kind: "goal", source: USER });
    const id = stored.data.results[0].id;
    const preview = await call(harness.client, "forget", { propositionIds: [id], mode: "purge", preview: true });
    expect(preview.data.preview).toBe(true);
    expect(preview.data.targets[0].exists).toBe(true);
    // State is unchanged: the proposition is still explainable and active.
    const explained = await call(harness.client, "explain", { id });
    expect(explained.data.active).toBe(true);
  });

  it("purges a proposition and then cannot find it", async () => {
    const stored = await call(harness.client, "remember", { statements: [GOAL], scope: "project", kind: "goal", source: USER });
    const id = stored.data.results[0].id;
    const purged = await call(harness.client, "forget", { propositionIds: [id], mode: "purge" });
    expect(purged.data.results[0].ok).toBe(true);
    const explained = await call(harness.client, "explain", { id });
    expect(explained.isError).toBe(true);
  });
});

describe("solve with no actions", () => {
  it("returns a clear error, not a crash", async () => {
    await call(harness.client, "remember", { statements: [GOAL], scope: "project", kind: "goal", source: USER });
    const { isError, data } = await call(harness.client, "solve", { scope: "project" });
    expect(isError).toBe(true);
    expect(data).toBeUndefined();
  });
});

describe("MCP paper ingestion and retraction", () => {
  it("ingests a paper by arXiv id as a work and returns its structure", async () => {
    const { data, isError } = await call(harness.client, "ingest_paper", { id: "1706.03762", scope: "project" });
    expect(isError).toBe(false);
    expect(data.work.title).toBe("Attention Is All You Need");
    expect(data.work.arxivId).toBe("1706.03762");
    expect(data.work.status).toBe("active");
    expect(data.sections.length).toBeGreaterThan(0);
    expect(data.references.length).toBeGreaterThan(0);
  });

  it("stores a claim drawn from an ingested work", async () => {
    const ingest = await call(harness.client, "ingest_paper", { id: "1706.03762", scope: "project" });
    const workId = ingest.data.work.id;
    const { data, isError } = await call(harness.client, "add_claim", {
      statement: CLAIM,
      workId,
      locator: "Results: BLEU rose",
      scope: "project",
    });
    expect(isError).toBe(false);
    expect(data.stored).toBe(true);
    expect(typeof data.id).toBe("string");
  });

  it("rejects add_claim for an unknown work", async () => {
    const { isError } = await call(harness.client, "add_claim", {
      statement: CLAIM,
      workId: "work-999",
      locator: "x",
      scope: "project",
    });
    expect(isError).toBe(true);
  });

  it("auto-extracts validated claims on ingest, storing only what the parser accepts", async () => {
    const { data, isError } = await call(harness.client, "ingest_paper", {
      id: "1706.03762",
      scope: "project",
      extractClaims: true,
    });
    expect(isError).toBe(false);
    expect(harness.extractor.extractCalls).toBe(1);
    // Three proposed: one accepted as-is, one accepted after a rewrite, one dropped.
    expect(data.extraction.model).toBe("stub-llm");
    expect(data.extraction.proposed).toBe(3);
    expect(data.extraction.stored).toHaveLength(2);
    expect(data.extraction.dropped).toHaveLength(1);
    const attempts = data.extraction.stored.map((c: any) => c.attempts).sort();
    expect(attempts).toEqual([1, 2]);
    expect(harness.extractor.rewriteCalls).toBeGreaterThanOrEqual(2);

    // A stored claim is active and sourced from the work with a paper locator.
    const storedId = data.extraction.stored[0].id as string;
    const explained = await call(harness.client, "explain", { id: storedId });
    expect(explained.data.active).toBe(true);
    expect(explained.data.sources[0].type).toBe("paper");
  });

  it("does not extract when extractClaims is not set", async () => {
    const { data } = await call(harness.client, "ingest_paper", { id: "1706.03762", scope: "project" });
    expect(data.extraction).toBeNull();
    expect(harness.extractor.extractCalls).toBe(0);
  });

  it("notes when extraction is requested but no model is configured", async () => {
    const runtime = await createMemoryRuntime({
      store: new InMemoryDurableStore(),
      parser: new StubParser(),
      researchWorker: new StubResearchWorker(),
      embedding: new TokenEmbeddingProvider(256),
    });
    const server = createMemoryMcpServer(runtime);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "no-model", version: "0.0.0" });
    await server.connect(st);
    await client.connect(ct);
    const { data, isError } = await call(client, "ingest_paper", { id: "1706.03762", scope: "project", extractClaims: true });
    expect(isError).toBe(false);
    expect(data.extraction.model).toBeNull();
    expect(data.extraction.note).toContain("add_claim");
    expect(data.sections.length).toBeGreaterThan(0);
    await client.close();
    await server.close();
    await runtime.close();
  });

  it("invalidates auto-extracted claims when the work is retracted", async () => {
    const ingest = await call(harness.client, "ingest_paper", { id: "10.1/bad", scope: "project", extractClaims: true });
    const workId = ingest.data.work.id;
    const storedIds = ingest.data.extraction.stored.map((c: any) => c.id as string);
    expect(storedIds.length).toBeGreaterThan(0);

    harness.worker.retracted.add("10.1/bad");
    const check = await call(harness.client, "check_retractions", { scope: "project" });
    expect(check.data.changed[0].workId).toBe(workId);
    for (const id of storedIds) expect(check.data.changed[0].invalidated).toContain(id);
  });

  it("invalidates a work's claims when check_retractions finds it newly retracted", async () => {
    const ingest = await call(harness.client, "ingest_paper", { id: "10.1/bad", scope: "project" });
    const workId = ingest.data.work.id;
    expect(ingest.data.work.status).toBe("active");
    const add = await call(harness.client, "add_claim", { statement: CLAIM, workId, locator: "Abstract", scope: "project" });
    const claimId = add.data.id as string;

    harness.worker.retracted.add("10.1/bad");
    const check = await call(harness.client, "check_retractions", { scope: "project" });
    expect(check.isError).toBe(false);
    expect(check.data.changed).toHaveLength(1);
    expect(check.data.changed[0].to).toBe("retracted");
    expect(check.data.changed[0].invalidated).toContain(claimId);
  });

  it("reports a clear error when no research worker is configured", async () => {
    const runtime = await createMemoryRuntime({
      store: new InMemoryDurableStore(),
      parser: new StubParser(),
      embedding: new TokenEmbeddingProvider(256),
    });
    const server = createMemoryMcpServer(runtime);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "no-worker", version: "0.0.0" });
    await server.connect(st);
    await client.connect(ct);
    const { isError } = await call(client, "ingest_paper", { id: "1706.03762", scope: "project" });
    expect(isError).toBe(true);
    await client.close();
    await server.close();
    await runtime.close();
  });
});

describe("MCP paper search", () => {
  it("ranks and de-duplicates candidates across sources", async () => {
    const { data, isError } = await call(harness.client, "find_papers", { query: "attention" });
    expect(isError).toBe(false);
    // Three raw hits collapse to two works; the one both sources returned ranks first.
    expect(data.count).toBe(2);
    expect(data.candidates[0].title).toBe("Attention Is All You Need");
    expect(data.candidates[0].sources.sort()).toEqual(["openAlex", "semanticScholar"]);
    expect(data.candidates[0].score).toBeGreaterThan(data.candidates[1].score);
    // The merge fills the arXiv id and the DOI from the two records of that work.
    expect(data.candidates[0].arxivId).toBe("1706.03762");
    expect(data.candidates[0].doi).toBe("10.1/attn");
  });

  it("flags a candidate already in the library for a scope", async () => {
    const ingest = await call(harness.client, "ingest_paper", { id: "10.1/bad", scope: "project" });
    const workId = ingest.data.work.id;
    const { data } = await call(harness.client, "find_papers", { query: "contested", scope: "project" });
    const contested = data.candidates.find((c: any) => c.doi === "10.1/bad");
    expect(contested.inLibrary).toBe(workId);
    // A work not in the library is not flagged.
    const attention = data.candidates.find((c: any) => c.arxivId === "1706.03762");
    expect(attention.inLibrary).toBeNull();
  });

  it("passes the source filter through to the worker", async () => {
    const { data } = await call(harness.client, "find_papers", { query: "x", sources: ["openAlex"] });
    expect(data.count).toBeGreaterThan(0);
  });
});
