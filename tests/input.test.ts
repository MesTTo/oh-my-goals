import { describe, expect, it } from "vitest";

import {
  GoalChainerInputSchema,
  goalChainerInputSchema,
  parseGoalChainerInput,
  type GoalChainerInputSource,
} from "../src/input.js";

type CompleteTestInput = Omit<GoalChainerInputSource, "evidence"> & {
  evidence: NonNullable<GoalChainerInputSource["evidence"]>;
};

function validInput(): CompleteTestInput {
  return {
    scenario: {
      title: "Release review",
      goals: [
        {
          id: "verified-change",
          owner: "maintainers",
          statement: "Only apply verified changes",
          weight: 2,
          kind: "collective" as const,
        },
      ],
      norms: [
        {
          id: "review-required",
          mode: "oblige" as const,
          targetAction: "review-change",
          reason: "A review is required before applying the change",
        },
      ],
      actions: [
        {
          id: "review-change",
          label: "Review change",
          description: "Inspect the change and its verification results",
          satisfies: ["verified-change"],
        },
      ],
    },
    evidence: {
      "review-change": {
        strength: 0.8,
        confidence: 0.9,
        source: "verification",
      },
    },
  };
}

function issuesFor(input: unknown) {
  const result = goalChainerInputSchema.safeParse(input);
  if (result.success) throw new Error("Expected GoalChainer input validation to fail");
  return result.error.issues;
}

function withGoal(patch: Partial<CompleteTestInput["scenario"]["goals"][number]>) {
  const input = validInput();
  input.scenario.goals[0] = { ...input.scenario.goals[0]!, ...patch };
  return input;
}

function withAction(patch: Partial<CompleteTestInput["scenario"]["actions"][number]>) {
  const input = validInput();
  input.scenario.actions[0] = { ...input.scenario.actions[0]!, ...patch };
  return input;
}

function withEvidence(
  patch: Partial<NonNullable<CompleteTestInput["evidence"][string]>>,
) {
  const input = validInput();
  input.evidence["review-change"] = {
    ...input.evidence["review-change"]!,
    ...patch,
  };
  return input;
}

