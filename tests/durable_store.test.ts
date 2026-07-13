import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  IdConflictError,
  InMemoryDurableStore,
  SqliteDurableStore,
  type DurableStore,
  type PersistedRecord,
} from "../src/durable_store.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP_ROOT = join(ROOT, "ai-tmp");
let suiteDir = "";

beforeAll(() => {
  mkdirSync(TEMP_ROOT, { recursive: true });
  suiteDir = mkdtempSync(join(TEMP_ROOT, "durable-"));
});

afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

let counter = 0;
function dbPath(): string {
  counter += 1;
  return join(suiteDir, `store-${counter}.db`);
}

function record(overrides: Partial<PersistedRecord> = {}): PersistedRecord {
  return {
    id: "p1",
    scope: "project",
    kind: "fact",
    content: "the build uses vitest",
    state: "active",
    revision: 1,
    recordedAt: "2026-01-01T00:00:00.000Z",
    tree: "(is/Pv.so (the/Md build/Cc) (use/Pv vitest/Cc))",
    shTree: '{"atom":false,"type":"Rv"}',
    polarity: "affirmative",
    repository: "oh-my-goals",
    session: "default",
    supersedes: undefined,
    supersededBy: undefined,
    sources: [
      {
        assertionId: "a1",
        type: "observation",
        reference: "ci-log",
        strength: 0.9,
        confidence: 0.95,
        state: "active",
      },
    ],
    derivations: [],
    ...overrides,
  };
}

// The interface contract holds for both implementations, so exercise it against
// each. The SQLite store then gets extra tests for persistence and purge.
function contractSuite(name: string, make: () => DurableStore): void {
  describe(`${name} (DurableStore contract)`, () => {
    let store: DurableStore;
    afterEach(() => store.close());

    it("round-trips a record with sources and derivations", () => {
      store = make();
      const derived = record({
        id: "p2",
        kind: "conclusion",
        content: "vitest is the test runner",
        sources: [],
        derivations: [{ rule: "modus-ponens", premises: ["p1", "p3"] }],
      });
      store.save(record());
      store.save(derived);

      const all = store.allRecords();
      expect(all).toHaveLength(2);
      const p1 = all.find((r) => r.id === "p1")!;
      expect(p1.content).toBe("the build uses vitest");
      expect(p1.sources).toHaveLength(1);
      expect(p1.sources[0]!.reference).toBe("ci-log");
      expect(p1.sources[0]!.strength).toBeCloseTo(0.9);
      const p2 = all.find((r) => r.id === "p2")!;
      expect(p2.derivations).toEqual([{ rule: "modus-ponens", premises: ["p1", "p3"] }]);
    });

    it("replaces sources and derivations on re-save rather than accumulating", () => {
      store = make();
      store.save(record({ sources: [source("a1"), source("a2")] }));
      store.save(record({ sources: [source("a3")] }));
      const [only] = store.allRecords();
      expect(only!.sources.map((s) => s.assertionId)).toEqual(["a3"]);
    });

    it("preserves undefined optional fields as undefined", () => {
      store = make();
      store.save(record({ tree: undefined, shTree: undefined, polarity: undefined, supersedes: undefined }));
      const [only] = store.allRecords();
      expect(only!.tree).toBeUndefined();
      expect(only!.shTree).toBeUndefined();
      expect(only!.polarity).toBeUndefined();
      expect(only!.supersedes).toBeUndefined();
    });

    it("round-trips the SH tree, polarity, and session", () => {
      store = make();
      store.save(
        record({ shTree: '{"atom":true,"root":"cat"}', polarity: "negated", session: "s-7" }),
      );
      const [only] = store.allRecords();
      expect(only!.shTree).toBe('{"atom":true,"root":"cat"}');
      expect(only!.polarity).toBe("negated");
      expect(only!.session).toBe("s-7");
    });

    it("insert rejects a duplicate id and leaves the original intact", () => {
      store = make();
      store.insert(record({ content: "first" }));
      expect(() => store.insert(record({ content: "second" }))).toThrow(IdConflictError);
      const [only] = store.allRecords();
      expect(only!.content).toBe("first");
    });

    it("carries supersession links and retracted source state", () => {
      store = make();
      store.save(
        record({
          state: "superseded",
          supersededBy: "p9",
          sources: [{ ...source("a1"), state: "retracted" }],
        }),
      );
      const [only] = store.allRecords();
      expect(only!.state).toBe("superseded");
      expect(only!.supersededBy).toBe("p9");
      expect(only!.sources[0]!.state).toBe("retracted");
    });

    it("purge removes a record", () => {
      store = make();
      store.save(record());
      store.save(record({ id: "p2" }));
      store.purge("p1");
      expect(store.allRecords().map((r) => r.id)).toEqual(["p2"]);
    });
  });
}

function source(assertionId: string) {
  return {
    assertionId,
    type: "observation",
    reference: "ref",
    strength: 0.5,
    confidence: 0.5,
    state: "active" as const,
  };
}

contractSuite("InMemoryDurableStore", () => new InMemoryDurableStore());
contractSuite("SqliteDurableStore", () => new SqliteDurableStore(dbPath()));

describe("SqliteDurableStore persistence", () => {
  it("survives close and reopen", () => {
    const path = dbPath();
    const first = new SqliteDurableStore(path);
    first.save(record());
    first.save(record({ id: "p2", content: "second fact" }));
    first.close();

    const second = new SqliteDurableStore(path);
    const all = second.allRecords();
    expect(all.map((r) => r.id).sort()).toEqual(["p1", "p2"]);
    expect(all.find((r) => r.id === "p2")!.content).toBe("second fact");
    second.close();
  });

  it("lets a concurrent reader see a committed write", () => {
    const path = dbPath();
    const writer = new SqliteDurableStore(path);
    writer.save(record());
    const reader = new SqliteDurableStore(path);
    expect(reader.allRecords().map((r) => r.id)).toEqual(["p1"]);
    reader.close();
    writer.close();
  });

  it("rolls back a failed transaction, leaving no partial write", () => {
    const path = dbPath();
    const store = new SqliteDurableStore(path);
    store.save(record());
    expect(() =>
      store.transaction(() => {
        store.save(record({ id: "p2", content: "doomed" }));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.allRecords().map((r) => r.id)).toEqual(["p1"]);
    store.close();

    // The rollback must also hold across a restart: p2 never reaches disk.
    const reopened = new SqliteDurableStore(path);
    expect(reopened.allRecords().map((r) => r.id)).toEqual(["p1"]);
    reopened.close();
  });

  it("scrubs purged content from every on-disk file", () => {
    const path = dbPath();
    const canary = "CANARY-a1b2c3d4e5f6-secret-passphrase";
    const store = new SqliteDurableStore(path);
    store.save(record({ id: "secret", content: canary }));
    // A second live record keeps the page in use, so the purge must scrub the
    // freed cell rather than relying on the file being empty.
    store.save(record({ id: "keep", content: "an unrelated retained fact" }));
    store.purge("secret");
    store.close();

    const needle = Buffer.from(canary, "utf8");
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = path + suffix;
      if (!existsSync(file)) continue;
      expect(readFileSync(file).includes(needle), `${suffix || "main"} db still holds the canary`).toBe(
        false,
      );
    }
    // The retained record is untouched.
    const reopened = new SqliteDurableStore(path);
    expect(reopened.allRecords().map((r) => r.id)).toEqual(["keep"]);
    reopened.close();
  });
});
