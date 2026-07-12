import { describe, expect, it } from "vitest";

import {
  NORM_STATUSES,
  NormResolution,
  resolveNorms,
  resolveNormsBatch,
  type NormStatus,
} from "../src/deontic.js";
import type { Norm, NormMode } from "../src/models.js";

function norm(
  id: string,
  targetAction: string,
  mode: NormMode,
  priority: number,
  reason = id,
): Norm {
  return { id, targetAction, mode, priority, reason };
}

function expectedResolution(actionId: string, norms: readonly Norm[]): NormResolution {
  const applicable = norms.filter((candidate) => candidate.targetAction === actionId);
  if (applicable.length === 0) return new NormResolution("unregulated", [], 0);
  const priority = Math.max(...applicable.map((candidate) => candidate.priority));
  const strongest = applicable.filter((candidate) => candidate.priority === priority);
  const modes = new Set(strongest.map((candidate) => candidate.mode));
  let status: NormStatus;
  if (modes.has("forbid") && (modes.has("permit") || modes.has("oblige"))) {
    status = "conflict";
  } else if (modes.has("forbid")) {
    status = "forbidden";
  } else if (modes.has("oblige")) {
    status = "obligated";
  } else {
    status = "permitted";
  }
  return new NormResolution(
    status,
    strongest.map((candidate) => `${candidate.mode}:${candidate.reason}`),
    priority,
  );
}

describe("generic norm resolution", () => {
  it("returns an immutable unregulated result when no norm applies", () => {
    const result = resolveNorms("unmentioned", [norm("other", "another", "forbid", 5)]);

    expect(result).toEqual(new NormResolution("unregulated", [], 0));
    expect(result.blocksAction).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });

  it("uses only the strongest priority and preserves source reason order", () => {
    const result = resolveNorms("deploy", [
      norm("low", "deploy", "forbid", 1, "old freeze"),
      norm("top-a", "deploy", "oblige", 20, "approved release"),
      norm("other", "review", "forbid", 100, "different action"),
      norm("top-b", "deploy", "permit", 20, "change window"),
    ]);

    expect(result).toEqual(
      new NormResolution(
        "obligated",
        ["oblige:approved release", "permit:change window"],
        20,
      ),
    );
  });

  it.each([
    [["forbid", "permit"], "conflict"],
    [["forbid", "oblige"], "conflict"],
    [["forbid", "permit", "oblige"], "conflict"],
    [["oblige", "permit"], "obligated"],
    [["forbid"], "forbidden"],
    [["oblige"], "obligated"],
    [["permit"], "permitted"],
  ] as const)("resolves equal-priority modes %j as %s", (modes, expected) => {
    const norms = modes.map((mode, index) => norm(`n-${index}`, "action", mode, 7));
    const result = resolveNorms("action", norms);

    expect(result.status).toBe(expected);
    expect(result.blocksAction).toBe(expected === "forbidden" || expected === "conflict");
  });

  it("resolves arbitrary ordered IDs in one batch without prototype-key loss", () => {
    const actionIds = ["spaced action", "__proto__", "unicode-λ", "plain"];
    const norms = [
      norm("one", "__proto__", "forbid", 2),
      norm("two", "unicode-λ", "oblige", 4),
      norm("three", "spaced action", "permit", -1),
    ];
    const result = resolveNormsBatch(actionIds, norms);

    expect([...result.keys()]).toEqual(actionIds);
    expect(result.get("spaced action")?.status).toBe("permitted");
    expect(result.get("__proto__")?.status).toBe("forbidden");
    expect(result.get("unicode-λ")?.status).toBe("obligated");
    expect(result.get("plain")?.status).toBe("unregulated");
  });

  it("rejects duplicate action IDs and malformed runtime norms", () => {
    expect(() => resolveNormsBatch(["a", "a"], [])).toThrow("duplicate action id: a");
    expect(() =>
      resolveNorms("a", [norm("same", "a", "permit", 1), norm("same", "a", "forbid", 2)]),
    ).toThrow("duplicate norm ID: same");
    expect(() =>
      resolveNorms("a", [norm("bad", "a", "permit", Number.NaN)]),
    ).toThrow("norm priority must be a finite integer: bad");
    expect(() =>
      resolveNorms("a", [norm("fractional", "a", "permit", 1.5)]),
    ).toThrow("norm priority must be a finite integer: fractional");
    expect(() =>
      resolveNorms("a", [norm("unsafe", "a", "permit", 2 ** 53)]),
    ).toThrow("norm priority must be a finite integer: unsafe");
    expect(() =>
      resolveNorms("a", [
        { ...norm("bad", "a", "permit", 1), mode: "allow" as NormMode },
      ]),
    ).toThrow("unsupported norm mode for bad: allow");
    expect(() => resolveNorms(1 as any, [])).toThrow(
      "action ids must contain nonblank strings",
    );
    expect(() =>
      resolveNorms("a", [{ ...norm("bad", "a", "permit", 1), id: 7 as any }]),
    ).toThrow("norm id must not be blank");
    expect(() =>
      resolveNorms("a", [{ ...norm("bad", "a", "permit", 1), reason: 3 as any }]),
    ).toThrow("norm reason for bad must not be blank");
  });

  it("matches a generated reference oracle across priorities, modes, and actions", () => {
    const actionIds = Array.from({ length: 17 }, (_, index) => `action-${index}`);
    const modes: readonly NormMode[] = ["forbid", "oblige", "permit"];
    let seed = 0x5eed1234;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const norms = Array.from({ length: 240 }, (_, index) => {
      const action = actionIds[random() % actionIds.length]!;
      const mode = modes[random() % modes.length]!;
      const priority = (random() % 13) - 6;
      return norm(`generated-${index}`, action, mode, priority, `reason-${index}`);
    });

    const actual = resolveNormsBatch(actionIds, norms);
    for (const actionId of actionIds) {
      expect(actual.get(actionId)).toEqual(expectedResolution(actionId, norms));
    }
  });

  it("resolves 1,000 increasing priorities without a nested MeTTa priority AST", () => {
    const norms = Array.from({ length: 1_000 }, (_, index) =>
      norm(`norm-${index}`, "action", index % 2 === 0 ? "permit" : "oblige", index),
    );

    expect(resolveNorms("action", norms)).toMatchObject({
      status: "obligated",
      priority: 999,
      reasons: ["oblige:norm-999"],
    });
  });

  it("keeps the public status set exhaustive", () => {
    expect(NORM_STATUSES).toEqual([
      "unregulated",
      "permitted",
      "obligated",
      "forbidden",
      "conflict",
    ]);
  });
});
