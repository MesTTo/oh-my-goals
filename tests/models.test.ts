import { describe, expect, it } from "vitest";

import {
  createCandidateAction,
  createDecision,
  createEvidenceProjection,
  createGoal,
  createGoalScenario,
  createNorm,
  deriveDecisionStatus,
  decisionToDict,
  roundN,
  type CandidateActionInput,
  type Decision,
} from "../src/models.js";

const actionInput = (overrides: Partial<CandidateActionInput> = {}): CandidateActionInput => ({
  id: "review",
  label: "Review",
  description: "Review the change",
  satisfies: ["safe-change"],
  ...overrides,
});

describe("Runtime model factories", () => {
  it("applies model defaults", () => {
    const goal = createGoal({
      id: "safe-change",
      owner: "team",
      statement: "Keep the change safe",
      weight: 1,
      kind: "collective",
    });
    const norm = createNorm({
      id: "review-first",
      mode: "oblige",
      targetAction: "review",
      reason: "A review is required",
    });
    const action = createCandidateAction(actionInput());
    const evidence = createEvidenceProjection({
      strength: 0.8,
      confidence: 0.9,
      source: "test",
    });
    const scenario = createGoalScenario({
      title: "Change",
      goals: [goal],
      norms: [norm],
      actions: [action],
    });
    const decision = createDecision({
      actionId: action.id,
      label: action.label,
      status: "recommended",
      score: 0.8,
      goalScore: 1,
      individualScore: 0,
      collectiveScore: 1,
      evidence: createEvidenceProjection({
        ...evidence,
        deontic: "obligated",
      }),
      normStatus: "obligated",
    });

    expect(goal.required).toBe(false);
    expect(norm.priority).toBe(0);
    expect(action).toMatchObject({
      evidenceQuery: "",
      evidenceAtoms: [],
      defaultStrength: 0.5,
      defaultConfidence: 0,
    });
    expect(evidence).toMatchObject({
      projection: null,
      proofs: [],
      deontic: "unregulated",
      expectation: 0,
    });
    expect(scenario.notes).toEqual([]);
    expect(decision).toMatchObject({
      normReasons: [],
      satisfiedGoals: [],
      missingRequiredGoals: [],
      warnings: [],
      metadata: {},
    });
  });

  it("derives and enforces the universal decision status rule", () => {
    expect(deriveDecisionStatus(0.72, 0, "unregulated")).toBe("recommended");
    expect(deriveDecisionStatus(0.72, 1, "unregulated")).toBe("candidate");
    expect(deriveDecisionStatus(0.5, 0, "permitted")).toBe("candidate");
    expect(deriveDecisionStatus(0.5 - Number.EPSILON, 0, "obligated")).toBe("weak");
    expect(deriveDecisionStatus(1, 0, "forbidden")).toBe("blocked");

    const evidence = createEvidenceProjection({
      strength: 0.8,
      confidence: 0.9,
      source: "test",
    });
    expect(() =>
      createDecision({
        actionId: "review",
        label: "Review",
        status: "recommended",
        score: 0.9,
        goalScore: 1,
        individualScore: 1,
        collectiveScore: 1,
        evidence,
        normStatus: "unregulated",
        missingRequiredGoals: ["required-review"],
      }),
    ).toThrow("expected candidate");
    expect(() =>
      createDecision({
        actionId: "review",
        label: "Review",
        status: "recommended",
        score: 0,
        goalScore: 1,
        individualScore: 1,
        collectiveScore: 1,
        evidence,
        normStatus: "unregulated",
      }),
    ).toThrow("expected weak");
    expect(() =>
      createDecision({
        actionId: "review",
        label: "Review",
        status: "blocked",
        score: 999,
        goalScore: 1,
        individualScore: 1,
        collectiveScore: 1,
        evidence: createEvidenceProjection({ ...evidence, deontic: "forbidden" }),
        normStatus: "forbidden",
      }),
    ).toThrow("blocked decision score must be -1");
  });

  it("rejects invalid numeric boundaries", () => {
    expect(() =>
      createGoal({
        id: "bad-goal",
        owner: "team",
        statement: "Invalid",
        weight: -Number.MIN_VALUE,
        kind: "collective",
      }),
    ).toThrowError("goal weight must be non-negative: bad-goal");
    expect(() =>
      createGoal({
        id: "nonfinite-goal",
        owner: "team",
        statement: "Invalid",
        weight: Number.POSITIVE_INFINITY,
        kind: "collective",
      }),
    ).toThrowError("goal weight must be finite: nonfinite-goal");

    expect(createCandidateAction(actionInput({ defaultStrength: 0 })).defaultStrength).toBe(0);
    expect(createCandidateAction(actionInput({ defaultStrength: 1 })).defaultStrength).toBe(1);
    expect(() =>
      createCandidateAction(actionInput({ defaultStrength: -Number.MIN_VALUE })),
    ).toThrowError("default_strength outside [0, 1]: review");
    expect(() =>
      createCandidateAction(actionInput({ defaultStrength: 1 + Number.EPSILON })),
    ).toThrowError("default_strength outside [0, 1]: review");
    expect(() => createCandidateAction(actionInput({ defaultStrength: Number.NaN }))).toThrowError(
      "default_strength outside [0, 1]: review",
    );
    expect(() => createCandidateAction(actionInput({ defaultConfidence: Number.NaN }))).toThrowError(
      "default_confidence outside [0, 1]: review",
    );
    expect(() => createCandidateAction(actionInput({ defaultConfidence: -Number.MIN_VALUE }))).toThrowError(
      "default_confidence outside [0, 1]: review",
    );
    expect(() => createCandidateAction(actionInput({ defaultConfidence: 1 + Number.EPSILON }))).toThrowError(
      "default_confidence outside [0, 1]: review",
    );
    expect(() =>
      createCandidateAction(actionInput({ evidenceAtoms: ["(Observed review)"] })),
    ).toThrow("action evidence atoms require a query: review");
    expect(() =>
      createCandidateAction(actionInput({ satisfies: ["safe-change", "safe-change"] })),
    ).toThrow("duplicate satisfies goal ID: safe-change");
    expect(() =>
      createNorm({
        id: "fractional-priority",
        mode: "permit",
        targetAction: "review",
        reason: "invalid priority",
        priority: 1.5,
      }),
    ).toThrow("norm priority must be a finite integer");
    expect(() =>
      createNorm({
        id: "unsafe-priority",
        mode: "permit",
        targetAction: "review",
        reason: "invalid priority",
        priority: 2 ** 53,
      }),
    ).toThrow("norm priority must be a finite integer");
    expect(() =>
      createEvidenceProjection({ strength: Number.NaN, confidence: 0.5, source: "test" }),
    ).toThrow("evidence strength must be within [0, 1]");
    expect(() =>
      createEvidenceProjection({ strength: 0.5, confidence: 2, source: "test" }),
    ).toThrow("evidence confidence must be within [0, 1]");
    expect(() =>
      createEvidenceProjection({ strength: 0.5, confidence: 0.5, source: " " }),
    ).toThrow("evidence source must not be blank");
    expect(() =>
      createEvidenceProjection({
        strength: 0.5,
        confidence: 0.5,
        expectation: Number.POSITIVE_INFINITY,
        source: "test",
      }),
    ).toThrow("evidence expectation must be within [0, 1]");
    expect(() =>
      createGoalScenario({ title: "Empty", goals: [], norms: [], actions: [] }),
    ).toThrow("a scenario must contain at least one candidate action");
    expect(() =>
      createGoalScenario({
        title: "Weightless",
        goals: [
          createGoal({
            id: "zero",
            owner: "caller",
            statement: "A weightless goal",
            weight: 0,
            kind: "individual",
          }),
        ],
        norms: [],
        actions: [createCandidateAction(actionInput())],
      }),
    ).toThrow("aggregate goal weight must be positive");
    expect(() =>
      createGoalScenario({
        title: "Overflow",
        goals: [
          createGoal({
            id: "large-a",
            owner: "caller",
            statement: "Large weight",
            weight: 1e308,
            kind: "individual",
          }),
          createGoal({
            id: "large-b",
            owner: "caller",
            statement: "Another large weight",
            weight: 1e308,
            kind: "collective",
          }),
        ],
        norms: [],
        actions: [createCandidateAction(actionInput())],
      }),
    ).toThrow("aggregate goal weight must be finite");
  });

  it("rejects JavaScript values that violate exported factory types", () => {
    expect(() =>
      createCandidateAction(actionInput({ defaultStrength: "0.5" as any })),
    ).toThrow("default_strength outside [0, 1]");
    expect(() =>
      createCandidateAction(actionInput({ defaultConfidence: "0.9" as any })),
    ).toThrow("default_confidence outside [0, 1]");
    expect(() =>
      createGoal({
        id: "typed-goal",
        owner: "caller",
        statement: "Preserve types",
        weight: 1,
        kind: "collective",
        required: "false" as any,
      }),
    ).toThrow("required flag must be boolean");

    const projectionInput = {
      strength: 0.5,
      confidence: 0.8,
      source: "test",
    };
    expect(() =>
      createEvidenceProjection({ ...projectionInput, strength: "0.5" as any }),
    ).toThrow("evidence strength must be within [0, 1]");
    expect(() =>
      createEvidenceProjection({ ...projectionInput, confidence: "0.8" as any }),
    ).toThrow("evidence confidence must be within [0, 1]");
    expect(() =>
      createEvidenceProjection({ ...projectionInput, expectation: "0.7" as any }),
    ).toThrow("evidence expectation must be within [0, 1]");
    expect(() =>
      createEvidenceProjection({ ...projectionInput, projection: 42 as any }),
    ).toThrow("evidence projection must be a string or null");
    expect(() =>
      createEvidenceProjection({ ...projectionInput, proofs: [1] as any }),
    ).toThrow("evidence proofs[0] must be a string");
    expect(() =>
      createEvidenceProjection({
        ...projectionInput,
        projection: "(Answer (STV 0.1 0.8))",
      }),
    ).toThrow("projection STV disagrees");

    expect(() =>
      createGoal({
        id: "typo",
        owner: "caller",
        statement: "Reject misspelled safety fields",
        weight: 1,
        kind: "individual",
        requried: true,
      } as any),
    ).toThrow("unknown fields: requried");
    expect(() =>
      createNorm({
        id: "typo",
        mode: "permit",
        targetAction: "review",
        reason: "Reject misspelled priority",
        prioritty: 100,
      } as any),
    ).toThrow("unknown fields: prioritty");
    expect(() =>
      createCandidateAction({
        ...actionInput(),
        defaultStrenght: 1,
      } as any),
    ).toThrow("unknown fields: defaultStrenght");
    expect(() =>
      createEvidenceProjection({
        ...projectionInput,
        expecttion: 1,
      } as any),
    ).toThrow("unknown fields: expecttion");

    const getterGoal = {
      owner: "caller",
      statement: "Reject accessor-backed records",
      weight: 1,
      kind: "individual",
    } as any;
    Object.defineProperty(getterGoal, "id", {
      enumerable: true,
      get: () => "getter-goal",
    });
    expect(() => createGoal(getterGoal)).toThrow("must be an enumerable data property");

    const decisionInput = {
      actionId: "review",
      label: "Review",
      status: "recommended",
      score: 0.9,
      goalScore: 1,
      individualScore: 1,
      collectiveScore: 1,
      evidence: createEvidenceProjection(projectionInput),
      normStatus: "unregulated",
    } as const;
    expect(() =>
      createDecision({ ...decisionInput, score: -Number.MIN_VALUE, status: "weak" }),
    ).toThrow("nonblocked decision score must be within [0, 1.02]");
    expect(() =>
      createDecision({ ...decisionInput, score: 1.02000000001 }),
    ).toThrow("nonblocked decision score must be within [0, 1.02]");
    expect(() =>
      createDecision({ ...decisionInput, missingRequiredGoals: [1] as any }),
    ).toThrow("decision missing required goals[0] must be a string");
    expect(() => createDecision({ ...decisionInput, warnings: [1] as any })).toThrow(
      "decision warnings[0] must be a string",
    );
    expect(() =>
      createDecision({ ...decisionInput, metadata: { source: 1 } as any }),
    ).toThrow("decision metadata.source must be a string");
    expect(() => createDecision({ ...decisionInput, goalScore: 2 })).toThrow(
      "decision goalScore must be finite and within [0, 1]",
    );
    expect(() =>
      createDecision({ ...decisionInput, satisfiedGoals: ["goal", "goal"] }),
    ).toThrow("decision satisfied goals contains duplicate ID: goal");
    expect(() =>
      createDecision({
        ...decisionInput,
        status: "candidate",
        satisfiedGoals: ["goal"],
        missingRequiredGoals: ["goal"],
      }),
    ).toThrow("decision goal cannot be both satisfied and missing: goal");

    const sparseActions: any[] = [];
    sparseActions.length = 1;
    expect(() =>
      createGoalScenario({
        title: "Sparse scenario",
        goals: [
          createGoal({
            id: "goal",
            owner: "caller",
            statement: "Keep arrays dense",
            weight: 1,
            kind: "collective",
          }),
        ],
        norms: [],
        actions: sparseActions,
      }),
    ).toThrow("scenario actions must not contain holes");
  });

  it("freezes dataclass fields and copies tuple-like inputs", () => {
    const satisfies = ["safe-change"];
    const evidenceAtoms = ["review"];
    const action = createCandidateAction(
      actionInput({ satisfies, evidenceAtoms, evidenceQuery: "(Review change)" }),
    );
    satisfies.push("later-goal");
    evidenceAtoms.push("later-evidence");

    expect(action.satisfies).toEqual(["safe-change"]);
    expect(action.evidenceAtoms).toEqual(["review"]);
    expect(Object.isFrozen(action)).toBe(true);
    expect(Object.isFrozen(action.satisfies)).toBe(true);
    expect(Object.isFrozen(action.evidenceAtoms)).toBe(true);
  });

  it("snapshots scenario models and enforces relational integrity", () => {
    const rawGoal = {
      id: "declared",
      owner: "caller",
      statement: "Keep the declaration valid",
      weight: 1,
      kind: "collective" as const,
      required: false,
    };
    const rawAction = actionInput({ satisfies: ["declared"] });
    const scenario = createGoalScenario({
      title: "Snapshot",
      goals: [rawGoal],
      norms: [],
      actions: [rawAction],
    });
    rawGoal.weight = -9;
    rawAction.satisfies.push("undeclared");

    expect(scenario.goals[0]!.weight).toBe(1);
    expect(scenario.actions[0]!.satisfies).toEqual(["declared"]);
    expect(() =>
      createGoalScenario({
        title: "Dangling",
        goals: [{ ...rawGoal, weight: 1 }],
        norms: [],
        actions: [actionInput({ satisfies: ["undeclared"] })],
      }),
    ).toThrow("references unknown goal ID");
    expect(() =>
      createGoalScenario({
        title: "Duplicate",
        goals: [{ ...rawGoal, weight: 1 }, { ...rawGoal, weight: 1 }],
        norms: [],
        actions: [actionInput({ satisfies: ["declared"] })],
      }),
    ).toThrow("duplicate goal ID");
  });

  it("serializes the complete Python-compatible decision dictionary", () => {
    const decision = createDecision({
      actionId: "review",
      label: "Review",
      status: "recommended",
      score: 1.0199995,
      goalScore: 0.9345675,
      individualScore: 0.5,
      collectiveScore: 0,
      evidence: createEvidenceProjection({
        strength: 0.12345678,
        confidence: 0.87654321,
        source: "verification",
        projection: "(Acceptable review)",
        proofs: ["proof-a"],
        deontic: "obligated",
        expectation: 0.6,
      }),
      normStatus: "obligated",
      normReasons: ["oblige:review required"],
      satisfiedGoals: ["safe-change"],
      missingRequiredGoals: [],
      warnings: ["review before execution"],
      metadata: { engine: "metta-ts" },
    });

    const serialized = decisionToDict(decision);
    expect(serialized).toEqual({
      action_id: "review",
      label: "Review",
      status: "recommended",
      score: 1.0199995,
      goal_score: 0.934567,
      individual_score: 0.5,
      collective_score: 0,
      evidence: {
        strength: 0.123457,
        confidence: 0.876543,
        source: "verification",
        projection: "(Acceptable review)",
        proofs: ["proof-a"],
      },
      norm_status: "obligated",
      norm_reasons: ["oblige:review required"],
      satisfied_goals: ["safe-change"],
      missing_required_goals: [],
      warnings: ["review before execution"],
      metadata: { engine: "metta-ts" },
    });
    expect((serialized.evidence as { deontic?: unknown })).not.toHaveProperty("deontic");
    expect((serialized.evidence as { expectation?: unknown })).not.toHaveProperty("expectation");

    (serialized.satisfied_goals as string[]).push("later-goal");
    (serialized.metadata as Record<string, string>).engine = "changed";
    expect(decision.satisfiedGoals).toEqual(["safe-change"]);
    expect(decision.metadata).toEqual({ engine: "metta-ts" });
  });

  it("retains the authoritative score across a status threshold", () => {
    const decision = createDecision({
      actionId: "near-threshold",
      label: "Near threshold",
      status: "candidate",
      score: 0.7199996,
      goalScore: 1,
      individualScore: 1,
      collectiveScore: 1,
      evidence: createEvidenceProjection({
        strength: 0.5,
        confidence: 0.5,
        source: "test",
      }),
      normStatus: "unregulated",
    });

    expect(decisionToDict(decision).score).toBe(0.7199996);
    expect(() => decisionToDict({ ...decision, score: Number.NaN } as Decision)).toThrow(
      "decision score must be finite",
    );
  });
});

