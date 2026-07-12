import { describe, expect, it } from "vitest";

import {
  BlockedDecisionError,
  InvalidDecisionError,
  MissingExecutorError,
  detectLeaks,
  executeDecision,
  redactRecord,
} from "../src/execute.js";
import type { Decision } from "../src/models.js";

function neutralDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    actionId: "action_run",
    label: "Run caller action",
    status: "recommended",
    score: 0.8,
    goalScore: 1,
    individualScore: 1,
    collectiveScore: 1,
    evidence: {
      strength: 0.8,
      confidence: 0.9,
      source: "caller",
      projection: null,
      proofs: [],
      deontic: "unregulated",
      expectation: 0.77,
    },
    normStatus: "unregulated",
    normReasons: [],
    satisfiedGoals: [],
    missingRequiredGoals: [],
    warnings: [],
    metadata: {},
    ...overrides,
  };
}

describe("generic action execution", () => {
  it("runs a synchronous caller executor and returns a receipt", async () => {
    const decision = neutralDecision();
    const receipt = await executeDecision(decision, { value: 4 }, {
      action_run: (context, selected) => ({ doubled: context.value * 2, id: selected.actionId }),
    });

    expect(receipt).toEqual({
      actionId: "action_run",
      status: "recommended",
      output: { doubled: 8, id: "action_run" },
    });
  });

  it("awaits an asynchronous caller executor", async () => {
    const receipt = await executeDecision(neutralDecision(), "value", {
      action_run: async (context) => {
        await Promise.resolve();
        return context.toUpperCase();
      },
    });

    expect(receipt.output).toBe("VALUE");
  });

  it("rejects blocked decisions with the decision-bearing error class", async () => {
    const decision = neutralDecision({
      status: "blocked",
      score: -1,
      normStatus: "forbidden",
      evidence: { ...neutralDecision().evidence, deontic: "forbidden" },
    });
    const error = await executeDecision(decision, null, {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlockedDecisionError);
    expect(error).toMatchObject({
      name: "BlockedDecisionError",
      message: "refusing to execute blocked action: action_run",
      decision,
    });
  });

  it("fails closed for a blocking norm or malformed external decision status", async () => {
    const inconsistent = neutralDecision({
      status: "recommended",
      score: -1,
      normStatus: "forbidden",
      evidence: { ...neutralDecision().evidence, deontic: "forbidden" },
    });
    await expect(
      executeDecision(inconsistent, null, { action_run: () => "must not run" }),
    ).rejects.toBeInstanceOf(InvalidDecisionError);

    const malformed = { ...neutralDecision(), status: "nonsense" } as unknown as Decision;
    await expect(
      executeDecision(malformed, null, { action_run: () => "must not run" }),
    ).rejects.toBeInstanceOf(InvalidDecisionError);

    const mismatchedEvidence = {
      ...neutralDecision(),
      evidence: { ...neutralDecision().evidence, deontic: "forbidden" },
    } as unknown as Decision;
    await expect(
      executeDecision(mismatchedEvidence, null, { action_run: () => "must not run" }),
    ).rejects.toBeInstanceOf(InvalidDecisionError);
  });

  it("fails closed for forged recommendation invariants", async () => {
    const executor = { action_run: () => "must not run" };
    const missingRequired = neutralDecision({
      missingRequiredGoals: ["required-review"],
    });
    await expect(executeDecision(missingRequired, null, executor)).rejects.toMatchObject({
      name: "InvalidDecisionError",
      message: expect.stringContaining("expected candidate"),
    });

    const weakScore = neutralDecision({ score: 0 });
    await expect(executeDecision(weakScore, null, executor)).rejects.toMatchObject({
      name: "InvalidDecisionError",
      message: expect.stringContaining("expected weak"),
    });

    const nonfiniteScore = neutralDecision({ score: Number.NaN });
    await expect(executeDecision(nonfiniteScore, null, executor)).rejects.toMatchObject({
      name: "InvalidDecisionError",
      message: expect.stringContaining("score must be finite"),
    });

    const malformedMissing = {
      ...neutralDecision(),
      missingRequiredGoals: null,
    } as unknown as Decision;
    await expect(executeDecision(malformedMissing, null, executor)).rejects.toMatchObject({
      name: "InvalidDecisionError",
      message: expect.stringContaining("missing required goals must be an array"),
    });

    const invalidBlockedScore = neutralDecision({
      status: "blocked",
      score: 999,
      normStatus: "forbidden",
      evidence: { ...neutralDecision().evidence, deontic: "forbidden" },
    });
    await expect(executeDecision(invalidBlockedScore, null, executor)).rejects.toMatchObject({
      name: "InvalidDecisionError",
      message: expect.stringContaining("blocked decision score must be -1"),
    });
  });

  it("reconstructs the full external decision before dispatch", async () => {
    let calls = 0;
    const executor = {
      action_run: () => {
        calls += 1;
        return "must not run";
      },
    };
    const malformed = [
      { ...neutralDecision(), actionId: 7 },
      { ...neutralDecision(), label: 7 },
      { ...neutralDecision(), goalScore: Number.NaN },
      { ...neutralDecision(), goalScore: 2 },
      {
        ...neutralDecision(),
        evidence: { ...neutralDecision().evidence, strength: Number.NaN },
      },
    ] as unknown as Decision[];

    for (const decision of malformed) {
      await expect(executeDecision(decision, null, executor)).rejects.toBeInstanceOf(
        InvalidDecisionError,
      );
    }
    expect(calls).toBe(0);
  });

  it("reports a missing executor with its action ID", async () => {
    const error = await executeDecision(neutralDecision(), null, {}).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MissingExecutorError);
    expect(error).toMatchObject({
      name: "MissingExecutorError",
      message: "no executor is registered for action: action_run",
      actionId: "action_run",
    });
  });

  it("rejects accessor-backed executor registries before dispatch", async () => {
    const executors = {} as Record<string, () => string>;
    Object.defineProperty(executors, "action_run", {
      enumerable: true,
      get: () => () => "must not run",
    });

    await expect(executeDecision(neutralDecision(), null, executors)).rejects.toThrow(
      "action executors.action_run must be an enumerable data property",
    );
  });

  it("does not treat Object.prototype members as registered executors", async () => {
    const inherited = neutralDecision({ actionId: "toString" });
    await expect(executeDecision(inherited, null, {})).rejects.toMatchObject({
      name: "MissingExecutorError",
      actionId: "toString",
    });

    const own = neutralDecision({ actionId: "__proto__" });
    const executors = Object.fromEntries([
      ["__proto__", () => "explicit executor"],
    ]);
    await expect(executeDecision(own, null, executors)).resolves.toMatchObject({
      actionId: "__proto__",
      output: "explicit executor",
    });
  });

  it("propagates the original synchronous and asynchronous executor failures", async () => {
    const syncFailure = new Error("synchronous caller failure");
    const asyncFailure = new Error("asynchronous caller failure");

    await expect(
      executeDecision(neutralDecision(), null, {
        action_run: () => {
          throw syncFailure;
        },
      }),
    ).rejects.toBe(syncFailure);
    await expect(
      executeDecision(neutralDecision(), null, {
        action_run: async () => Promise.reject(asyncFailure),
      }),
    ).rejects.toBe(asyncFailure);
  });
});

