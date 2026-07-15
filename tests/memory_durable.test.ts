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

describe("MemorySpace works", () => {
  it("stores a work and reloads every field after a reopen", () => {
    const path = dbPath();
    const first = openSpace(path);
    const stored = first.ingestWork({
      title: "Amyloid beta and Alzheimer's",
      scope: "project",
      doi: "10.1000/abeta",
      arxivId: "2401.00001",
      authors: ["A. One", "B. Two"],
      year: 2024,
      venue: "Nature",
      abstract: "We study amyloid beta.",
    });
    expect(stored.id).toBe("work-1");
    expect(stored.status).toBe("active");
    expect(stored.authors).toEqual(["A. One", "B. Two"]);
    first.close();

    const second = openSpace(path);
    const reloaded = second.getWork("work-1")!;
    expect(reloaded.title).toBe("Amyloid beta and Alzheimer's");
    expect(reloaded.doi).toBe("10.1000/abeta");
    expect(reloaded.arxivId).toBe("2401.00001");
    expect(reloaded.authors).toEqual(["A. One", "B. Two"]);
    expect(reloaded.year).toBe(2024);
    expect(reloaded.venue).toBe("Nature");
    expect(reloaded.abstract).toBe("We study amyloid beta.");
    expect(reloaded.status).toBe("active");
    second.close();
  });

  it("deduplicates a work by external id and continues work ids past a reopen", () => {
    const path = dbPath();
    const first = openSpace(path);
    const one = first.ingestWork({ title: "First", scope: "project", doi: "10.1/a" });
    const dup = first.ingestWork({ title: "First submitted again", scope: "project", doi: "10.1/a" });
    expect(dup.id).toBe(one.id);
    expect(first.worksInScope("project")).toHaveLength(1);
    first.close();

    const second = openSpace(path);
    const two = second.ingestWork({ title: "Second", scope: "project", doi: "10.1/b" });
    expect(two.id).toBe("work-2");
    second.close();
  });

  it("isolates works by repository and shares user-scope works", () => {
    const path = dbPath();
    const repoA = new MemorySpace({ store: new SqliteDurableStore(path), repository: "repo-a", session: "s1" });
    repoA.ingestWork({ title: "Project paper", scope: "project" });
    repoA.ingestWork({ title: "User paper", scope: "user" });
    repoA.close();

    const repoB = new MemorySpace({ store: new SqliteDurableStore(path), repository: "repo-b", session: "s1" });
    expect(repoB.worksInScope("project")).toHaveLength(0);
    expect(repoB.worksInScope("user")).toHaveLength(1);
    repoB.close();
  });

  it("carries a paper source's work link and locator through a reopen", () => {
    const path = dbPath();
    const first = openSpace(path);
    const work = first.ingestWork({ title: "Cited paper", scope: "project", doi: "10.9/z" });
    const claim = first.remember({
      content: "The method improves recall.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "paper", reference: work.doi!, workId: work.id, locator: "Results: recall rose to 0.9" }],
    });
    first.close();

    const second = openSpace(path);
    const reloaded = second.get(claim.id)!;
    expect(reloaded.sources[0]!.type).toBe("paper");
    expect(reloaded.sources[0]!.workId).toBe(work.id);
    expect(reloaded.sources[0]!.locator).toBe("Results: recall rose to 0.9");
    second.close();
  });

  it("retracts a work and deactivates the claims and conclusions resting on it, across a reopen", () => {
    const path = dbPath();
    const first = openSpace(path);
    const work = first.ingestWork({ title: "Contested finding", scope: "project", doi: "10.5/r" });
    const cite = (locator: string) => ({ type: "paper", reference: work.doi!, workId: work.id, locator });
    const claim = first.remember({ content: "The drug reduces risk.", scope: "project", kind: "observation", sources: [cite("Results")] });
    const premise = first.remember({ content: "The trial was randomized.", scope: "project", kind: "observation", sources: [cite("Methods")] });
    const conclusion = first.derive({ content: "The benefit is supported.", rule: "support", premises: [premise.id], scope: "project", kind: "derived-conclusion" });
    expect(first.isActive(claim.id)).toBe(true);
    expect(first.isActive(conclusion.id)).toBe(true);

    const result = first.setWorkStatus(work.id, "retracted", "10.5/r-retraction", "2025-01-01");
    expect(result.ok).toBe(true);
    expect(first.isActive(claim.id)).toBe(false);
    expect(first.isActive(premise.id)).toBe(false);
    expect(first.isActive(conclusion.id)).toBe(false); // cascaded through the proof
    expect(first.getWork(work.id)!.status).toBe("retracted");
    first.close();

    const second = openSpace(path);
    expect(second.isActive(claim.id)).toBe(false);
    expect(second.isActive(conclusion.id)).toBe(false);
    expect(second.getWork(work.id)!.status).toBe("retracted");
    second.close();
  });

  it("keeps a claim active when a second source survives a work retraction", () => {
    const space = openSpace(dbPath());
    const work = space.ingestWork({ title: "One of two sources", scope: "project", doi: "10.5/s" });
    const corroborated = space.remember({
      content: "The effect replicates.",
      scope: "project",
      kind: "observation",
      sources: [
        { type: "paper", reference: work.doi!, workId: work.id, locator: "Fig 2" },
        { type: "user", reference: "lab notebook" },
      ],
    });
    expect(space.isActive(corroborated.id)).toBe(true);
    space.setWorkStatus(work.id, "retracted");
    expect(space.isActive(corroborated.id)).toBe(true); // the second source still holds
    space.close();
  });

  it("births a claim citing an already-retracted work inactive", () => {
    const space = openSpace(dbPath());
    const work = space.ingestWork({ title: "Already retracted", scope: "project", doi: "10.5/t" });
    space.setWorkStatus(work.id, "retracted");
    const late = space.remember({
      content: "A claim from the retracted paper.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "paper", reference: work.doi!, workId: work.id, locator: "Intro" }],
    });
    expect(space.isActive(late.id)).toBe(false);
    space.close();
  });

  it("records a non-retraction status without invalidating", () => {
    const space = openSpace(dbPath());
    const work = space.ingestWork({ title: "Corrected paper", scope: "project", doi: "10.5/u" });
    const claim = space.remember({
      content: "The corrected result holds.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "paper", reference: work.doi!, workId: work.id, locator: "Correction" }],
    });
    const result = space.setWorkStatus(work.id, "corrected", "10.5/u-correction");
    expect(result.ok).toBe(true);
    expect(space.getWork(work.id)!.status).toBe("corrected");
    expect(space.isActive(claim.id)).toBe(true); // a correction flags, it does not invalidate
    space.close();
  });

  it("withdraws a work like a retraction, invalidating its claims", () => {
    const space = openSpace(dbPath());
    const work = space.ingestWork({ title: "Withdrawn", scope: "project", doi: "10.6/w" });
    const claim = space.remember({
      content: "The withdrawn result holds.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "paper", reference: work.doi!, workId: work.id, locator: "Results" }],
    });
    expect(space.isActive(claim.id)).toBe(true);
    const result = space.setWorkStatus(work.id, "withdrawn");
    expect(result.invalidated).toContain(claim.id);
    expect(space.isActive(claim.id)).toBe(false);
    space.close();
  });

  it("honors a configured invalidation policy", () => {
    // Only retraction invalidates here, so a withdrawal merely flags.
    const space = openSpace(dbPath(), { invalidatingStatuses: ["retracted"] });
    const work = space.ingestWork({ title: "Retraction-only policy", scope: "project", doi: "10.6/p" });
    const claim = space.remember({
      content: "The finding stands.",
      scope: "project",
      kind: "observation",
      sources: [{ type: "paper", reference: work.doi!, workId: work.id, locator: "Results" }],
    });
    space.setWorkStatus(work.id, "withdrawn");
    expect(space.isActive(claim.id)).toBe(true); // withdrawn is not in this policy
    space.setWorkStatus(work.id, "retracted");
    expect(space.isActive(claim.id)).toBe(false);
    space.close();
  });

  it("rebuilds claim cores so contradiction still reads after a reopen", () => {
    // A minimal relation tree; claimCore reads its predicate and arguments.
    const shTree = (verb: string, subject: string, object: string): string =>
      JSON.stringify({
        atom: false,
        edgeStr: "()",
        mainType: "R",
        type: "Rv",
        argroles: "so",
        connector: { atom: true, atomStr: "", root: verb, label: verb, mainType: "P", type: "Pv", role: "Pv.so" },
        children: [
          { atom: true, atomStr: "", root: subject, label: subject, mainType: "C", type: "Cc", role: "Cc" },
          { atom: true, atomStr: "", root: object, label: object, mainType: "C", type: "Cc", role: "Cc" },
        ],
      });
    const path = dbPath();
    const first = openSpace(path);
    const a = first.ingestWork({ title: "Asserts", scope: "project", doi: "10.8/a" });
    const b = first.ingestWork({ title: "Negates", scope: "project", doi: "10.8/b" });
    const claim = (workId: string, doi: string, polarity: string) =>
      first.remember({
        content: `The method improves recall (${polarity}).`,
        scope: "project",
        kind: "observation",
        sources: [{ type: "paper", reference: doi, workId, locator: "Results" }],
        tree: "typed",
        shTree: shTree("improves", "method", "recall"),
        polarity,
      });
    claim(a.id, "10.8/a", "affirmative");
    claim(b.id, "10.8/b", "negated");
    const core = "improve(o:recall,s:method)";
    expect(first.coreContradicted(core)).toBe(true);
    first.close();

    const second = openSpace(path);
    expect(second.coreContradicted(core)).toBe(true);
    expect(second.coreUnits(core, "affirmative")).toEqual([a.id]);
    expect(second.coreUnits(core, "negated")).toEqual([b.id]);
    second.close();
  });

  it("rebuilds the citation graph so traversal still chains after a reopen", () => {
    const path = dbPath();
    const first = openSpace(path);
    const a = first.ingestWork({ title: "Downstream", scope: "project", doi: "10.7/a" });
    const b = first.ingestWork({ title: "Middle", scope: "project", doi: "10.7/b" });
    const c = first.ingestWork({ title: "Foundational", scope: "project", doi: "10.7/c" });
    first.recordCitations(a.id, [{ doi: "10.7/b" }, { title: "Not ingested yet" }]);
    first.recordCitations(b.id, [{ doi: "10.7/c" }]);
    // citesOf returns a sorted, frozen list, so compare against sorted expectations.
    expect(first.citesOf(a.id, "references", true)).toEqual([b.id, c.id].sort());
    first.close();

    // The graph and its traversal survive a restart, rebuilt into the MeTTa space.
    const second = openSpace(path);
    expect(second.citesOf(a.id, "references", true)).toEqual([b.id, c.id].sort());
    expect(second.citesOf(c.id, "citedBy", true)).toEqual([a.id, b.id].sort());
    // The dangling reference is preserved but resolves to no work.
    const dangling = second.citationEdges(a.id).find((edge) => edge.citedKeyType === "title");
    expect(dangling?.citedWorkId).toBeUndefined();
    second.close();
  });
});
