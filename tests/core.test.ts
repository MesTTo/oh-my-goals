import { describe, expect, it } from "vitest";

import {
  GoalChainer,
  evaluateScenario,
  goalChainerRunToJson,
  runGoalChainer,
  type GoalChainerRun,
} from "../src/core.js";
import { goalChainerInputSchema, parseGoalChainerInput } from "../src/input.js";
import { StaticEvidenceReasoner } from "../src/reasoner.js";
import { DecisionEngine, normalizeFiniteMotivation } from "../src/score.js";

interface NeutralIds {
  personalGoal: string;
  sharedGoal: string;
  preferredAction: string;
  alternateAction: string;
}

const DEFAULT_IDS: NeutralIds = {
  personalGoal: "goal_personal",
  sharedGoal: "goal_shared",
  preferredAction: "action_preferred",
  alternateAction: "action_alternate",
};

function neutralInput(ids: NeutralIds = DEFAULT_IDS): Record<string, unknown> {
  return {
    scenario: {
      title: "Neutral caller choice",
      goals: [
        {
          id: ids.personalGoal,
          owner: "person",
          statement: "Preserve the requested quality",
          weight: 1,
          kind: "individual",
          required: true,
        },
        {
          id: ids.sharedGoal,
          owner: "group",
          statement: "Complete the shared objective",
          weight: 1,
          kind: "collective",
          required: true,
        },
      ],
      norms: [],
      actions: [
        {
          id: ids.preferredAction,
          label: "Preferred option",
          description: "Satisfies both caller goals",
          satisfies: [ids.personalGoal, ids.sharedGoal],
        },
        {
          id: ids.alternateAction,
          label: "Alternate option",
          description: "Satisfies one caller goal",
          satisfies: [ids.personalGoal],
        },
      ],
      notes: ["Caller-owned neutral scenario"],
    },
    evidence: {
      [ids.preferredAction]: { strength: 0.9, confidence: 1, source: "caller" },
      [ids.alternateAction]: { strength: 0.4, confidence: 1, source: "caller" },
    },
  };
}