describe("Python-compatible decimal rounding", () => {
  it.each([
    [2.675, 2, 2.67],
    [1.005, 2, 1],
    [2.685, 2, 2.69],
    [0.5, 0, 0],
    [1.5, 0, 2],
    [2.5, 0, 2],
    [3.5, 0, 4],
    [1.2345675, 6, 1.234568],
    [1.2345685, 6, 1.234568],
    [123456.7890125, 6, 123456.789012],
    [0.0000005, 6, 0],
    [0.0000015, 6, 0.000002],
  ])("roundN(%s, %i) returns the Python result", (value, digits, expected) => {
    expect(roundN(value, digits)).toBe(expected);
  });

  it("preserves Python's negative zero results", () => {
    expect(Object.is(roundN(-0.5, 0), -0)).toBe(true);
    expect(Object.is(roundN(-0.0000005, 6), -0)).toBe(true);
  });

  it("is sign-symmetric and idempotent over a deterministic numeric sample", () => {
    let state = 0x6d2b79f5;
    for (let index = 0; index < 1_000; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const value = ((state / 0x1_0000_0000) * 2 - 1) * 1_000_000;
      const digits = [0, 3, 4, 6][index % 4]!;
      const rounded = roundN(value, digits);
      expect(roundN(-value, digits)).toBe(-rounded);
      expect(roundN(rounded, digits)).toBe(rounded);
    }
  });

  it("handles non-finite values and rejects fractional digit counts", () => {
    expect(roundN(Number.POSITIVE_INFINITY, 6)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(roundN(Number.NaN, 6))).toBe(true);
    expect(() => roundN("not-a-number" as any, 6)).toThrowError("value must be a number");
    expect(() => roundN(1.25, 1.5)).toThrowError("digits must be an integer");
    expect(() => roundN(Number.MAX_VALUE, -308)).toThrowError(
      "rounded value too large to represent",
    );
  });
});
