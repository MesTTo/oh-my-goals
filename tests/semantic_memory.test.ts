import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TokenEmbeddingProvider } from "../src/embedding.js";
import { InMemoryDurableStore, SqliteDurableStore } from "../src/durable_store.js";
import { SemanticBackend } from "../src/semantic.js";
import { SemanticMemory } from "../src/semantic_memory.js";
import { InMemoryVectorIndex } from "../src/vector_index.js";
import type { ShAtom, ShEdge, ShNode } from "../src/hyperbase.js";
import type { RememberInput } from "../src/memory.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP_ROOT = join(ROOT, "ai-tmp");
let suiteDir = "";

beforeAll(() => {
  mkdirSync(TEMP_ROOT, { recursive: true });
  suiteDir = mkdtempSync(join(TEMP_ROOT, "sem-mem-"));
});

afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

let counter = 0;
function dbPath(): string {
  counter += 1;
  return join(suiteDir, `sem-${counter}.db`);
}

function backend(): SemanticBackend {
  return new SemanticBackend(new TokenEmbeddingProvider(256), new InMemoryVectorIndex());
}

function atom(root: string, type: string, role = type): ShAtom {
  return { atom: true, atomStr: `${root}/${role}`, root, label: root, mainType: type[0]!, type, role };
}

// A minimal but well-formed SH edge: `(use/Pv.so <subject> <object>)`. The source
// candidate embeds the whole sentence, which is what these token-overlap searches
// match on.
function sentenceTree(subject: string, object: string): ShEdge {
  return {
    atom: false,
    edgeStr: `(use ${subject} ${object})`,
    mainType: "R",
    type: "Rv",
    argroles: "so",
    connector: atom("use", "Pv", "Pv.so"),
    children: [atom(subject, "Cc"), atom(object, "Cc")],
  };
}

function fact(content: string, tree: ShNode, overrides: Partial<RememberInput> = {}): RememberInput {
  return {
    content,
    scope: "project",
    kind: "observation",
    sources: [{ type: "tool", reference: "test" }],
    shTree: JSON.stringify(tree),
    polarity: "affirmative",
    ...overrides,
  };
}

const POSTGRES = fact("the database uses postgres", sentenceTree("database", "postgres"));
const REDIS = fact("the cache uses redis", sentenceTree("cache", "redis"));

async function found(memory: SemanticMemory, query: string, scope = "project" as const): Promise<string[]> {
  const hits = await memory.search(query, scope);
  return hits.map((hit) => hit.proposition.id);
}

describe("SemanticMemory indexing and search", () => {
  it("finds a stored proposition by an overlapping query and maps it back", async () => {
    const memory = await SemanticMemory.open({ backend: backend() });
    const stored = await memory.remember(POSTGRES);
    await memory.remember(REDIS);
    const ids = await found(memory, "postgres database");
    expect(ids[0]).toBe(stored.id);
    memory.close();
  });

  it("returns nothing and stays functional without a backend", async () => {
    const memory = await SemanticMemory.open();
    const stored = await memory.remember(POSTGRES);
    expect(memory.isActive(stored.id)).toBe(true);
    expect(await memory.search("postgres", "project")).toEqual([]);
    expect(memory.config()).toBeUndefined();
    memory.close();
  });

  it("scopes search to the requested space", async () => {
    const memory = await SemanticMemory.open({ backend: backend(), repository: "repo-x" });
    await memory.remember(POSTGRES);
    expect(await found(memory, "postgres database", "project")).toHaveLength(1);
    expect(await found(memory, "postgres database", "user")).toEqual([]);
    memory.close();
  });
});

describe("SemanticMemory forget removes candidates", () => {
  it("drops a retracted proposition from search", async () => {
    const memory = await SemanticMemory.open({ backend: backend() });
    const stored = await memory.remember(POSTGRES);
    expect(await found(memory, "postgres database")).toContain(stored.id);
    await memory.retract(stored.id);
    expect(await found(memory, "postgres database")).not.toContain(stored.id);
    memory.close();
  });

  it("drops a purged proposition from search", async () => {
    const memory = await SemanticMemory.open({ backend: backend() });
    const stored = await memory.remember(POSTGRES);
    expect(await found(memory, "postgres database")).toContain(stored.id);
    await memory.purge(stored.id);
    expect(await found(memory, "postgres database")).toEqual([]);
    memory.close();
  });

  it("re-indexes a proposition that a new source brings back to life", async () => {
    const memory = await SemanticMemory.open({ backend: backend() });
    const stored = await memory.remember(
      fact("the database uses postgres", sentenceTree("database", "postgres"), {
        sources: [{ type: "tool", reference: "one" }],
      }),
    );
    await memory.retractSource(stored.id, stored.sources[0]!.assertionId);
    expect(memory.isActive(stored.id)).toBe(false);
    expect(await found(memory, "postgres database")).toEqual([]);

    await memory.addSource(stored.id, { type: "tool", reference: "two" });
    expect(memory.isActive(stored.id)).toBe(true);
    expect(await found(memory, "postgres database")).toContain(stored.id);
    memory.close();
  });

  it("re-indexes the replacement and drops the superseded proposition", async () => {
    const memory = await SemanticMemory.open({ backend: backend() });
    const old = await memory.remember(POSTGRES);
    const result = await memory.supersede(old.id, REDIS);
    expect(result.ok).toBe(true);
    expect(await found(memory, "postgres database")).not.toContain(old.id);
    if (result.ok) expect(await found(memory, "cache redis")).toContain(result.replacement.id);
    memory.close();
  });
});

describe("SemanticMemory durable index rebuild", () => {
  it("rebuilds the semantic index from stored trees so search survives a restart", async () => {
    const path = dbPath();
    const first = await SemanticMemory.open({ store: new SqliteDurableStore(path), backend: backend() });
    const stored = await first.remember(POSTGRES);
    await first.remember(REDIS);
    first.close();

    // A fresh backend with an empty index; the facade must repopulate it on open.
    const freshBackend = backend();
    const second = await SemanticMemory.open({ store: new SqliteDurableStore(path), backend: freshBackend });
    expect(await found(second, "postgres database")).toContain(stored.id);
    expect(await found(second, "cache redis")).toHaveLength(1);
    second.close();
  });

  it("does not rebuild candidates for a proposition retracted before the restart", async () => {
    const path = dbPath();
    const first = await SemanticMemory.open({ store: new SqliteDurableStore(path), backend: backend() });
    const kept = await first.remember(POSTGRES);
    const dropped = await first.remember(REDIS);
    await first.retract(dropped.id);
    first.close();

    const second = await SemanticMemory.open({ store: new SqliteDurableStore(path), backend: backend() });
    expect(await found(second, "postgres database")).toContain(kept.id);
    expect(await found(second, "cache redis")).not.toContain(dropped.id);
    second.close();
  });

  it("indexes into an in-memory store the same way", async () => {
    const store = new InMemoryDurableStore();
    const first = await SemanticMemory.open({ store, backend: backend() });
    const stored = await first.remember(POSTGRES);
    // The in-memory store is shared, so a second facade rebuilds from the same records.
    const second = await SemanticMemory.open({ store, backend: backend() });
    expect(await found(second, "postgres database")).toContain(stored.id);
  });
});
