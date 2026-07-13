import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MemorySpace, type MemorySpaceOptions } from "../src/memory.js";
import { SqliteDurableStore } from "../src/durable_store.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP_ROOT = join(ROOT, "ai-tmp");
let suiteDir = "";

beforeAll(() => {
  mkdirSync(TEMP_ROOT, { recursive: true });
  suiteDir = mkdtempSync(join(TEMP_ROOT, "mem-durable-"));
});

afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

let counter = 0;
function dbPath(): string {
  counter += 1;
  return join(suiteDir, `mem-${counter}.db`);
}

// A space over a fresh SQLite store at `path`. A fixed clock keeps ids and
// timestamps deterministic across reopens.
function openSpace(path: string, options: Omit<MemorySpaceOptions, "store" | "now"> = {}): MemorySpace {
  let tick = 0;
  return new MemorySpace({
    store: new SqliteDurableStore(path),
    now: () => `2026-07-13T00:00:${String(tick++).padStart(2, "0")}Z`,
    ...options,
  });
}

const userSource = { type: "user", reference: "current request" } as const;
const toolSource = { type: "tool", reference: "npm test" } as const;

describe("MemorySpace durable restart", () => {
  it("reloads propositions, revisions, and history after a reopen", () => {
    const path = dbPath();
    const first = openSpace(path);
    const kept = first.remember({
      content: "The public API must stay compatible.",
      scope: "project",
      kind: "user-statement",
      sources: [userSource, toolSource],
    });
    first.addSource(kept.id, { type: "tool", reference: "second run" }); // revision -> 2
    const gone = first.remember({
      content: "A throwaway note.",
      scope: "project",
      kind: "observation",
      sources: [toolSource],
    });
    first.retract(gone.id);
    first.close();

    const second = openSpace(path);
    expect(second.isActive(kept.id)).toBe(true);
    const reloaded = second.get(kept.id)!;
    expect(reloaded.revision).toBe(2);
    expect(reloaded.sources).toHaveLength(3);
    expect(second.get(gone.id)?.state).toBe("retracted");
    expect(second.isActive(gone.id)).toBe(false);
    expect(second.activeInScope("project")).toEqual([kept.id]);
    second.close();
  });

  it("rebuilds derivations so reverse-proof invalidation still fires after a reopen", () => {
    const path = dbPath();
    const first = openSpace(path);
    const premise = first.remember({
      content: "Test auth_refresh fails.",
      scope: "project",
      kind: "observation",
      sources: [toolSource],
    }).id;
    const conclusion = first.derive({
      content: "The change conflicts with authentication.",
      rule: "rule-auth",
      premises: [premise],
    });
    expect(first.isActive(conclusion.id)).toBe(true);
    first.close();

    const second = openSpace(path);
    expect(second.isActive(conclusion.id)).toBe(true);
    const receipt = second.retract(premise);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) expect(receipt.invalidated).toContain(conclusion.id);
    expect(second.isActive(conclusion.id)).toBe(false);
    second.close();
  });

  it("continues generated ids past the highest stored id without reuse", () => {
    const path = dbPath();
    const first = openSpace(path);
    expect(first.remember({ content: "One.", scope: "user", kind: "goal", sources: [userSource] }).id).toBe(
      "prop-1",
    );
    expect(first.remember({ content: "Two.", scope: "user", kind: "goal", sources: [userSource] }).id).toBe(
      "prop-2",
    );
    first.close();

    const second = openSpace(path);
    const next = second.remember({ content: "Three.", scope: "user", kind: "goal", sources: [userSource] });
    expect(next.id).toBe("prop-3");
    second.close();
  });

  it("never reuses a purged id after a reopen, even when it was the highest", () => {
    const path = dbPath();
    const first = openSpace(path);
    const one = first.remember({ content: "One.", scope: "project", kind: "goal", sources: [userSource] });
    const two = first.remember({ content: "Two.", scope: "project", kind: "goal", sources: [userSource] });
    expect([one.id, two.id]).toEqual(["prop-1", "prop-2"]);
    first.purge(two.id); // purge the highest-id record
    first.close();

    // The reopened record scan sees only prop-1, but the persisted high-water mark
    // keeps the counter past prop-2, so a new remember does not reuse the purged id.
    const second = openSpace(path);
    const next = second.remember({ content: "Three.", scope: "project", kind: "goal", sources: [userSource] });
    expect(next.id).toBe("prop-3");
    expect(second.get("prop-2")).toBeUndefined();
    second.close();
  });

  it("preserves the revision so a stale optimistic write is rejected after a reopen", () => {
    const path = dbPath();
    const first = openSpace(path);
    const stored = first.remember({ content: "X.", scope: "project", kind: "goal", sources: [userSource] });
    first.addSource(stored.id, toolSource); // revision -> 2
    first.close();

    const second = openSpace(path);
    const result = second.retract(stored.id, 1);
    expect(result).toMatchObject({ ok: false, code: "stale_revision", expected: 1, actual: 2 });
    expect(second.isActive(stored.id)).toBe(true);
    second.close();
  });
});