describe("GoalChainer structured input", () => {
  it("rejects class and accessor-backed input before Zod reads values", () => {
    class Box {
      scenario = validInput().scenario;
      evidence = validInput().evidence;
    }
    expect(goalChainerInputSchema.safeParse(new Box()).success).toBe(false);

    const input = validInput() as any;
    const scenario = input.scenario;
    Object.defineProperty(input, "scenario", {
      enumerable: true,
      get: () => scenario,
    });
    const result = goalChainerInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain("must be an enumerable data property");
    }
  });

  it("parses caller data, applies defaults, and returns frozen model values", () => {
    const parsed = parseGoalChainerInput(validInput());

    expect(parsed.scenario.goals[0]).toMatchObject({ required: false });
    expect(parsed.scenario.norms[0]).toMatchObject({ priority: 0 });
    expect(parsed.scenario.actions[0]).toMatchObject({
      evidenceQuery: "",
      evidenceAtoms: [],
      defaultStrength: 0.5,
      defaultConfidence: 0,
    });
    expect(parsed.scenario.notes).toEqual([]);
    expect(parsed.evidence["review-change"]).toMatchObject({
      projection: null,
      proofs: [],
    });
    expect(parsed.evidence["review-change"]).not.toHaveProperty("deontic");
    expect(parsed.evidence["review-change"]).not.toHaveProperty("expectation");

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.scenario)).toBe(true);
    expect(Object.isFrozen(parsed.scenario.goals)).toBe(true);
    expect(Object.isFrozen(parsed.scenario.goals[0])).toBe(true);
    expect(Object.isFrozen(parsed.scenario.norms[0])).toBe(true);
    expect(Object.isFrozen(parsed.scenario.actions[0])).toBe(true);
    expect(Object.isFrozen(parsed.scenario.actions[0]!.evidenceAtoms)).toBe(true);
    expect(Object.isFrozen(parsed.evidence)).toBe(true);
    expect(Object.isFrozen(parsed.evidence["review-change"])).toBe(true);
    expect(Object.isFrozen(parsed.evidence["review-change"]!.proofs)).toBe(true);
  });

  it("materializes omitted evidence as an empty frozen record", () => {
    const { evidence: _, ...input } = validInput();
    const parsed = parseGoalChainerInput(input);
    expect(parsed.evidence).toEqual({});
    expect(Object.isFrozen(parsed.evidence)).toBe(true);
  });

  it("rejects non-plain evidence records instead of treating them as empty", () => {
    for (const evidence of [new Date(0), new Map()]) {
      expect(() => parseGoalChainerInput({ ...validInput(), evidence })).toThrow(
        "evidence must be a plain object record",
      );
    }
  });

  it("rejects static evidence that contradicts its retained projection", () => {
    const input = validInput();
    input.evidence["review-change"]!.projection = "(Answer (STV 0.1 0.1))";
    expect(() => parseGoalChainerInput(input)).toThrow(
      "Explicit truth value disagrees with projection STV",
    );
  });

  it("exports both schema naming conventions as the same schema", () => {
    expect(GoalChainerInputSchema).toBe(goalChainerInputSchema);
  });

  it.each([
    ["top-level", () => ({ ...validInput(), unexpected: true }), []],
    [
      "scenario",
      () => {
        const input = validInput();
        return { ...input, scenario: { ...input.scenario, unexpected: true } };
      },
      ["scenario"],
    ],
    [
      "goal",
      () => {
        const input = validInput();
        return {
          ...input,
          scenario: {
            ...input.scenario,
            goals: [{ ...input.scenario.goals[0], unexpected: true }],
          },
        };
      },
      ["scenario", "goals", 0],
    ],
    [
      "norm",
      () => {
        const input = validInput();
        return {
          ...input,
          scenario: {
            ...input.scenario,
            norms: [{ ...input.scenario.norms[0], unexpected: true }],
          },
        };
      },
      ["scenario", "norms", 0],
    ],
    [
      "action",
      () => {
        const input = validInput();
        return {
          ...input,
          scenario: {
            ...input.scenario,
            actions: [{ ...input.scenario.actions[0], default_strength: 0.7 }],
          },
        };
      },
      ["scenario", "actions", 0],
    ],
    [
      "evidence value",
      () => {
        const input = validInput();
        return {
          ...input,
          evidence: {
            "review-change": { ...input.evidence["review-change"], unexpected: true },
          },
        };
      },
      ["evidence", "review-change"],
    ],
  ] as const)("rejects unknown keys at the %s boundary", (_label, build, expectedPath) => {
    const issues = issuesFor(build());
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", path: expectedPath }),
    );
  });

  it.each([
    [
      "goal",
      () => {
        const input = validInput();
        return {
          ...input,
          scenario: {
            ...input.scenario,
            goals: [...input.scenario.goals, { ...input.scenario.goals[0] }],
          },
        };
      },
      ["scenario", "goals", 1, "id"],
    ],
    [
      "norm",
      () => {
        const input = validInput();
        return {
          ...input,
          scenario: {
            ...input.scenario,
            norms: [...input.scenario.norms, { ...input.scenario.norms[0] }],
          },
        };
      },
      ["scenario", "norms", 1, "id"],
    ],
    [
      "action",
      () => {
        const input = validInput();
        return {
          ...input,
          scenario: {
            ...input.scenario,
            actions: [...input.scenario.actions, { ...input.scenario.actions[0] }],
          },
        };
      },
      ["scenario", "actions", 1, "id"],
    ],
  ] as const)("rejects duplicate %s IDs at the duplicate", (entity, build, expectedPath) => {
    const issues = issuesFor(build());
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "custom",
        message: expect.stringContaining(`Duplicate ${entity} ID`),
        path: expectedPath,
      }),
    );
  });

  it("rejects actions that satisfy an unknown goal", () => {
    const input = validInput();
    input.scenario.actions[0]!.satisfies = ["missing-goal"];
    expect(issuesFor(input)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("unknown goal ID"),
        path: ["scenario", "actions", 0, "satisfies", 0],
      }),
    );
  });

  it("rejects norms that target an unknown action", () => {
    const input = validInput();
    input.scenario.norms[0]!.targetAction = "missing-action";
    expect(issuesFor(input)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("unknown action ID"),
        path: ["scenario", "norms", 0, "targetAction"],
      }),
    );
  });

  it("rejects evidence for an unknown action", () => {
    const input = validInput();
    const evidence = input.evidence["review-change"];
    expect(
      issuesFor({ ...input, evidence: { "missing-action": evidence } }),
    ).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("unknown action ID"),
        path: ["evidence", "missing-action"],
      }),
    );
  });

  it("rejects scenarios without candidate actions", () => {
    const input = validInput();
    expect(
      issuesFor({
        ...input,
        scenario: { ...input.scenario, norms: [], actions: [] },
        evidence: {},
      }),
    ).toContainEqual(
      expect.objectContaining({
        message: "scenario.actions must contain at least one action",
        path: ["scenario", "actions"],
      }),
    );
  });

  it("safe-parses blank query fields as validation errors", () => {
    const blankQuery = withAction({ evidenceQuery: "   " });
    const queryResult = goalChainerInputSchema.safeParse(blankQuery);
    expect(queryResult.success).toBe(false);
    if (!queryResult.success) {
      expect(queryResult.error.issues).toContainEqual(
        expect.objectContaining({ path: ["scenario", "actions", 0, "evidenceQuery"] }),
      );
    }

    const blankAtom = withAction({ evidenceAtoms: [" "] });
    const atomResult = goalChainerInputSchema.safeParse(blankAtom);
    expect(atomResult.success).toBe(false);
    if (!atomResult.success) {
      expect(atomResult.error.issues).toContainEqual(
        expect.objectContaining({ path: ["scenario", "actions", 0, "evidenceAtoms", 0] }),
      );
    }
  });

  it("rejects contextual atoms without a query", () => {
    const result = goalChainerInputSchema.safeParse(
      withAction({ evidenceAtoms: ["(Observed review-change)"] }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          message: "Evidence atoms require a nonempty evidence query",
          path: ["scenario", "actions", 0, "evidenceQuery"],
        }),
      );
    }
  });

  it.each([
    ["negative goal weight", ["scenario", "goals", 0, "weight"], () => withGoal({ weight: -1 })],
    [
      "nonfinite goal weight",
      ["scenario", "goals", 0, "weight"],
      () => withGoal({ weight: Number.POSITIVE_INFINITY }),
    ],
    [
      "action strength below zero",
      ["scenario", "actions", 0, "defaultStrength"],
      () => withAction({ defaultStrength: -0.1 }),
    ],
    [
      "action confidence above one",
      ["scenario", "actions", 0, "defaultConfidence"],
      () => withAction({ defaultConfidence: 1.1 }),
    ],
    [
      "nonfinite action strength",
      ["scenario", "actions", 0, "defaultStrength"],
      () => withAction({ defaultStrength: Number.NaN }),
    ],
    [
      "evidence strength below zero",
      ["evidence", "review-change", "strength"],
      () => withEvidence({ strength: -0.1 }),
    ],
    [
      "evidence confidence above one",
      ["evidence", "review-change", "confidence"],
      () => withEvidence({ confidence: 1.1 }),
    ],
    [
      "nonfinite evidence confidence",
      ["evidence", "review-change", "confidence"],
      () => withEvidence({ confidence: Number.NEGATIVE_INFINITY }),
    ],
    [
      "evidence expectation above one",
      ["evidence", "review-change", "expectation"],
      () => withEvidence({ expectation: 1.1 }),
    ],
    [
      "blank evidence source",
      ["evidence", "review-change", "source"],
      () => withEvidence({ source: "   " }),
    ],
  ] as const)("rejects %s with a field path", (_label, expectedPath, build) => {
    expect(issuesFor(build())).toContainEqual(expect.objectContaining({ path: expectedPath }));
  });

  it("accepts probability boundaries and preserves explicit evidence details", () => {
    const input = validInput();
    input.scenario.goals[0]!.weight = 0;
    input.scenario.goals.push({
      id: "positive-weight",
      owner: "maintainers",
      statement: "Keep the aggregate goal weight positive",
      weight: 1,
      kind: "collective",
    });
    input.scenario.actions[0] = {
      ...input.scenario.actions[0]!,
      defaultStrength: 0,
      defaultConfidence: 1,
    };
    input.evidence["review-change"] = {
      strength: 1,
      confidence: 0,
      source: "verification",
      projection: "reviewed(change)",
      proofs: ["check-passed"],
      deontic: "obligated",
      expectation: 0.25,
    };

    const parsed = parseGoalChainerInput(input);
    expect(parsed.scenario.actions[0]).toMatchObject({
      defaultStrength: 0,
      defaultConfidence: 1,
    });
    expect(parsed.evidence["review-change"]).toMatchObject({
      strength: 1,
      confidence: 0,
      projection: "reviewed(change)",
      proofs: ["check-passed"],
      deontic: "obligated",
      expectation: 0.25,
    });
  });
});
