import { describe, expect, it } from "vitest";

import {
  consensusDecision,
  createMotivationResult,
  motivationSummary,
} from "../src/motivation.js";
import type { GoalScenario } from "../src/models.js";

function neutralScenario(): GoalScenario {
  return {
    title: "Neutral motivation choice",
    goals: [
      {
        id: "goal_personal",
        owner: "person",
        statement: "Prefer the personal outcome",
        weight: 1,
        kind: "individual",
        required: false,
      },
      {
        id: "goal_shared",
        owner: "group",
        statement: "Prefer the shared outcome",
        weight: 1,
        kind: "collective",
        required: false,
      },
    ],
    norms: [],
    actions: [
      {
        id: "action_left",
        label: "Left option",
        description: "First caller option",
        satisfies: ["goal_personal"],
        evidenceQuery: "",
        evidenceAtoms: [],
        defaultStrength: 0.8,
        defaultConfidence: 0.9,
      },
      {
        id: "action_right",
        label: "Right option",
        description: "Second caller option",
        satisfies: ["goal_shared"],
        evidenceQuery: "",
        evidenceAtoms: [],
        defaultStrength: 0.4,
        defaultConfidence: 0.9,
      },
    ],
    notes: [],
  };
}

describe("generic motivation consensus", () => {
  it("canonicalizes tolerated consensus drift before normalization", () => {
    const input = {
      engine: "test motivation engine",
      individual_goals: [1],
      collective_goals: [0],
      candidates: [
        { id: "a", corr: [0], risk: 0 },
        { id: "b", corr: [0], risk: 0 },
      ],
      goal_pull: { individual: "a", collective: null },
      subsystem_preference: { individual: "a", collective: null },
      consensus_scores: { a: 0, b: 5e-13 },
      consensus: "a",
    } as const;

    const result = createMotivationResult(input);
    expect(result.consensus_scores).toEqual({ a: 0, b: 0 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates[0]!.corr)).toBe(true);
    expect(() => createMotivationResult({ ...input, consensus: "b" })).toThrow(
      "consensus is inconsistent",
    );
    expect(() =>
      createMotivationResult({ ...input, consensus_scores: { a: 0, b: 0.1 } }),
    ).toThrow("consensus score is inconsistent for b");
  });

  it("supports custom negative correlations and per-action risks", () => {
    const result = consensusDecision(neutralScenario(), {}, {
      correlations: {
        action_left: { goal_personal: 1, goal_shared: -1 },
        action_right: { goal_personal: -0.2, goal_shared: 0.8 },
      },
      risks: { action_left: 0.1, action_right: 0.2 },
    });

    expect(result.goal_pull).toEqual({ individual: "action_left", collective: "action_right" });
    expect(result.subsystem_preference).toEqual({
      individual: "action_left",
      collective: "action_right",
    });
    expect(result.consensus_scores.action_left).toBeCloseTo(-0.6, 12);
    expect(result.consensus_scores.action_right).toBeCloseTo(-0.15, 12);
    expect(result.consensus).toBe("action_right");
    expect(motivationSummary(result)).toEqual({
      engine: "goal consensus on @metta-ts",
      goal_pull: result.goal_pull,
      subsystem_preference: result.subsystem_preference,
      consensus: "action_right",
    });
  });

  it("derives omitted correlations from goal coverage and risks from evidence strength", () => {
    const result = consensusDecision(neutralScenario(), { action_left: 0.9 });

    expect(result.candidates).toEqual([
      { id: "action_left", corr: [1, 0], risk: 0.1 },
      { id: "action_right", corr: [0, 1], risk: 0.6 },
    ]);
    expect(result.goal_pull).toEqual({ individual: "action_left", collective: "action_right" });
  });

  it("marks an absent goal subsystem as not applicable", () => {
    const base = neutralScenario();
    const scenario: GoalScenario = {
      ...base,
      goals: [base.goals[1]!],
      actions: base.actions.map((action) => ({
        ...action,
        satisfies: action.satisfies.filter((goalId) => goalId === "goal_shared"),
      })),
    };
    const result = consensusDecision(scenario);

    expect(result.goal_pull).toEqual({ individual: null, collective: "action_right" });
    expect(result.subsystem_preference).toEqual({
      individual: null,
      collective: "action_right",
    });
    expect(result.consensus_scores.action_left).toBeCloseTo(-0.2, 12);
    expect(result.consensus_scores.action_right).toBeCloseTo(0.4, 12);
  });

  it("uses caller action order as the deterministic tie break", () => {
    const scenario = neutralScenario();
    const result = consensusDecision(scenario, {}, {
      correlations: {
        action_left: { goal_personal: 0, goal_shared: 0 },
        action_right: { goal_personal: 0, goal_shared: 0 },
      },
      risks: { action_left: 0, action_right: 0 },
    });

    expect(result.consensus_scores).toEqual({ action_left: 0, action_right: 0 });
    expect(result.consensus).toBe("action_left");
    expect(result.goal_pull).toEqual({ individual: "action_left", collective: "action_left" });
  });

  it("keeps large integer-valued weights on the floating-point path", () => {
    const base = neutralScenario();
    const scenario: GoalScenario = {
      ...base,
      goals: [
        { ...base.goals[0]!, weight: 2 ** 53 },
        base.goals[1]!,
      ],
    };

    const result = consensusDecision(scenario);

    expect(result.consensus_scores.action_left).toBeTypeOf("number");
    expect(Number.isFinite(result.consensus_scores.action_left)).toBe(true);
    expect(result.consensus).toBe("action_left");
  });

  it("balances MeTTa sums across 5,000 goals", () => {
    const goals = Array.from({ length: 5_000 }, (_, index) => ({
      id: `goal-${index}`,
      owner: "caller",
      statement: `Preserve goal ${index}`,
      weight: 1,
      kind: (index % 2 === 0 ? "individual" : "collective") as
        | "individual"
        | "collective",
      required: false,
    }));
    const base = neutralScenario();
    const scenario: GoalScenario = {
      ...base,
      goals,
      actions: [
        {
          ...base.actions[0]!,
          satisfies: goals.map((goal) => goal.id),
        },
      ],
    };

    const result = consensusDecision(scenario, { action_left: 1 });
    expect(result.consensus).toBe("action_left");
    expect(Number.isFinite(result.consensus_scores.action_left)).toBe(true);
  }, 20_000);

  it("treats prototype-named action and goal IDs as caller data", () => {
    const base = neutralScenario();
    const scenario: GoalScenario = {
      ...base,
      goals: [{ ...base.goals[0]!, id: "toString" }, base.goals[1]!],
      actions: [
        {
          ...base.actions[0]!,
          id: "__proto__",
          satisfies: ["toString"],
        },
        base.actions[1]!,
      ],
    };

    const result = consensusDecision(scenario);
    expect(result.candidates[0]).toMatchObject({ id: "__proto__", corr: [1, 0] });
    expect(Object.hasOwn(result.consensus_scores, "__proto__")).toBe(true);
    expect(result.consensus).toBe("__proto__");
  });

  it("rejects invalid correlations, risks, and evidence strengths", () => {
    const invalidCalls: Array<() => unknown> = [
      () =>
        consensusDecision(neutralScenario(), {}, {
          correlations: { action_left: { goal_personal: 1.01 } },
        }),
      () =>
        consensusDecision(neutralScenario(), {}, {
          correlations: { action_left: { goal_personal: Number.NaN } },
        }),
      () => consensusDecision(neutralScenario(), {}, { risks: { action_left: -0.01 } }),
      () => consensusDecision(neutralScenario(), {}, { risks: { action_left: 1.01 } }),
      () =>
        consensusDecision(neutralScenario(), {}, {
          risks: { action_left: Number.POSITIVE_INFINITY },
        }),
      () => consensusDecision(neutralScenario(), { action_left: 1.01 }),
      () => consensusDecision(neutralScenario(), { action_left: Number.NaN }),
      () => consensusDecision(neutralScenario(), 42 as any),
      () => consensusDecision(neutralScenario(), {}, 42 as any),
      () => consensusDecision(neutralScenario(), {}, { correlations: 42 as any }),
      () => consensusDecision(neutralScenario(), {}, { risks: 42 as any }),
      () =>
        consensusDecision(neutralScenario(), {}, {
          correlations: { action_left: 42 as any },
        }),
      () => consensusDecision(neutralScenario(), { missing_action: 0.5 }),
      () => consensusDecision(neutralScenario(), { action_left: null as any }),
      () => consensusDecision(neutralScenario(), {}, { risks: { missing_action: 0.5 } }),
      () => consensusDecision(neutralScenario(), {}, { risks: { action_left: null as any } }),
      () =>
        consensusDecision(neutralScenario(), {}, {
          correlations: { missing_action: { goal_personal: 1 } },
        }),
      () =>
        consensusDecision(neutralScenario(), {}, {
          correlations: { action_left: { missing_goal: 1 } },
        }),
      () =>
        consensusDecision(neutralScenario(), {}, {
          correlations: { action_left: { goal_personal: null as any } },
        }),
    ];

    for (const call of invalidCalls) expect(call).toThrow();
  });

  it("rejects a scenario without candidate actions", () => {
    const scenario: GoalScenario = { ...neutralScenario(), actions: [] };
    expect(() => consensusDecision(scenario)).toThrow(
      "a scenario must contain at least one candidate action",
    );
  });
});
