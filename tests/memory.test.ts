import { beforeEach, describe, expect, it } from "vitest";

import { createMemorySpace, MemorySpace } from "../src/memory.js";

let clock = 0;
function space(): MemorySpace {
  clock = 0;
  return createMemorySpace({ now: () => `2026-07-13T00:00:${String(clock++).padStart(2, "0")}Z` });
}

const userSource = { type: "user", reference: "current request" } as const;
const toolSource = { type: "tool", reference: "npm test" } as const;

describe("MemorySpace remember and read", () => {
  let mem: MemorySpace;
  beforeEach(() => {
    mem = space();
  });

  it("stores a proposition, makes it active, and reads it back", () => {
    const stored = mem.remember({
      content: "The user requires that the public API remains compatible.",
      scope: "project",
      kind: "user-statement",
      sources: [userSource],
    });
    expect(stored.id).toBe("prop-1");
    expect(stored.state).toBe("active");
    expect(stored.revision).toBe(1);
    expect(stored.sources).toHaveLength(1);
    expect(stored.sources[0]).toMatchObject({
      assertionId: "prop-1-s1",
      type: "user",
      reference: "current request",
      strength: 1,
      confidence: 1,
      state: "active",
    });
    expect(mem.isActive("prop-1")).toBe(true);
    expect(mem.get("prop-1")).toEqual(stored);
    expect(mem.activeInScope("project")).toEqual(["prop-1"]);
    expect(mem.activeOfKind("project", "user-statement")).toEqual(["prop-1"]);
  });

  it("accepts a caller-supplied id and rejects a duplicate", () => {
    mem.remember({ content: "A.", scope: "user", kind: "goal", sources: [userSource], id: "goal-x" });
    expect(mem.isActive("goal-x")).toBe(true);
    expect(() =>
      mem.remember({ content: "B.", scope: "user", kind: "goal", sources: [userSource], id: "goal-x" }),
    ).toThrow("proposition id already exists: goal-x");
  });

  it("stores an optional SH tree and a graded source truth", () => {
    const stored = mem.remember({
      content: "The dependency graph shows a cycle.",
      scope: "project",
      kind: "observation",
      tree: '(sh (tag P v so ()) "show" (args ()))',
      sources: [{ type: "tool", reference: "graph", strength: 0.8, confidence: 0.6 }],
    });
    expect(stored.tree).toBe('(sh (tag P v so ()) "show" (args ()))');
    expect(stored.sources[0]!.strength).toBeCloseTo(0.8);
    expect(stored.sources[0]!.confidence).toBeCloseTo(0.6);
  });
});

describe("MemorySpace multi-source aggregation", () => {
  it("survives losing one source while another stays active", () => {
    const mem = space();
    const stored = mem.remember({
      content: "The public API must not break.",
      scope: "project",
      kind: "user-statement",
      sources: [userSource, toolSource],
    });
    expect(stored.sources).toHaveLength(2);
    expect(mem.isActive(stored.id)).toBe(true);

    const first = mem.retractSource(stored.id, "prop-1-s1");
    expect(first.ok).toBe(true);
    expect(mem.isActive(stored.id)).toBe(true);

    const second = mem.retractSource(stored.id, "prop-1-s2");
    expect(second.ok).toBe(true);
    expect(mem.isActive(stored.id)).toBe(false);
    expect(mem.activeInScope("project")).toEqual([]);
  });
});

describe("MemorySpace retraction and supersession", () => {
  it("retracts a whole proposition and preserves its history", () => {
    const mem = space();
    const stored = mem.remember({ content: "Constraint.", scope: "user", kind: "norm", sources: [userSource] });
    const receipt = mem.retract(stored.id);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) {
      expect(receipt.revision).toBe(2);
      expect(receipt.proposition.state).toBe("retracted");
      expect(receipt.invalidated).toEqual([]);
    }
    expect(mem.isActive(stored.id)).toBe(false);
    expect(mem.get(stored.id)?.state).toBe("retracted");
  });

  it("supersedes a proposition: the old becomes inactive, the replacement active", () => {
    const mem = space();
    const old = mem.remember({ content: "Use Postgres 14.", scope: "user", kind: "user-statement", sources: [userSource] });
    const result = mem.supersede(old.id, {
      content: "Use Postgres 16.",
      scope: "user",
      kind: "user-statement",
      sources: [userSource],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.superseded.state).toBe("superseded");
      expect(result.superseded.supersededBy).toBe(result.replacement.id);
      expect(result.replacement.supersedes).toBe(old.id);
      expect(mem.isActive(old.id)).toBe(false);
      expect(mem.isActive(result.replacement.id)).toBe(true);
    }
  });

  it("rejects a stale expected revision and reports the actual one", () => {
    const mem = space();
    const stored = mem.remember({ content: "X.", scope: "project", kind: "goal", sources: [userSource] });
    mem.addSource(stored.id, toolSource); // revision -> 2
    const result = mem.retract(stored.id, 1);
    expect(result).toMatchObject({ ok: false, code: "stale_revision", expected: 1, actual: 2 });
    expect(mem.isActive(stored.id)).toBe(true);
  });

  it("returns not_found for an unknown id", () => {
    const mem = space();
    expect(mem.retract("nope")).toMatchObject({ ok: false, code: "not_found", id: "nope" });
    expect(mem.isActive("nope")).toBe(false);
  });

  it("keeps revisions monotonically increasing across mutations", () => {
    const mem = space();
    const stored = mem.remember({ content: "R.", scope: "project", kind: "observation", sources: [userSource] });
    expect(stored.revision).toBe(1);
    const add = mem.addSource(stored.id, toolSource);
    expect(add).toMatchObject({ revision: 2 });
    const src = mem.retractSource(stored.id, "prop-1-s1");
    expect(src.ok && src.revision).toBe(3);
  });
});

