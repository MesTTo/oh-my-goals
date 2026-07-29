import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { format, parseAll, standardTokenizer } from "@metta-ts/core";
import { Atom, E, MeTTa, S, V } from "@metta-ts/hyperon";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ATOMSPACE_SNAPSHOT_VERSION,
  renderAtomspaceSnapshot,
} from "../src/atomspace_snapshot.js";
import {
  type PersistedRecord,
  SqliteDurableStore,
} from "../src/durable_store.js";
import { TokenEmbeddingProvider } from "../src/embedding.js";
import type {
  AvailabilityReport,
  HyperbaseParseBatch,
  HyperbaseParser,
} from "../src/hyperbase.js";
import { createMemoryRuntime } from "../src/mcp.js";
import type { ResearchWorker } from "../src/research.js";
import { SemanticMemory } from "../src/semantic_memory.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP_ROOT = join(ROOT, "ai-tmp");
let suiteDir = "";
let counter = 0;

beforeAll(() => {
  mkdirSync(TEMP_ROOT, { recursive: true });
  suiteDir = mkdtempSync(join(TEMP_ROOT, "atomspace-"));
});

afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

function caseDir(): string {
  counter += 1;
  const path = join(suiteDir, `case-${counter}`);
  mkdirSync(path);
  return path;
}

function relationTree(): string {
  return JSON.stringify({
    atom: false,
    edgeStr: "()",
    mainType: "R",
    type: "Rv",
    argroles: "so",
    connector: {
      atom: true,
      atomStr: "",
      root: "improves",
      label: "improves",
      mainType: "P",
      type: "Pv",
      role: "Pv.so",
    },
    children: [
      {
        atom: true,
        atomStr: "",
        root: "method",
        label: "method",
        mainType: "C",
        type: "Cc",
        role: "Cc",
      },
      {
        atom: true,
        atomStr: "",
        root: "recall",
        label: "recall",
        mainType: "C",
        type: "Cc",
        role: "Cc",
      },
    ],
  });
}

function parseSnapshot(source: string): MeTTa {
  const parsed = parseAll(source, standardTokenizer());
  expect(parsed.length).toBeGreaterThan(0);
  expect(parsed.every((top) => !top.bang)).toBe(true);
  for (const top of parsed) expect(format(top.atom)).toBe(source.split("\n")[parsed.indexOf(top)]);
  const runner = new MeTTa();
  for (const top of parsed) runner.space().addAtom(Atom.fromCAtom(top.atom));
  return runner;
}

function queryRows(runner: MeTTa, head: string, arity: number): string[] {
  const variables = Array.from({ length: arity }, (_, index) => V(`v${index}`));
  return runner
    .space()
    .query(E(S(head), ...variables))
    .frames.map((bindings) => bindings.toString())
    .sort();
}

function record(overrides: Partial<PersistedRecord> = {}): PersistedRecord {
  return {
    id: "prop-1",
    scope: "project",
    kind: "observation",
    content: "The method improves recall.",
    state: "active",
    revision: 1,
    recordedAt: "2026-07-29T00:00:00.000Z",
    tree: "typed",
    shTree: relationTree(),
    polarity: "affirmative",
    repository: "repo",
    session: "agent-a",
    supersedes: undefined,
    supersededBy: undefined,
    sources: [
      {
        assertionId: "prop-1-s1",
        type: "tool/result.v1",
        reference: "test",
        strength: 0.8,
        confidence: 0.9,
        state: "active",
        workId: undefined,
        locator: undefined,
      },
    ],
    derivations: [],
    ...overrides,
  };
}

const unusedParser: HyperbaseParser = {
  async parse(): Promise<HyperbaseParseBatch> {
    return { parser: "unused", spacyModel: "unused", items: [] };
  },
  async probe(): Promise<AvailabilityReport> {
    return { available: true, parser: "unused" };
  },
  async close(): Promise<void> {},
};

const unusedResearchWorker = {
  async close(): Promise<void> {},
} as ResearchWorker;

