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
import { createMemoryMcpServer, createMemoryRuntime, type MemoryRuntime } from "../src/mcp.js";

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

interface Harness {
  readonly client: Client;
  readonly runtime: MemoryRuntime;
  close(): Promise<void>;
}

async function connect(): Promise<Harness> {
  const runtime = await createMemoryRuntime({
    store: new InMemoryDurableStore(),
    parser: new StubParser(),
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
  it("exposes the six tools, two prompts, and three resources", async () => {
    const tools = (await harness.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["explain", "forget", "query", "remember", "revise", "solve"]);
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