describe("MemorySpace derivations and reverse proof invalidation", () => {
  function withPremises(mem: MemorySpace): { a: string; b: string; d: string } {
    const a = mem.remember({ content: "Test auth_refresh fails.", scope: "project", kind: "observation", sources: [toolSource] }).id;
    const b = mem.remember({ content: "database imports authentication.", scope: "project", kind: "observation", sources: [toolSource] }).id;
    const d = mem.remember({ content: "The migration touched auth.", scope: "project", kind: "observation", sources: [toolSource] }).id;
    return { a, b, d };
  }

  it("activates a conclusion while its single proof holds and drops it when a premise is retracted", () => {
    const mem = space();
    const { a, b } = withPremises(mem);
    const conclusion = mem.derive({
      content: "upgrade_database conflicts with the authentication constraint.",
      rule: "rule-auth-conflict",
      premises: [a, b],
    });
    expect(conclusion.scope).toBe("derived");
    expect(conclusion.kind).toBe("derived-conclusion");
    expect(mem.isActive(conclusion.id)).toBe(true);

    const receipt = mem.retract(a);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) expect(receipt.invalidated).toContain(conclusion.id);
    expect(mem.isActive(conclusion.id)).toBe(false);
  });

  it("preserves a conclusion with an alternate proof and drops it when every proof breaks", () => {
    const mem = space();
    const { a, b, d } = withPremises(mem);
    const conclusion = mem.derive({ content: "Conflict.", rule: "rule-1", premises: [a, b] });
    mem.addProof(conclusion.id, "rule-2", [a, d]);
    expect(mem.isActive(conclusion.id)).toBe(true);

    // break the first proof only
    const first = mem.retract(b);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.invalidated).not.toContain(conclusion.id);
    expect(mem.isActive(conclusion.id)).toBe(true);

    // break the second proof too
    const second = mem.retract(d);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.invalidated).toContain(conclusion.id);
    expect(mem.isActive(conclusion.id)).toBe(false);
  });

  it("invalidates a transitive chain and restores nothing until re-derived", () => {
    const mem = space();
    const root = mem.remember({ content: "Root fact.", scope: "project", kind: "observation", sources: [toolSource] }).id;
    const mid = mem.derive({ content: "Mid.", rule: "r1", premises: [root] });
    const top = mem.derive({ content: "Top.", rule: "r2", premises: [mid.id] });
    expect(mem.isActive(top.id)).toBe(true);

    const receipt = mem.retract(root);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) expect([...receipt.invalidated].sort()).toEqual([mid.id, top.id].sort());
    expect(mem.isActive(mid.id)).toBe(false);
    expect(mem.isActive(top.id)).toBe(false);
  });

  it("recomputes a dependent decision when its premise is superseded", () => {
    const mem = space();
    const premise = mem.remember({ content: "Use Postgres 14.", scope: "user", kind: "user-statement", sources: [userSource] }).id;
    const conclusion = mem.derive({ content: "Plan targets Postgres 14.", rule: "plan", premises: [premise] });
    expect(mem.isActive(conclusion.id)).toBe(true);
    const result = mem.supersede(premise, {
      content: "Use Postgres 16.",
      scope: "user",
      kind: "user-statement",
      sources: [userSource],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.invalidated).toContain(conclusion.id);
    expect(mem.isActive(conclusion.id)).toBe(false);
  });

  it("rejects a derivation whose premise does not exist", () => {
    const mem = space();
    expect(() => mem.derive({ content: "C.", rule: "r", premises: ["missing"] })).toThrow(
      "premise does not exist: missing",
    );
  });
});

describe("MemorySpace input validation", () => {
  let mem: MemorySpace;
  beforeEach(() => {
    mem = space();
  });

  it("rejects an unknown scope or kind", () => {
    expect(() => mem.remember({ content: "A.", scope: "global" as any, kind: "goal", sources: [userSource] })).toThrow(
      "scope must be one of",
    );
    expect(() => mem.remember({ content: "A.", scope: "user", kind: "belief" as any, sources: [userSource] })).toThrow(
      "kind must be one of",
    );
  });

  it("rejects empty content and empty sources", () => {
    expect(() => mem.remember({ content: "   ", scope: "user", kind: "goal", sources: [userSource] })).toThrow(
      "content must not be empty",
    );
    expect(() => mem.remember({ content: "A.", scope: "user", kind: "goal", sources: [] })).toThrow(
      "sources must contain at least one entry",
    );
  });

  it("rejects an out-of-range source truth and unknown fields", () => {
    expect(() =>
      mem.remember({ content: "A.", scope: "user", kind: "goal", sources: [{ type: "t", reference: "r", strength: 2 }] }),
    ).toThrow("must be a finite number within [0, 1]");
    expect(() =>
      mem.remember({ content: "A.", scope: "user", kind: "goal", sources: [userSource], extra: 1 } as any),
    ).toThrow("remember input contains unknown fields: extra");
  });
});