describe("generic disclosure controls", () => {
  it("redacts restricted fields before applying an allowlist", () => {
    const input = { private_value: "secret", public_value: "visible", omitted_value: 3 };
    const output = redactRecord(input, {
      restrictedFields: ["private_value"],
      allowedFields: ["public_value"],
      replacement: "[removed]",
    });

    expect(output).toEqual({ private_value: "[removed]", public_value: "visible" });
    expect(input).toEqual({
      private_value: "secret",
      public_value: "visible",
      omitted_value: 3,
    });
  });

  it("supports falsy replacement values and the default replacement", () => {
    expect(redactRecord({ a: 1, b: 2 }, { restrictedFields: ["a"] })).toEqual({
      a: "[redacted]",
      b: 2,
    });
    expect(
      redactRecord({ a: 1, b: 2 }, { restrictedFields: ["a"], replacement: false }),
    ).toEqual({ a: false, b: 2 });
    expect(
      redactRecord({ a: 1, b: 2 }, { restrictedFields: ["a"], replacement: null }),
    ).toEqual({ a: null, b: 2 });
  });

  it("rejects malformed redaction policy arrays", () => {
    expect(() =>
      redactRecord({ secret: "VALUE" }, { restrictedFields: "secret" as any }),
    ).toThrow("restricted fields must be an array");
    expect(() =>
      redactRecord({ "42": "VALUE" }, { restrictedFields: [42] as any }),
    ).toThrow("restricted fields[0] must be a string");
    expect(() =>
      redactRecord(
        { secret: "VALUE" },
        { restrictedFields: [], allowedFields: "secret" as any },
      ),
    ).toThrow("allowed fields must be an array");
    expect(() =>
      redactRecord(
        { public: "ok", credential: "leak" },
        { restrictedFields: [], allowedField: ["public"] } as any,
      ),
    ).toThrow("redaction policy contains unknown fields: allowedField");
  });

  it("preserves prototype-named fields as ordinary redacted data", () => {
    const input = Object.fromEntries([
      ["__proto__", "private"],
      ["toString", "public"],
    ]);
    const output = redactRecord(input, { restrictedFields: ["__proto__"] });

    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(output).toEqual(
      Object.fromEntries([
        ["__proto__", "[redacted]"],
        ["toString", "public"],
      ]),
    );
  });

  it("finds exact nested leaks once and ignores empty restricted values", () => {
    expect(
      detectLeaks(
        { nested: { value: "prefix-sensitive-value-suffix" }, repeated: "sensitive-value" },
        ["sensitive-value", "sensitive-value", "", "not-present"],
      ),
    ).toEqual({ safe: false, leaked: ["sensitive-value"] });
    expect(detectLeaks({ value: "clear" }, ["sensitive-value"])).toEqual({
      safe: true,
      leaked: [],
    });
  });

  it("detects restricted numeric and boolean primitive text", () => {
    expect(
      detectLeaks(
        { order_id: 19942, flag: true, missing: null },
        ["19942", "true", "null"],
      ),
    ).toEqual({ safe: false, leaked: ["19942", "true", "null"] });
  });

  it("detects escaped string content without matching JSON syntax", () => {
    const restricted = 'line one\nline "two" {value}';
    expect(detectLeaks({ nested: restricted }, [restricted])).toEqual({
      safe: false,
      leaked: [restricted],
    });
    expect(detectLeaks({ nested: "clear" }, ["{"])).toEqual({ safe: true, leaked: [] });
  });

  it("rejects cyclic and otherwise non-JSON artifacts with a typed error", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => detectLeaks(cyclic, ["value"])).toThrowError(TypeError);
    expect(() => detectLeaks(cyclic, ["value"])).toThrow(
      /artifact must be JSON-serializable for leak detection/,
    );
    expect(() => detectLeaks({ value: 1n }, ["value"])).toThrowError(TypeError);
    expect(() => detectLeaks({ value: undefined }, ["value"])).toThrowError(TypeError);
    expect(() => detectLeaks({ value: () => "value" }, ["value"])).toThrowError(TypeError);
    expect(() => detectLeaks({ value: Number.NaN }, ["value"])).toThrowError(TypeError);
    expect(() => detectLeaks(new Date(0), ["value"])).toThrowError(TypeError);
  });
});