describe("MemorySpace scope isolation", () => {
  it("hides another repository's project memory but shares user memory", () => {
    const path = dbPath();
    const a = openSpace(path, { repository: "repo-a" });
    const projectA = a.remember({
      content: "Repo A uses a monorepo layout.",
      scope: "project",
      kind: "observation",
      sources: [toolSource],
    });
    const shared = a.remember({
      content: "The user prefers explicit error handling.",
      scope: "user",
      kind: "user-statement",
      sources: [userSource],
    });
    a.close();

    const b = openSpace(path, { repository: "repo-b" });
    expect(b.get(projectA.id)).toBeUndefined();
    expect(b.isActive(projectA.id)).toBe(false);
    expect(b.isActive(shared.id)).toBe(true);
    // A new project fact in repo-b takes an id past repo-a's, never colliding.
    const projectB = b.remember({
      content: "Repo B is a single package.",
      scope: "project",
      kind: "observation",
      sources: [toolSource],
    });
    expect(projectB.id).not.toBe(projectA.id);
    b.close();

    // Reopening repo-a still sees only repo-a's project fact, plus shared user memory.
    const a2 = openSpace(path, { repository: "repo-a" });
    expect(a2.isActive(projectA.id)).toBe(true);
    expect(a2.get(projectB.id)).toBeUndefined();
    expect(a2.isActive(shared.id)).toBe(true);
    a2.close();
  });

  it("isolates session memory between sessions in the same repository", () => {
    const path = dbPath();
    const s1 = openSpace(path, { repository: "repo", session: "s1" });
    const noteS1 = s1.remember({
      content: "This session is exploring the parser.",
      scope: "session",
      kind: "observation",
      sources: [toolSource],
    });
    s1.close();

    const s2 = openSpace(path, { repository: "repo", session: "s2" });
    expect(s2.get(noteS1.id)).toBeUndefined();
    expect(s2.isActive(noteS1.id)).toBe(false);
    s2.close();

    const s1again = openSpace(path, { repository: "repo", session: "s1" });
    expect(s1again.isActive(noteS1.id)).toBe(true);
    s1again.close();
  });
});

describe("MemorySpace concurrent clients", () => {
  it("lets a second client opened on the live database read a committed write", () => {
    const path = dbPath();
    const writer = openSpace(path);
    const stored = writer.remember({
      content: "A committed fact.",
      scope: "user",
      kind: "observation",
      sources: [toolSource],
    });
    // The writer is still open (unclean, as after a crash); a second connection
    // opened on the same file recovers the committed write from the WAL.
    const reader = openSpace(path);
    expect(reader.isActive(stored.id)).toBe(true);
    expect(reader.get(stored.id)?.content).toBe("A committed fact.");
    reader.close();
    writer.close();
  });
});

describe("MemorySpace purge", () => {
  it("removes a proposition from the live space and reports the cascade", () => {
    const path = dbPath();
    const space = openSpace(path);
    const premise = space.remember({
      content: "A supporting observation.",
      scope: "project",
      kind: "observation",
      sources: [toolSource],
    }).id;
    const conclusion = space.derive({
      content: "A dependent conclusion.",
      rule: "r1",
      premises: [premise],
    });
    const receipt = space.purge(premise);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) {
      expect(receipt.mode).toBe("purge");
      expect(receipt.invalidated).toContain(conclusion.id);
    }
    expect(space.get(premise)).toBeUndefined();
    expect(space.isActive(premise)).toBe(false);
    expect(space.isActive(conclusion.id)).toBe(false);
    space.close();

    // The purge is durable: a reopened space never sees the record again.
    const reopened = openSpace(path);
    expect(reopened.get(premise)).toBeUndefined();
    reopened.close();
  });

  it("rejects a stale revision and reports not_found for an unknown id", () => {
    const path = dbPath();
    const space = openSpace(path);
    const stored = space.remember({ content: "Y.", scope: "user", kind: "goal", sources: [userSource] });
    space.addSource(stored.id, toolSource); // revision -> 2
    expect(space.purge(stored.id, 1)).toMatchObject({ ok: false, code: "stale_revision", actual: 2 });
    expect(space.isActive(stored.id)).toBe(true);
    expect(space.purge("ghost")).toMatchObject({ ok: false, code: "not_found", id: "ghost" });
    space.close();
  });

  it("scrubs purged content from every on-disk database file", () => {
    const path = dbPath();
    const canary = "CANARY-purge-9f8e7d6c-do-not-recover";
    const space = openSpace(path);
    const secret = space.remember({
      content: canary,
      scope: "user",
      kind: "observation",
      sources: [{ type: "tool", reference: "transient" }],
    });
    space.remember({
      content: "An unrelated fact that keeps the page in use.",
      scope: "user",
      kind: "observation",
      sources: [toolSource],
    });
    const receipt = space.purge(secret.id);
    expect(receipt.ok).toBe(true);
    space.close();

    const needle = Buffer.from(canary, "utf8");
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = path + suffix;
      if (!existsSync(file)) continue;
      expect(
        readFileSync(file).includes(needle),
        `${suffix || "main"} database still holds the purged content`,
      ).toBe(false);
    }
  });
});