describe("generic GoalChainer core", () => {
  it("selects the strongest caller-supplied option and serializes the run", () => {
    const run = new GoalChainer({ motivation: false }).evaluate(neutralInput());

    expect(run.selected.actionId).toBe(DEFAULT_IDS.preferredAction);
    expect(run.selected.status).toBe("recommended");
    expect(run.selected.score).toBeCloseTo(0.882, 12);
    expect(run.decisions.map((decision) => decision.actionId)).toEqual([
      DEFAULT_IDS.preferredAction,
      DEFAULT_IDS.alternateAction,
    ]);
    expect(goalChainerRunToJson(run)).toMatchObject({
      scenario: "Neutral caller choice",
      scenario_declaration: {
        title: "Neutral caller choice",
        goals: expect.arrayContaining([
          expect.objectContaining({ id: DEFAULT_IDS.personalGoal, owner: "person", weight: 1 }),
        ]),
        actions: expect.arrayContaining([
          expect.objectContaining({
            id: DEFAULT_IDS.preferredAction,
            default_confidence: 0,
          }),
        ]),
        norms: [],
        notes: ["Caller-owned neutral scenario"],
      },
      selected: DEFAULT_IDS.preferredAction,
      status: "recommended",
      tied_actions: [DEFAULT_IDS.preferredAction],
      selection_tied: false,
      automatic_execution_allowed: true,
      motivation: null,
      motivation_audit: null,
    });
  });

  it("prevents automatic execution when top actions tie exactly", () => {
    const input = neutralInput() as any;
    input.scenario.actions[1].satisfies = [...input.scenario.actions[0].satisfies];
    input.evidence[DEFAULT_IDS.alternateAction] = {
      ...input.evidence[DEFAULT_IDS.preferredAction],
    };

    const run = runGoalChainer(input, { motivation: false });
    expect(run.selected.status).toBe("recommended");
    expect(run.selectionTied).toBe(true);
    expect(run.tiedActionIds).toEqual([
      DEFAULT_IDS.preferredAction,
      DEFAULT_IDS.alternateAction,
    ]);
    expect(run.automaticExecutionAllowed).toBe(false);
    expect(goalChainerRunToJson(run)).toMatchObject({
      selection_tied: true,
      automatic_execution_allowed: false,
    });
  });

  it("treats binary64-near top scores as tied for execution safety", () => {
    const input = neutralInput() as any;
    input.scenario.actions[1].satisfies = [...input.scenario.actions[0].satisfies];
    input.evidence[DEFAULT_IDS.preferredAction] = {
      strength: 0.9,
      confidence: 1,
      source: "caller",
    };
    input.evidence[DEFAULT_IDS.alternateAction] = {
      strength: 0.9 - 1e-12,
      confidence: 1,
      source: "caller",
    };

    const run = runGoalChainer(input, { motivation: false });
    expect(run.decisions[0]!.score - run.decisions[1]!.score).toBeLessThan(1e-12);
    expect(run.selectionTied).toBe(true);
    expect(run.automaticExecutionAllowed).toBe(false);
    expect(run.tiedActionIds).toEqual([
      DEFAULT_IDS.preferredAction,
      DEFAULT_IDS.alternateAction,
    ]);
  });

  it("rejects contradictory or forged run receipts", () => {
    const run = runGoalChainer(neutralInput(), { motivation: false });
    const alternate = run.decisions[1]!;
    expect(() =>
      goalChainerRunToJson({ ...run, selected: alternate } as GoalChainerRun),
    ).toThrow("selected decision must equal the first ranked decision");
    expect(() =>
      goalChainerRunToJson({
        ...run,
        tiedActionIds: ["ghost"],
      } as GoalChainerRun),
    ).toThrow("tied action IDs disagree");

    const tiedInput = neutralInput() as any;
    tiedInput.scenario.actions[1].satisfies = [...tiedInput.scenario.actions[0].satisfies];
    tiedInput.evidence[DEFAULT_IDS.alternateAction] = {
      ...tiedInput.evidence[DEFAULT_IDS.preferredAction],
    };
    const tied = runGoalChainer(tiedInput, { motivation: false });
    const reversed = [...tied.decisions].reverse();
    expect(() =>
      goalChainerRunToJson({
        ...tied,
        decisions: reversed,
        selected: reversed[0]!,
        tiedActionIds: reversed.map((decision) => decision.actionId),
      } as GoalChainerRun),
    ).toThrow("canonical score ranking");
  });

  it("cannot cross the recommendation threshold with tolerated score drift", () => {
    const input = neutralInput() as any;
    input.scenario.goals = [input.scenario.goals[0]];
    input.scenario.actions = [input.scenario.actions[0]];
    input.scenario.actions[0].satisfies = [DEFAULT_IDS.personalGoal];
    input.evidence = {
      [DEFAULT_IDS.preferredAction]: {
        strength: (0.72 - 0.42) / 0.38 - 1e-12,
        confidence: 1,
        source: "threshold probe",
      },
    };
    const run = runGoalChainer(input, { motivation: false });
    expect(run.selected.status).toBe("candidate");
    const forged = {
      ...run.selected,
      score: 0.7200000000001,
      status: "recommended",
    } as typeof run.selected;

    expect(() =>
      goalChainerRunToJson({
        ...run,
        decisions: [forged],
        selected: forged,
        automaticExecutionAllowed: true,
      }),
    ).toThrow("status disagrees");
  });

  it("blocks forbidden and conflicting options at their strongest norm priority", () => {
    const input = neutralInput() as any;
    input.scenario.actions.push({
      id: "action_open",
      label: "Open option",
      description: "Has no policy restriction",
      satisfies: [],
    });
    input.scenario.norms.push(
      {
        id: "norm_conflict_forbid",
        mode: "forbid",
        targetAction: DEFAULT_IDS.preferredAction,
        reason: "caller restriction",
        priority: 8,
      },
      {
        id: "norm_conflict_permit",
        mode: "permit",
        targetAction: DEFAULT_IDS.preferredAction,
        reason: "caller allowance",
        priority: 8,
      },
      {
        id: "norm_forbid",
        mode: "forbid",
        targetAction: DEFAULT_IDS.alternateAction,
        reason: "group restriction",
        priority: 4,
      },
    );
    input.evidence.action_open = { strength: 0.2, confidence: 1, source: "caller" };

    const run = runGoalChainer(input, { motivation: false });
    const conflict = run.decisions.find(
      (decision) => decision.actionId === DEFAULT_IDS.preferredAction,
    )!;
    const forbidden = run.decisions.find(
      (decision) => decision.actionId === DEFAULT_IDS.alternateAction,
    )!;

    expect(run.selected.actionId).toBe("action_open");
    expect(conflict).toMatchObject({ status: "blocked", score: -1, normStatus: "conflict" });
    expect(conflict.normReasons).toEqual([
      "forbid:caller restriction",
      "permit:caller allowance",
    ]);
    expect(forbidden).toMatchObject({ status: "blocked", score: -1, normStatus: "forbidden" });
  });

  it("uses reasoner deontic verdicts and makes incompatible static norms explicit", () => {
    const dynamicOnly = neutralInput() as any;
    dynamicOnly.evidence[DEFAULT_IDS.preferredAction].deontic = "forbidden";
    dynamicOnly.evidence[DEFAULT_IDS.preferredAction].expectation = 0.17;
    dynamicOnly.evidence[DEFAULT_IDS.preferredAction].source = "dynamic policy engine";

    const first = runGoalChainer(dynamicOnly, { motivation: false }).decisions.find(
      (decision) => decision.actionId === DEFAULT_IDS.preferredAction,
    )!;
    expect(first).toMatchObject({ status: "blocked", normStatus: "forbidden" });
    expect(first.evidence).toMatchObject({ deontic: "forbidden", expectation: 0.17 });
    expect(first.normReasons).toEqual(["reasoner:forbidden"]);
    expect(first.metadata).toMatchObject({
      evidence_source: "dynamic policy engine",
      reasoner_source: "static evidence",
      reasoner_deontic: "forbidden",
    });

    const incompatible = neutralInput() as any;
    incompatible.evidence[DEFAULT_IDS.preferredAction].deontic = "forbidden";
    incompatible.scenario.norms.push({
      id: "permit-preferred",
      mode: "permit",
      targetAction: DEFAULT_IDS.preferredAction,
      reason: "caller permission",
      priority: 5,
    });
    const conflict = runGoalChainer(incompatible, { motivation: false }).decisions.find(
      (decision) => decision.actionId === DEFAULT_IDS.preferredAction,
    )!;
    expect(conflict).toMatchObject({ status: "blocked", normStatus: "conflict" });
    expect(conflict.normReasons).toEqual([
      "permit:caller permission",
      "reasoner:forbidden",
    ]);
  });

  it("recommends an obligated action that satisfies every required goal", () => {
    const input = neutralInput() as any;
    input.scenario.norms.push({
      id: "require-preferred",
      mode: "oblige",
      targetAction: DEFAULT_IDS.preferredAction,
      reason: "caller requires the fully covering action",
      priority: 5,
    });

    const preferred = runGoalChainer(input, { motivation: false }).decisions.find(
      (decision) => decision.actionId === DEFAULT_IDS.preferredAction,
    )!;

    expect(preferred).toMatchObject({
      status: "recommended",
      normStatus: "obligated",
      individualScore: 1,
      collectiveScore: 1,
      missingRequiredGoals: [],
    });
    expect(preferred.score).toBeCloseTo(0.982, 12);
    expect(preferred.normReasons).toEqual([
      "oblige:caller requires the fully covering action",
    ]);
  });

  it("reports required-goal misses and uses declared evidence defaults when evidence is omitted", () => {
    const input = neutralInput() as any;
    delete input.evidence;
    for (const action of input.scenario.actions) {
      delete action.defaultStrength;
      delete action.defaultConfidence;
    }

    const run = runGoalChainer(input, { motivation: false });
    const preferred = run.decisions.find(
      (decision) => decision.actionId === DEFAULT_IDS.preferredAction,
    )!;
    const alternate = run.decisions.find(
      (decision) => decision.actionId === DEFAULT_IDS.alternateAction,
    )!;

    expect(preferred.evidence).toMatchObject({
      strength: 0.5,
      confidence: 0,
      source: "declared action default",
      deontic: "unregulated",
      expectation: 0.5,
    });
    expect(alternate.missingRequiredGoals).toEqual([DEFAULT_IDS.sharedGoal]);
    expect(alternate.individualScore).toBe(1);
    expect(alternate.collectiveScore).toBe(0);
    expect(alternate.warnings).toEqual([`missing required goals: ${DEFAULT_IDS.sharedGoal}`]);
    expect(alternate.status).not.toBe("recommended");
  });

  it("projects each action once even when motivation is enabled", () => {
    const parsed = parseGoalChainerInput(neutralInput());
    const calls = new Map<string, number>();
    const reasoner = new StaticEvidenceReasoner(parsed.evidence);
    const run = evaluateScenario(parsed.scenario, {
      source: reasoner.source,
      project(action) {
        calls.set(action.id, (calls.get(action.id) ?? 0) + 1);
        return reasoner.project(action);
      },
    });

    expect(run.selected.actionId).toBe(DEFAULT_IDS.preferredAction);
    expect(Object.fromEntries(calls)).toEqual({
      [DEFAULT_IDS.preferredAction]: 1,
      [DEFAULT_IDS.alternateAction]: 1,
    });
  });

  it("fails closed when optional safety fields are inherited from a polluted prototype", () => {
    const parsed = parseGoalChainerInput(neutralInput());
    Object.defineProperty(Object.prototype, "deontic", {
      configurable: true,
      value: "obligated",
    });
    try {
      expect(() =>
        evaluateScenario(parsed.scenario, {
          source: "custom reasoner",
          project: () => ({
            strength: 0.8,
            confidence: 0.8,
            source: "custom result",
            projection: null,
            proofs: [],
            expectation: 0.7,
          } as any),
        }, { motivation: false }),
      ).toThrow("evidence projection.deontic must be an own property when present");
    } finally {
      delete (Object.prototype as any).deontic;
    }
  });

  it("evaluates one action through the public scoring contract", () => {
    const parsed = parseGoalChainerInput(neutralInput());
    const action = parsed.scenario.actions[0]!;
    const reasoner = new StaticEvidenceReasoner(parsed.evidence);
    const engine = new DecisionEngine(reasoner);

    const offline = engine.evaluateAction(parsed.scenario, action);
    const motivated = engine.evaluateAction(parsed.scenario, action, 0.25);

    expect(offline).toMatchObject({
      actionId: DEFAULT_IDS.preferredAction,
      score: 0.882,
      status: "recommended",
    });
    expect(motivated.score).toBeCloseTo(0.477, 12);
    expect(motivated.status).toBe("weak");
    expect(() => engine.evaluateAction(parsed.scenario, action, 1.01)).toThrow(
      /normalized motivation/,
    );
    expect(() =>
      engine.evaluateAction(
        parsed.scenario,
        {
          ...action,
          id: "undeclared-action",
          satisfies: ["missing-goal"],
        },
      ),
    ).toThrow("action is not declared in the scenario");

    let getterCalls = 0;
    const accessorAction = { ...action } as any;
    Object.defineProperty(accessorAction, "id", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return action.id;
      },
    });
    expect(() => engine.evaluateAction(parsed.scenario, accessorAction)).toThrow(
      "candidate action.id must be an enumerable data property",
    );
    expect(getterCalls).toBe(0);

    expect(() => new DecisionEngine(reasoner, 42 as any)).toThrow(
      "motivation scores must be a plain object record",
    );
    expect(() =>
      new DecisionEngine(reasoner, { [DEFAULT_IDS.preferredAction]: 0 }).rank(parsed.scenario),
    ).toThrow(`motivation scores missing action IDs: ${DEFAULT_IDS.alternateAction}`);
  });

  it("normalizes finite motivation scores without binary64 overflow or underflow", () => {
    expect(() => normalizeFiniteMotivation("" as any)).toThrow(
      "motivation values must be an array",
    );
    const parsed = parseGoalChainerInput(neutralInput());
    const reasoner = new StaticEvidenceReasoner(parsed.evidence);
    const extremes = new DecisionEngine(reasoner, {
      [DEFAULT_IDS.preferredAction]: -Number.MAX_VALUE,
      [DEFAULT_IDS.alternateAction]: Number.MAX_VALUE,
    }).rank(parsed.scenario);
    const subnormals = new DecisionEngine(reasoner, {
      [DEFAULT_IDS.preferredAction]: Number.MIN_VALUE,
      [DEFAULT_IDS.alternateAction]: Number.MIN_VALUE * 2,
    }).rank(parsed.scenario);

    for (const decision of [...extremes, ...subnormals]) {
      expect(Number.isFinite(decision.score)).toBe(true);
    }
    expect(
      extremes.find((decision) => decision.actionId === DEFAULT_IDS.preferredAction)!.metadata
        .motivation,
    ).toBe("0.0000");
    expect(
      extremes.find((decision) => decision.actionId === DEFAULT_IDS.alternateAction)!.metadata
        .motivation,
    ).toBe("1.0000");
    expect(
      subnormals.find((decision) => decision.actionId === DEFAULT_IDS.preferredAction)!.metadata
        .motivation,
    ).toBe("0.0000");
    expect(
      subnormals.find((decision) => decision.actionId === DEFAULT_IDS.alternateAction)!.metadata
        .motivation,
    ).toBe("1.0000");
  });

  it("normalizes more values than V8 accepts as spread arguments", () => {
    const values = Array.from({ length: 130_000 }, (_, index) => index - 65_000);
    const normalized = normalizeFiniteMotivation(values);

    expect(normalized).toHaveLength(values.length);
    expect(normalized[0]).toBe(0);
    expect(normalized.at(-1)).toBe(1);
    expect(normalized.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(
      true,
    );
  });

  it("does not turn nonpositive consensus into recommendation support", () => {
    expect(normalizeFiniteMotivation([-2, -1, 0])).toEqual([0, 0, 0]);
    expect(normalizeFiniteMotivation([1, 2, 3])).toEqual([0, 0.5, 1]);
    expect(normalizeFiniteMotivation([3, 3])).toEqual([1, 1]);
    const input = neutralInput() as any;
    input.scenario.goals = [input.scenario.goals[0]];
    input.scenario.goals[0].required = false;
    input.scenario.actions = [input.scenario.actions[0]];
    input.scenario.actions[0].satisfies = [];
    input.evidence = {
      [DEFAULT_IDS.preferredAction]: {
        strength: 1,
        confidence: 1,
        source: "caller",
      },
    };

    const run = runGoalChainer(input, {
      motivation: {
        correlations: { [DEFAULT_IDS.preferredAction]: { [DEFAULT_IDS.personalGoal]: -1 } },
        risks: { [DEFAULT_IDS.preferredAction]: 1 },
      },
    });
    expect(run.motivation!.consensus_scores[DEFAULT_IDS.preferredAction]).toBe(-2);
    expect(run.selected.metadata.motivation).toBe("0.0000");
    expect(run.selected.status).toBe("weak");
    expect(run.automaticExecutionAllowed).toBe(false);
  });

  it("rejects duplicate IDs, dangling references, extra keys, and empty action lists", () => {
    const cases: Array<[string, (input: any) => void, RegExp]> = [
      [
        "duplicate goal",
        (input) => input.scenario.goals.push({ ...input.scenario.goals[0] }),
        /Duplicate goal ID/,
      ],
      [
        "duplicate norm",
        (input) => {
          const norm = {
            id: "norm_same",
            mode: "permit",
            targetAction: DEFAULT_IDS.preferredAction,
            reason: "caller rule",
          };
          input.scenario.norms.push(norm, { ...norm });
        },
        /Duplicate norm ID/,
      ],
      [
        "duplicate action",
        (input) => input.scenario.actions.push({ ...input.scenario.actions[0] }),
        /Duplicate action ID/,
      ],
      [
        "unknown goal",
        (input) => input.scenario.actions[0].satisfies.push("goal_missing"),
        /references unknown goal ID/,
      ],
      [
        "unknown norm action",
        (input) =>
          input.scenario.norms.push({
            id: "norm_unknown",
            mode: "permit",
            targetAction: "action_missing",
            reason: "caller rule",
          }),
        /references unknown action ID/,
      ],
      [
        "unknown evidence action",
        (input) => {
          input.evidence.action_missing = { strength: 0.5, confidence: 0.5, source: "caller" };
        },
        /Evidence references unknown action ID/,
      ],
      ["extra key", (input) => (input.scenario.extra = true), /Unrecognized key/],
      ["no goals", (input) => (input.scenario.goals = []), /at least one goal/],
      [
        "zero total goal weight",
        (input) => input.scenario.goals.forEach((goal: any) => (goal.weight = 0)),
        /finite and positive/,
      ],
      [
        "overflowing goal weights",
        (input) => input.scenario.goals.forEach((goal: any) => (goal.weight = 1e308)),
        /finite and positive/,
      ],
      ["no actions", (input) => (input.scenario.actions = []), /at least one action/],
    ];

    for (const [, mutate, expected] of cases) {
      const input = neutralInput() as any;
      mutate(input);
      expect(() => parseGoalChainerInput(input)).toThrow(expected);
    }
  });

  it("rejects malformed motivation option values", () => {
    for (const motivation of [null, true, 42, "off"] as const) {
      expect(() => runGoalChainer(neutralInput(), { motivation } as any)).toThrow(
        "motivation options must be a plain object record",
      );
    }
    expect(() => runGoalChainer(neutralInput(), { motivation: { risk: {} } } as any)).toThrow(
      "GoalChainer motivation options contains unknown fields: risk",
    );
  });

  it("snapshots nested motivation options at construction", () => {
    const motivation = {
      correlations: {
        [DEFAULT_IDS.preferredAction]: { [DEFAULT_IDS.personalGoal]: 1 },
      },
      risks: {
        [DEFAULT_IDS.preferredAction]: 0,
        [DEFAULT_IDS.alternateAction]: 0,
      },
    };
    const chainer = new GoalChainer({ motivation });
    const expected = new GoalChainer({
      motivation: {
        correlations: {
          [DEFAULT_IDS.preferredAction]: { [DEFAULT_IDS.personalGoal]: 1 },
        },
        risks: {
          [DEFAULT_IDS.preferredAction]: 0,
          [DEFAULT_IDS.alternateAction]: 0,
        },
      },
    }).evaluate(neutralInput());
    motivation.correlations[DEFAULT_IDS.preferredAction]![DEFAULT_IDS.personalGoal] = -1;
    motivation.risks[DEFAULT_IDS.preferredAction] = 1;

    const actual = chainer.evaluate(neutralInput());
    expect(actual.motivation!.consensus_scores).toEqual(expected.motivation!.consensus_scores);
  });

  it("keeps scores monotonic across 301 generated evidence strengths", () => {
    const parsed = parseGoalChainerInput(neutralInput());
    let previous = Number.NEGATIVE_INFINITY;

    for (let index = 0; index <= 300; index += 1) {
      const strength = index / 300;
      const reasoner = new StaticEvidenceReasoner({
        [DEFAULT_IDS.preferredAction]: { strength, confidence: 1, source: "generated" },
        [DEFAULT_IDS.alternateAction]: { strength: 0, confidence: 1, source: "generated" },
      });
      const score = evaluateScenario(parsed.scenario, reasoner, { motivation: false }).decisions.find(
        (decision) => decision.actionId === DEFAULT_IDS.preferredAction,
      )!.score;

      expect(score).toBeGreaterThanOrEqual(previous);
      expect(score).toBeCloseTo(0.54 + 0.38 * strength, 12);
      previous = score;
    }
  });

  it("is independent of 200 generated caller goal and action IDs", () => {
    for (let index = 0; index < 200; index += 1) {
      const ids: NeutralIds = {
        personalGoal: `goal ${index} / α`,
        sharedGoal: `goal ${index} / β`,
        preferredAction: `option ${index} (preferred)`,
        alternateAction: `option ${index} [alternate]`,
      };
      const run = runGoalChainer(neutralInput(ids), { motivation: false });
      expect(run.selected.actionId).toBe(ids.preferredAction);
      expect(run.selected.score).toBeCloseTo(0.882, 12);
      expect(run.decisions[1]!.missingRequiredGoals).toEqual([ids.sharedGoal]);
    }
  });

  it("treats Object.prototype names as ordinary IDs through the full pipeline", () => {
    const ids: NeutralIds = {
      personalGoal: "toString",
      sharedGoal: "constructor",
      preferredAction: "__proto__",
      alternateAction: "hasOwnProperty",
    };

    const run = runGoalChainer(neutralInput(ids));
    expect(run.selected.actionId).toBe("__proto__");
    expect(Object.hasOwn(run.motivation!.consensus_scores, "__proto__")).toBe(true);
    expect(run.selected.evidence).toMatchObject({ strength: 0.9, confidence: 1 });

    const offline = runGoalChainer(neutralInput(ids), { motivation: false });
    expect(offline.selected.actionId).toBe("__proto__");
  });

  it("does not recommend an action when no evidence or explicit prior is supplied", () => {
    const input = neutralInput() as any;
    input.scenario.actions = [input.scenario.actions[0]];
    delete input.evidence;

    const run = runGoalChainer(input);
    expect(run.selected.evidence).toMatchObject({ strength: 0.5, confidence: 0 });
    expect(run.selected.status).toBe("candidate");
    expect(run.selected.score).toBeCloseTo(0.54, 12);
  });

  it("rejects contextual query fields on the static JSON path", () => {
    const input = neutralInput() as any;
    input.scenario.actions[0].evidenceQuery = "(Acceptable action_preferred)";
    input.scenario.actions[0].evidenceAtoms = ["(Observed action_preferred)"];

    expect(() => runGoalChainer(input)).toThrow(
      /Use evaluateScenario with ContextualQueryEvidenceReasoner/,
    );
  });

  it("safe-parses 500 generated unknown values without throwing", () => {
    const values: unknown[] = [];
    for (let index = 0; index < 500; index += 1) {
      switch (index % 5) {
        case 0:
          values.push(index);
          break;
        case 1:
          values.push(`value-${index}`);
          break;
        case 2:
          values.push([index, { nested: true }]);
          break;
        case 3:
          values.push({ scenario: index, evidence: null });
          break;
        default:
          values.push({ scenario: { actions: [{ id: index }] } });
      }
    }

    for (const value of values) {
      const result = goalChainerInputSchema.safeParse(value);
      expect(result.success).toBe(false);
    }
  });
});