describe("canonical atomspace snapshots", () => {
  it("uses the stable agent for private memory and preserves the attempt identity", async () => {
    const root = caseDir();
    const privatePath = join(root, "notes.metta");
    const runtime = await createMemoryRuntime({
      store: new SqliteDurableStore(join(root, "memory.db")),
      repository: "repo",
      session: "attempt-42",
      agent: "agent-550e8400-e29b-41d4-a716-446655440000",
      atomspacePath: privatePath,
      parser: unusedParser,
      researchWorker: unusedResearchWorker,
      embedding: new TokenEmbeddingProvider(256),
    });
    expect(runtime.session).toBe("attempt-42");
    expect(runtime.agent).toBe("agent-550e8400-e29b-41d4-a716-446655440000");
    const stored = await runtime.memory.remember({
      id: "stable-private",
      content: "The stable agent keeps this note.",
      scope: "session",
      kind: "observation",
      sources: [{ type: "agent", reference: "runtime identity test" }],
    });
    const durable = runtime.memory.space
      .durableRecords()
      .find((candidate) => candidate.id === stored.id);
    expect(durable?.session).toBe("agent-550e8400-e29b-41d4-a716-446655440000");
    const source = readFileSync(privatePath, "utf8");
    expect(source).toContain(
      '(MemorySnapshot oh-my-goals-atomspace-v1 agent "repo" "agent-550e8400-e29b-41d4-a716-446655440000")',
    );
    expect(source).toContain("stable-private");
    await runtime.close();
  });

  it("separates agent and project scopes and loads queryable facts", async () => {
    const root = caseDir();
    const database = join(root, "memory.db");
    const privatePath = join(root, "notes.metta");
    const projectPath = join(root, "shared.metta");
    const memory = await SemanticMemory.open({
      store: new SqliteDurableStore(database),
      repository: "repo",
      session: "agent-a",
      atomspaceSnapshots: {
        repository: "repo",
        agent: "agent-a",
        agentPath: privatePath,
        projectPath,
      },
    });

    const privateFact = await memory.remember({
      id: "private-1",
      content: "The agent found a quote: \"one\".\nSecond line.",
      scope: "session",
      kind: "observation",
      sources: [{ type: "tool/result.v1", reference: "path\\with\\slashes" }],
    });
    const projectFact = await memory.remember({
      id: "project-1",
      content: "The method improves recall.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "paper", reference: "Results" }],
      tree: "typed",
      shTree: relationTree(),
      polarity: "affirmative",
    });
    await memory.remember({
      id: "user-1",
      content: "The user prefers terse output.",
      scope: "user",
      kind: "user-statement",
      sources: [{ type: "user", reference: "request" }],
    });
    await memory.derive({
      id: "derived-1",
      content: "The method is promising.",
      rule: "research/inference.v1",
      premises: [projectFact.id],
    });

    const privateSource = readFileSync(privatePath, "utf8");
    const projectSource = readFileSync(projectPath, "utf8");
    expect(privateSource).toContain(
      `(MemorySnapshot ${ATOMSPACE_SNAPSHOT_VERSION} agent "repo" "agent-a")`,
    );
    expect(privateSource).toContain(privateFact.id);
    expect(privateSource).not.toContain(projectFact.id);
    expect(privateSource).not.toContain("user-1");
    expect(projectSource).toContain(
      `(MemorySnapshot ${ATOMSPACE_SNAPSHOT_VERSION} project "repo" "")`,
    );
    expect(projectSource).toContain(projectFact.id);
    expect(projectSource).toContain("derived-1");
    expect(projectSource).not.toContain(privateFact.id);
    expect(projectSource).not.toContain("user-1");

    const privateRunner = parseSnapshot(privateSource);
    const projectRunner = parseSnapshot(projectSource);
    expect(queryRows(privateRunner, "MemoryContent", 2).join("\n")).toContain("private-1");
    expect(queryRows(projectRunner, "MemoryState", 3).join("\n")).toContain("project-1");
    expect(queryRows(projectRunner, "ClaimCore", 4).join("\n")).toContain(
      "improve(o:recall,s:method)",
    );
    expect(statSync(privatePath).mode & 0o777).toBe(0o600);
    expect(statSync(projectPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${privatePath}.lock`).mode & 0o777).toBe(0o600);
    expect(statSync(`${projectPath}.lock`).mode & 0o777).toBe(0o600);
    memory.close();
  });

  it("reads the durable store after taking the shared lock", async () => {
    const root = caseDir();
    const database = join(root, "memory.db");
    const shared = join(root, "shared.metta");
    const first = await SemanticMemory.open({
      store: new SqliteDurableStore(database),
      repository: "repo",
      session: "agent-a",
      atomspaceSnapshots: { repository: "repo", projectPath: shared },
    });
    const second = await SemanticMemory.open({
      store: new SqliteDurableStore(database),
      repository: "repo",
      session: "agent-b",
      atomspaceSnapshots: { repository: "repo", projectPath: shared },
    });
    await first.remember({
      id: "from-a",
      content: "Agent A found a fact.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "agent", reference: "a" }],
    });
    await second.remember({
      id: "from-b",
      content: "Agent B found a fact.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "agent", reference: "b" }],
    });
    const source = readFileSync(shared, "utf8");
    expect(source).toContain("from-a");
    expect(source).toContain("from-b");
    first.close();
    second.close();
  });

  it("refreshes after each proposition lifecycle mutation", async () => {
    const root = caseDir();
    const database = join(root, "memory.db");
    const shared = join(root, "shared.metta");
    const memory = await SemanticMemory.open({
      store: new SqliteDurableStore(database),
      repository: "repo",
      session: "agent-a",
      atomspaceSnapshots: { repository: "repo", projectPath: shared },
    });
    const stored = await memory.remember({
      id: "lifecycle-1",
      content: "The lifecycle is visible.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "tool", reference: "first" }],
    });
    expect(readFileSync(shared, "utf8")).toContain("(MemoryState lifecycle-1 active 1)");

    const sourced = await memory.addSource(
      stored.id,
      { type: "agent", reference: "second" },
      stored.revision,
    );
    expect("ok" in sourced).toBe(false);
    expect(readFileSync(shared, "utf8")).toContain("lifecycle-1-s2");
    const sourceRevision = "revision" in sourced ? sourced.revision : 0;

    const retractedSource = await memory.retractSource(
      stored.id,
      "lifecycle-1-s2",
      sourceRevision,
    );
    expect(retractedSource.ok).toBe(true);
    expect(readFileSync(shared, "utf8")).toContain(
      "(MemoryAssertionState lifecycle-1 lifecycle-1-s2 retracted)",
    );
    const revision =
      retractedSource.ok ? retractedSource.proposition.revision : sourceRevision;

    const superseded = await memory.supersede(
      stored.id,
      {
        id: "lifecycle-2",
        content: "The replacement is visible.",
        scope: "project",
        kind: "observation",
        sources: [{ type: "agent", reference: "correction" }],
      },
      revision,
    );
    expect(superseded.ok).toBe(true);
    let source = readFileSync(shared, "utf8");
    expect(source).toContain("(MemoryState lifecycle-1 superseded");
    expect(source).toContain("(MemorySupersedes lifecycle-2 lifecycle-1)");

    if (superseded.ok) {
      await memory.purge(
        superseded.replacement.id,
        superseded.replacement.revision,
      );
    }
    source = readFileSync(shared, "utf8");
    expect(source).not.toContain("lifecycle-2");
    expect(source).not.toContain("(MemorySupersedes");
    memory.close();
  });

  it("keeps a committed mutation successful, marks projection dirty, and repairs on reopen", async () => {
    const root = caseDir();
    const database = join(root, "memory.db");
    const shared = join(root, "shared.metta");
    const elsewhere = join(root, "elsewhere.metta");
    const first = await SemanticMemory.open({
      store: new SqliteDurableStore(database),
      repository: "repo",
      session: "agent-a",
      atomspaceSnapshots: { repository: "repo", projectPath: shared },
    });
    unlinkSync(shared);
    writeFileSync(elsewhere, "unchanged\n");
    symlinkSync(elsewhere, shared);
    const stored = await first.remember({
      id: "committed-after-file-failure",
      content: "The durable mutation commits.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "tool", reference: "failure injection" }],
    });
    expect(stored.id).toBe("committed-after-file-failure");
    const dirtyHealth = first.atomspaceSnapshotHealth();
    expect(dirtyHealth).toMatchObject({
      configured: true,
      dirty: true,
    });
    expect(JSON.stringify(dirtyHealth)).not.toContain(root);
    expect(JSON.stringify(dirtyHealth)).not.toContain(shared);
    expect(readFileSync(elsewhere, "utf8")).toBe("unchanged\n");
    first.close();

    unlinkSync(shared);
    const second = await SemanticMemory.open({
      store: new SqliteDurableStore(database),
      repository: "repo",
      session: "agent-a",
      atomspaceSnapshots: { repository: "repo", projectPath: shared },
    });
    expect(second.atomspaceSnapshotHealth()).toEqual({
      configured: true,
      dirty: false,
    });
    expect(readFileSync(shared, "utf8")).toContain(stored.id);
    second.close();
  });

  it("rejects nonregular and symlink targets without overwriting them", async () => {
    const root = caseDir();
    const database = join(root, "memory.db");
    const target = join(root, "target.metta");
    const elsewhere = join(root, "elsewhere.metta");
    writeFileSync(elsewhere, "protected\n");
    symlinkSync(elsewhere, target);
    const memory = await SemanticMemory.open({
      store: new SqliteDurableStore(database),
      repository: "repo",
      atomspaceSnapshots: { repository: "repo", projectPath: target },
    });
    expect(memory.atomspaceSnapshotHealth()).toMatchObject({
      configured: true,
      dirty: true,
    });
    expect(readFileSync(elsewhere, "utf8")).toBe("protected\n");
    memory.close();

    unlinkSync(target);
    mkdirSync(target);
    const nonregular = await SemanticMemory.open({
      store: new SqliteDurableStore(join(root, "nonregular.db")),
      repository: "repo",
      atomspaceSnapshots: { repository: "repo", projectPath: target },
    });
    expect(nonregular.atomspaceSnapshotHealth().dirty).toBe(true);
    expect(statSync(target).isDirectory()).toBe(true);
    nonregular.close();

    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    const parentLink = await SemanticMemory.open({
      store: new SqliteDurableStore(join(root, "parent-link.db")),
      repository: "repo",
      atomspaceSnapshots: {
        repository: "repo",
        projectPath: join(linkedParent, "shared.metta"),
      },
    });
    expect(parentLink.atomspaceSnapshotHealth().dirty).toBe(true);
    expect(statSync(realParent).isDirectory()).toBe(true);
    parentLink.close();
  });

  it("renders arbitrary grounded strings canonically and deterministically", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (content, reference) => {
        const sample = record({
          content,
          sources: [{ ...record().sources[0]!, reference }],
        });
        const first = renderAtomspaceSnapshot("project", "repo", undefined, [sample]);
        const second = renderAtomspaceSnapshot("project", "repo", undefined, [sample]);
        expect(second).toBe(first);
        const parsed = parseAll(first, standardTokenizer());
        expect(parsed.every((top) => !top.bang)).toBe(true);
        expect(parsed.map((top) => format(top.atom)).join("\n") + "\n").toBe(first);
      }),
      { numRuns: 100 },
    );
  });

  it("renders an internal quote as part of a symbol, matching the AO parser fixture", () => {
    const quoted = record({
      id: 'quoted"id',
      sources: [
        {
          ...record().sources[0]!,
          assertionId: 'quoted"id-s1',
        },
      ],
    });
    const source = renderAtomspaceSnapshot("project", "repo", undefined, [quoted]);
    expect(source).toContain('(MemoryProposition quoted"id project observation)');
    const parsed = parseAll(source, standardTokenizer());
    expect(parsed.every((top) => !top.bang)).toBe(true);
    expect(parsed.map((top) => format(top.atom)).join("\n") + "\n").toBe(source);
  });
});
