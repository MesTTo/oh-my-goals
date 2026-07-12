import { format, gfloat } from "@metta-ts/core";
import { GroundedAtom } from "@metta-ts/hyperon";
import { describe, expect, it } from "vitest";

import { consensusDecision } from "../src/motivation.js";
import {
  createGoalChainerMetta,
  mettaCall,
  mettaFloat,
  mettaString,
  mettaSymbol,
  mettaTuple,
  sharedGoalChainerMetta,
  type Term,
} from "../src/metta.js";
import type { Goal, GoalScenario } from "../src/models.js";
import { gradeBeliefs, type PlnProgram } from "../src/pln.js";
import { StaticEvidenceReasoner } from "../src/reasoner.js";
import {
  DecisionEngine,
  goalCoverage,
  missingRequiredGoals,
} from "../src/score.js";

function generatedGoals(count: number): Goal[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `goal-${index}`,
    owner: `owner-${index % 3}`,
    statement: `Preserve goal ${index}`,
    weight: (index % 4) + 1,
    kind: index % 2 === 0 ? "individual" : "collective",
    required: index % 4 !== 3,
  }));
}

function mixedIdentities(count: number): Term[] {
  return Array.from({ length: count }, (_, index) => {
    switch (index % 4) {
      case 0:
        return `string-${index}`;
      case 1:
        return index + 100;
      case 2:
        return mettaSymbol(`symbol-${index}`);
      default:
        return mettaCall("compound-id", `part-${index}`, index);
    }
  });
}

function directConsensus(
  candidates: readonly Term[],
  individual: readonly Term[] = [mettaFloat(1)],
  collective: readonly Term[] = [mettaFloat(0)],
): unknown[] {
  return sharedGoalChainerMetta().evalJs(mettaCall(
    "gc-motivation-consensus",
    mettaTuple(individual),
    mettaTuple(collective),
    mettaTuple(candidates),
  ));
}

function expectedGoalAnalysis(goals: readonly Goal[], satisfied: readonly string[]) {
  const selected = new Set(satisfied);
  let total = 0;
  let covered = 0;
  let individualTotal = 0;
  let individualCovered = 0;
  let collectiveTotal = 0;
  let collectiveCovered = 0;
  const missing: string[] = [];

  for (const goal of goals) {
    const isSatisfied = selected.has(goal.id);
    total += goal.weight;
    if (isSatisfied) covered += goal.weight;
    if (goal.kind === "individual") {
      individualTotal += goal.weight;
      if (isSatisfied) individualCovered += goal.weight;
    } else {
      collectiveTotal += goal.weight;
      if (isSatisfied) collectiveCovered += goal.weight;
    }
    if (goal.required && !isSatisfied) missing.push(goal.id);
  }

  return {
    coverage: {
      all: total === 0 ? 0 : covered / total,
      individual: individualTotal === 0 ? 0 : individualCovered / individualTotal,
      collective: collectiveTotal === 0 ? 0 : collectiveCovered / collectiveTotal,
    },
    missing,
  };
}

function rankingScenario(
  count: number,
  strengthAt: (index: number) => number,
): GoalScenario {
  const goal = generatedGoals(1)[0]!;
  return {
    title: `${count}-action ranking`,
    goals: [{ ...goal, required: false }],
    norms: [],
    actions: Array.from({ length: count }, (_, index) => ({
      id: `action-${index}`,
      label: `Action ${index}`,
      description: `Ranked action ${index}`,
      satisfies: [goal.id],
      evidenceQuery: "",
      evidenceAtoms: [],
      defaultStrength: strengthAt(index),
      defaultConfidence: 1,
    })),
    notes: [],
  };
}

function motivationScenario(count: number, collective: boolean): GoalScenario {
  const goals: Goal[] = [
    {
      id: "individual-goal",
      owner: "person",
      statement: "Preserve the individual outcome",
      weight: 1,
      kind: "individual",
      required: false,
    },
  ];
  if (collective) {
    goals.push({
      id: "collective-goal",
      owner: "group",
      statement: "Preserve the collective outcome",
      weight: 1,
      kind: "collective",
      required: false,
    });
  }
  return {
    title: `${count}-candidate motivation`,
    goals,
    norms: [],
    actions: Array.from({ length: count }, (_, index) => ({
      id: `candidate-${index}`,
      label: `Candidate ${index}`,
      description: `Motivation candidate ${index}`,
      satisfies: [],
      evidenceQuery: "",
      evidenceAtoms: [],
      defaultStrength: 0.5,
      defaultConfidence: 0,
    })),
    notes: [],
  };
}

interface OracleDeduction {
  readonly ruleIndex: number;
  readonly factIndex: number;
  readonly ruleId: string;
  readonly factId: string;
  readonly strength: number;
  readonly confidence: number;
}

function generatedPlnProgram(count: number): PlnProgram {
  return {
    actionIds: ["scaled-action"],
    rules: Array.from({ length: count }, (_, index) => ({
      id: `rule-${index}`,
      predicate: `predicate-${index}`,
      strength: [0.25, 0.5, 0.75, 1][index % 4]!,
      confidence: [0.25, 0.5, 0.75][index % 3]!,
    })),
    facts: Array.from({ length: count }, (_, index) => ({
      id: `fact-${index}`,
      actionId: "scaled-action",
      predicate: `predicate-${index}`,
      strength: [1, 0.75, 0.5, 0.25][index % 4]!,
      confidence: [0.75, 0.5, 0.25][index % 3]!,
    })),
  };
}

function deductionOracle(program: PlnProgram): OracleDeduction[] {
  const rows: OracleDeduction[] = [];
  program.rules.forEach((rule, ruleIndex) => {
    program.facts.forEach((fact, factIndex) => {
      if (fact.actionId !== "scaled-action" || fact.predicate !== rule.predicate) return;
      rows.push({
        ruleIndex,
        factIndex,
        ruleId: rule.id,
        factId: fact.id,
        strength:
          rule.strength * fact.strength + 0.2 * (1 - fact.strength),
        confidence:
          fact.strength * Math.min(rule.confidence, fact.confidence) +
          (1 - fact.strength) * Math.min(0.2, fact.confidence),
      });
    });
  });
  return rows;
}

function confidenceWeight(confidence: number): number {
  return (confidence * 800) / (1 - Math.min(confidence, 0.9999));
}

function sequentialRevision(rows: readonly OracleDeduction[]) {
  let strength = rows[0]!.strength;
  let confidence = rows[0]!.confidence;
  for (const row of rows.slice(1)) {
    const leftWeight = confidenceWeight(confidence);
    const rightWeight = confidenceWeight(row.confidence);
    const totalWeight = leftWeight + rightWeight;
    strength = totalWeight === 0
      ? 0.5
      : (strength * leftWeight + row.strength * rightWeight) / totalWeight;
    confidence = totalWeight / (totalWeight + 800);
  }
  return { strength, confidence };
}

describe("large native goal analysis", () => {
  it.each([16, 17])(
    "matches Python's compensated binary64 accumulation at the %i-goal boundary",
    (count) => {
      const goals = Array.from({ length: count }, (_, index): Goal => ({
        id: `numeric-goal-${index}`,
        owner: "caller",
        statement: `Exercise numeric goal ${index}`,
        weight: index === 0 ? 1e16 : 1,
        kind: "individual",
        required: false,
      }));

      expect(goalCoverage(goals, [goals[0]!.id])).toEqual({
        all: 0.9999999999999984,
        individual: 0.9999999999999984,
        collective: 0,
      });
    },
  );

  it.each([17, 41, 100, 5_000])(
    "preserves weighted ratios and missing-goal order across %i goals",
    (count) => {
      const goals = generatedGoals(count);
      const selected = goals
        .filter((_, index) => index % 3 !== 1)
        .map((goal) => goal.id);
      const satisfied = [...selected, selected[0]!, "unknown-goal", selected[0]!];
      const expected = expectedGoalAnalysis(goals, satisfied);

      expect(goalCoverage(goals, satisfied)).toEqual(expected.coverage);
      expect(missingRequiredGoals(goals, satisfied)).toEqual(expected.missing);
    },
    30_000,
  );

  it("evaluates an action with thousands of satisfied and missing goals", () => {
    const goals = generatedGoals(5_000);
    const satisfies = goals
      .filter((_, index) => index % 3 !== 1)
      .map((goal) => goal.id);
    const action = {
      id: "large-action",
      label: "Large action",
      description: "Exercises the analyzed-action scoring path",
      satisfies,
      evidenceQuery: "",
      evidenceAtoms: [],
      defaultStrength: 1,
      defaultConfidence: 1,
    };
    const scenario: GoalScenario = {
      title: "Large goal analysis",
      goals,
      norms: [],
      actions: [action],
      notes: [],
    };
    const expected = expectedGoalAnalysis(goals, satisfies);
    const decision = new DecisionEngine(new StaticEvidenceReasoner()).evaluateAction(
      scenario,
      action,
    );
    const expectedScore =
      0.42 * expected.coverage.all +
      0.38 * (action.defaultStrength * action.defaultConfidence) +
      0.12 * Math.min(expected.coverage.individual, expected.coverage.collective);

    expect(decision.goalScore).toBe(expected.coverage.all);
    expect(decision.individualScore).toBe(expected.coverage.individual);
    expect(decision.collectiveScore).toBe(expected.coverage.collective);
    expect(decision.missingRequiredGoals).toEqual(expected.missing);
    expect(decision.satisfiedGoals).toEqual(satisfies);
    expect(decision.score).toBe(expectedScore);
    expect(decision.status).toBe("candidate");
  }, 30_000);
});

describe("native and grounded identity boundaries", () => {
  it.each([8, 9])(
    "preserves Float mask and correlation atoms across the %i-item boundary",
    (count) => {
      const db = sharedGoalChainerMetta();
      const goals = mettaTuple(Array.from({ length: count }, (_, index) =>
        mettaCall(
          "Goal",
          `float-goal-${index}`,
          mettaSymbol("individual"),
          mettaFloat(1),
          false,
        )
      ));
      const correlations = mettaTuple(Array.from({ length: count }, (_, index) =>
        mettaCall("DefaultCorrelation", index % 2 === 0)
      ));
      const mask = db.eval(mettaCall("gc-motivation-mask", mettaSymbol("individual"), goals));
      const values = db.eval(mettaCall("gc-motivation-correlations", correlations));
      const normalized = db.eval(mettaCall(
        "gc-normalize-values-fast",
        mettaTuple(Array.from({ length: count }, () => mettaFloat(0.5))),
      ));

      expect(mask).toHaveLength(1);
      expect(values).toHaveLength(1);
      expect(normalized).toHaveLength(1);
      expect(format(mask[0]!.catom)).toBe(`(${Array(count).fill("1.0").join(" ")})`);
      expect(format(values[0]!.catom)).toBe(
        `(${Array.from({ length: count }, (_, index) => index % 2 === 0 ? "1.0" : "0.0").join(" ")})`,
      );
      expect(format(normalized[0]!.catom)).toBe(`(${Array(count).fill("1.0").join(" ")})`);
    },
  );

  it.each([8, 9])(
    "preserves mixed ground Atom identities across %i rows",
    (count) => {
      const identities = mixedIdentities(count);
      const selected = identities.filter((_, index) => index % 2 === 0);
      const goals = identities.map((identity) =>
        mettaCall("Goal", identity, mettaSymbol("individual"), mettaFloat(1), false)
      );
      const rows = identities.map((identity, index) =>
        mettaCall(
          "DecisionRow",
          identity,
          index,
          mettaFloat(1 - index / 100),
          mettaSymbol("recommended"),
        )
      );
      const target = mettaCall("compound-action", "target");
      const predicate = mettaCall("compound-predicate", "supports");
      const rules = [mettaCall(
        "PlnRule",
        mettaCall("compound-rule", "one"),
        predicate,
        mettaFloat(1),
        mettaFloat(1),
      )];
      const facts = identities.map((identity, index) =>
        mettaCall(
          "PlnFact",
          mettaCall("compound-fact", index),
          index === count - 1 ? target : identity,
          predicate,
          mettaFloat(1),
          mettaFloat(1),
        )
      );
      const db = sharedGoalChainerMetta();
      const analysis = db.evalJs(mettaCall(
        "gc-goal-analysis",
        mettaTuple(goals),
        mettaTuple(selected),
      ));
      const ranking = db.evalJs(mettaCall(
        "gc-rank-decisions",
        mettaTuple(rows),
        mettaFloat(1e-9),
      ));
      const pln = db.evalJs(mettaCall(
        "gc-pln-evaluate",
        target,
        mettaTuple(rules),
        mettaTuple(facts),
      ));

      expect(analysis).toEqual([[
        "GoalAnalysis",
        selected.length / count,
        selected.length / count,
        0,
        [],
      ]]);
      expect(ranking).toHaveLength(1);
      expect((ranking[0] as unknown[])[0]).toBe("RankedDecisions");
      expect((ranking[0] as unknown[])[1]).toHaveLength(count);
      expect(pln).toHaveLength(1);
      expect((pln[0] as unknown[])[0]).toBe("PlnResult");
      expect((pln[0] as unknown[])[2]).toHaveLength(1);
    },
  );

  it.each([8, 9])(
    "preserves compound motivation identities across %i candidates",
    (count) => {
      const first = mettaCall("compound-candidate", "first", 0);
      const identities = [first, ...mixedIdentities(count - 1)];
      const candidates = identities.map((identity) => mettaCall(
        "Candidate",
        identity,
        mettaTuple([mettaFloat(0.5)]),
        mettaFloat(0.25),
      ));
      const values = directConsensus(candidates);

      expect(values).toHaveLength(1);
      const result = values[0] as unknown[];
      expect(result[0]).toBe("MotivationResult");
      expect(result[1]).toEqual(["Some", ["compound-candidate", "first", 0]]);
      expect(result[2]).toEqual(["None"]);
      expect(result[3]).toEqual(["Some", ["compound-candidate", "first", 0]]);
      expect(result[4]).toEqual(["None"]);
      const scores = result[5] as unknown[][];
      expect(scores).toHaveLength(count);
      expect(scores[0]).toEqual([
        "ConsensusScore",
        ["compound-candidate", "first", 0],
        0.25,
      ]);
      expect(scores.every((row) => row[2] === 0.25)).toBe(true);
      expect(result[6]).toEqual(["compound-candidate", "first", 0]);
    },
  );

  it.each([8, 9])(
    "canonicalizes reducible motivation identities across %i candidates",
    (count) => {
      const candidates = Array.from({ length: count }, (_, index) => mettaCall(
        "Candidate",
        index === 0
          ? mettaCall("id", mettaString("first"))
          : mettaCall("candidate-id", index),
        mettaTuple([mettaFloat(index === 0 ? 1 : 0)]),
        mettaFloat(0),
      ));
      const result = directConsensus(candidates)[0] as unknown[];

      expect(result[0]).toBe("MotivationResult");
      expect(result.slice(1, 5)).toEqual([
        ["Some", "first"],
        ["None"],
        ["Some", "first"],
        ["None"],
      ]);
      expect((result[5] as unknown[][])[0]).toEqual(["ConsensusScore", "first", 1]);
      expect(result[6]).toBe("first");
    },
  );

  it.each([8, 9])(
    "canonicalizes reducible motivation identities across a %i-value vector",
    (count) => {
      const individual = Array.from({ length: count }, (_, index) =>
        mettaFloat(index === 0 ? 1 : 0)
      );
      const collective = Array.from({ length: count }, () => mettaFloat(0));
      const candidate = mettaCall(
        "Candidate",
        mettaCall("id", mettaString("first")),
        mettaTuple(Array.from({ length: count }, (_, index) =>
          mettaFloat(index === 0 ? 1 : 0)
        )),
        mettaFloat(0),
      );
      const result = directConsensus([candidate], individual, collective)[0] as unknown[];

      expect(result[0]).toBe("MotivationResult");
      expect((result[5] as unknown[][])[0]).toEqual(["ConsensusScore", "first", 1]);
      expect(result[6]).toBe("first");
    },
  );

  it.each([8, 9])(
    "rejects duplicate motivation identity normal forms across %i candidates",
    (count) => {
      const candidates = Array.from({ length: count }, (_, index) => mettaCall(
        "Candidate",
        index === 0
          ? mettaString("duplicate")
          : index === 1
            ? mettaCall("id", mettaString("duplicate"))
            : mettaCall("candidate-id", index),
        mettaTuple([mettaFloat(0)]),
        mettaFloat(0),
      ));

      expect(directConsensus(candidates)).toEqual([["InvalidMotivationConsensus"]]);
    },
  );

  it.each([8, 9])(
    "rejects malformed candidate atoms across %i candidates",
    (count) => {
      const malformed: readonly Term[] = [
        mettaCall("Wrong", "candidate", mettaTuple([mettaFloat(0)]), mettaFloat(0)),
        mettaCall("Candidate"),
        mettaCall("Candidate", "candidate", mettaSymbol("not-a-vector"), mettaFloat(0)),
        mettaCall(
          "Candidate",
          "candidate",
          mettaTuple([mettaSymbol("not-a-number")]),
          mettaFloat(0),
        ),
        mettaCall(
          "Candidate",
          "candidate",
          mettaTuple([mettaFloat(0)]),
          mettaSymbol("not-a-number"),
        ),
        mettaCall(
          "Candidate",
          "candidate",
          mettaTuple([mettaString("not-a-number")]),
          mettaFloat(0),
        ),
        mettaCall(
          "Candidate",
          "candidate",
          mettaTuple([true]),
          mettaFloat(0),
        ),
      ];
      const results = malformed.map((invalid) => directConsensus([
        invalid,
        ...Array.from({ length: count - 1 }, (_, index) => mettaCall(
          "Candidate",
          mettaCall("candidate-id", index),
          mettaTuple([mettaFloat(0)]),
          mettaFloat(0),
        )),
      ]));

      expect(results).toEqual(
        malformed.map(() => [["InvalidMotivationConsensus"]]),
      );
    },
  );

  it.each([8, 9])(
    "maps nondeterministic motivation normal forms to invalid atoms across %i candidates",
    (count) => {
      const db = createGoalChainerMetta().add(
        mettaCall("=", mettaCall("choice-number"), mettaFloat(0)),
        mettaCall("=", mettaCall("choice-number"), mettaFloat(1)),
        mettaCall("=", mettaCall("choice-id"), mettaString("left")),
        mettaCall("=", mettaCall("choice-id"), mettaString("right")),
      );
      const candidates = (firstId: Term, firstCorrelation: Term) =>
        Array.from({ length: count }, (_, index) => mettaCall(
          "Candidate",
          index === 0 ? firstId : mettaCall("candidate-id", index),
          mettaTuple([index === 0 ? firstCorrelation : mettaFloat(0)]),
          mettaFloat(0),
        ));
      const queries = [
        candidates(mettaString("candidate"), mettaCall("choice-number")),
        candidates(mettaCall("choice-id"), mettaFloat(1)),
      ].map((values) => mettaCall(
        "gc-motivation-consensus",
        mettaTuple([mettaFloat(1)]),
        mettaTuple([mettaFloat(0)]),
        mettaTuple(values),
      ));

      expect(db.evalJsMany(queries)).toEqual([
        [["InvalidMotivationConsensus"]],
        [["InvalidMotivationConsensus"]],
      ]);
    },
  );

  it.each([8, 9])(
    "rejects out-of-domain motivation vectors across %i candidates",
    (count) => {
      const candidates = Array.from({ length: count }, (_, index) => mettaCall(
        "Candidate",
        mettaCall("candidate-id", index),
        mettaTuple([mettaFloat(index === 0 ? 1 : 0)]),
        mettaFloat(0),
      ));
      const result = directConsensus(
        candidates,
        [mettaFloat(Number.MAX_VALUE)],
        [mettaFloat(Number.MAX_VALUE)],
      );

      expect(result).toEqual([["InvalidMotivationConsensus"]]);
    },
  );

  it.each([8, 9])(
    "rejects raw non-finite motivation atoms across %i candidates",
    (count) => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const nonFinite = new GroundedAtom(gfloat(value));
        const candidates = Array.from({ length: count }, (_, index) => mettaCall(
          "Candidate",
          mettaCall("candidate-id", index),
          mettaTuple([index === 0 ? nonFinite : mettaFloat(0)]),
          mettaFloat(0),
        ));

        expect(directConsensus(candidates)).toEqual([["InvalidMotivationConsensus"]]);
      }
    },
  );

  it("rejects duplicate compound candidate identities in direct consensus", () => {
    const duplicate = mettaCall("compound-candidate", "duplicate");
    const candidates = Array.from({ length: 9 }, (_, index) => mettaCall(
      "Candidate",
      index < 2 ? duplicate : mettaCall("candidate", index),
      mettaTuple([mettaFloat(0)]),
      mettaFloat(0),
    ));
    const values = directConsensus(candidates);

    expect(values).toHaveLength(1);
    expect(values[0]).toEqual(["InvalidMotivationConsensus"]);
  });

  it.each([8, 9])(
    "rejects invalid direct consensus inputs across the %i-value boundary",
    (count) => {
      const individual = mettaTuple(Array.from({ length: count }, () => mettaFloat(1)));
      const collective = mettaTuple(Array.from({ length: count }, () => mettaFloat(0)));
      const candidate = (
        correlations: readonly Term[],
        risk: number,
      ) => mettaCall(
        "Candidate",
        "invalid-direct-candidate",
        mettaTuple(correlations),
        mettaFloat(risk),
      );
      const validCorrelations = Array.from({ length: count }, () => mettaFloat(0.5));
      const queries = [
        mettaCall(
          "gc-motivation-consensus",
          individual,
          collective,
          mettaTuple([candidate([
            mettaFloat(1.1),
            ...validCorrelations.slice(1),
          ], 0)]),
        ),
        mettaCall(
          "gc-motivation-consensus",
          individual,
          collective,
          mettaTuple([candidate(validCorrelations, 1.1)]),
        ),
        mettaCall(
          "gc-motivation-consensus",
          individual,
          collective,
          mettaTuple([candidate(validCorrelations.slice(1), 0)]),
        ),
        mettaCall(
          "gc-motivation-consensus",
          individual,
          mettaTuple(Array.from({ length: count - 1 }, () => mettaFloat(0))),
          mettaTuple([candidate(validCorrelations, 0)]),
        ),
      ];

      expect(sharedGoalChainerMetta().evalJsMany(queries)).toEqual(
        Array.from({ length: queries.length }, () => [["InvalidMotivationConsensus"]]),
      );
    },
  );

  it.each([8, 9])(
    "preserves blank ground Atom identities across %i candidates",
    (count) => {
      const identities: ReadonlyArray<readonly [Term, string]> = [
        [mettaSymbol(""), ""],
        [mettaSymbol(" "), " "],
        [mettaString(""), ""],
        [mettaString(" "), " "],
      ];
      for (const [identity, expected] of identities) {
        const candidates = Array.from({ length: count }, (_, index) => mettaCall(
          "Candidate",
          index === 0 ? identity : mettaCall("candidate", index),
          mettaTuple([mettaFloat(0)]),
          mettaFloat(0),
        ));
        const values = directConsensus(candidates);
        expect(values).toHaveLength(1);
        const result = values[0] as unknown[];
        expect(result[0]).toBe("MotivationResult");
        expect(result[5]).toHaveLength(count);
        expect(result[6]).toBe(expected);
      }
    },
  );

  it.each([8, 9])(
    "rejects out-of-range correlations across the %i-value boundary",
    (count) => {
      const specs = Array.from({ length: count }, (_, index) => mettaCall(
        "ExplicitCorrelation",
        mettaFloat(index === 0 ? 1.1 : 0),
      ));
      const values = sharedGoalChainerMetta().evalJs(mettaCall(
        "gc-motivation-candidate",
        mettaCall(
          "MotivationAction",
          "candidate",
          mettaTuple(specs),
          mettaCall("ExplicitRisk", mettaFloat(0)),
        ),
      ));

      expect(values).toHaveLength(1);
      expect((values[0] as unknown[])[0]).not.toBe("Candidate");
    },
  );
});

describe("large native decision ranking", () => {
  it("sorts 50 decisions stably and retains every equal top decision", () => {
    const scenario = rankingScenario(50, (index) => (index % 5) / 4);
    const receipt = new DecisionEngine(new StaticEvidenceReasoner()).rankWithReceipt(scenario);
    const expectedOrder = scenario.actions
      .map((action, index) => ({ id: action.id, index, bucket: index % 5 }))
      .sort((left, right) => right.bucket - left.bucket || left.index - right.index)
      .map(({ id }) => id);
    const expectedTies = scenario.actions
      .filter((_, index) => index % 5 === 4)
      .map((action) => action.id);

    expect(receipt.decisions.map((decision) => decision.actionId)).toEqual(expectedOrder);
    expect(receipt.tiedActionIds).toEqual(expectedTies);
    expect(receipt.automaticExecutionAllowed).toBe(false);
  }, 30_000);

  it("keeps declaration order for 1,000 exactly tied decisions", () => {
    const scenario = rankingScenario(1_000, () => 0.9);
    const receipt = new DecisionEngine(new StaticEvidenceReasoner()).rankWithReceipt(scenario);
    const declarationOrder = scenario.actions.map((action) => action.id);

    expect(receipt.decisions.map((decision) => decision.actionId)).toEqual(declarationOrder);
    expect(receipt.tiedActionIds).toEqual(declarationOrder);
    expect(receipt.decisions.every((decision) => decision.score === 0.762)).toBe(true);
    expect(receipt.automaticExecutionAllowed).toBe(false);
  }, 30_000);
});

describe("large native motivation consensus", () => {
  it.each([8, 9, 5_000])(
    "keeps the direct consensus relation usable across a %i-value goal vector",
    (count) => {
      const individual = Array.from({ length: count }, (_, index) =>
        mettaFloat(index % 2 === 0 ? 1 : 0)
      );
      const collective = Array.from({ length: count }, (_, index) =>
        mettaFloat(index % 2 === 0 ? 0 : 1)
      );
      const candidate = mettaCall(
        "Candidate",
        "direct-candidate",
        mettaTuple(Array.from({ length: count }, () => mettaFloat(1))),
        mettaFloat(0.1),
      );
      const result = sharedGoalChainerMetta().evalJs(mettaCall(
        "gc-motivation-consensus",
        mettaTuple(individual),
        mettaTuple(collective),
        mettaTuple([candidate]),
      ));

      expect(result).toHaveLength(1);
      const value = result[0];
      expect(value).toEqual(expect.arrayContaining([
        "MotivationResult",
        ["Some", "direct-candidate"],
      ]));
      expect(Array.isArray(value) && value[6]).toBe("direct-candidate");
      const scores = Array.isArray(value) ? value[5] : undefined;
      expect(scores).toHaveLength(1);
      const score = Array.isArray(scores) ? scores[0] : undefined;
      expect(score?.[0]).toBe("ConsensusScore");
      expect(score?.[1]).toBe("direct-candidate");
      const individualScore = Math.ceil(count / 2) - 0.1;
      const collectiveScore = Math.floor(count / 2) - 0.1;
      expect(score?.[2]).toBeCloseTo(
        (individualScore + collectiveScore) / 2 -
          0.25 * Math.abs(individualScore - collectiveScore),
        12,
      );
    },
    30_000,
  );

  it.each([8, 9, 32, 33])(
    "matches Python's compensated dot-product order across %i goals",
    (count) => {
      const goals = Array.from({ length: count }, (_, index): Goal => ({
        id: `dot-goal-${index}`,
        owner: "caller",
        statement: `Exercise dot-product goal ${index}`,
        weight: 1,
        kind: "individual",
        required: false,
      }));
      const scenario: GoalScenario = {
        title: `${count}-goal dot product`,
        goals,
        norms: [],
        actions: ["candidate-a", "candidate-b"].map((id) => ({
          id,
          label: id,
          description: id,
          satisfies: [],
          evidenceQuery: "",
          evidenceAtoms: [],
          defaultStrength: 1,
          defaultConfidence: 1,
        })),
        notes: [],
      };
      const first = Object.fromEntries(goals.map((goal, index) => [
        goal.id,
        index === 0 ? 1 : index === goals.length - 1 ? -1 : 1e-16,
      ]));
      const second = Object.fromEntries(goals.map((goal, index) => [
        goal.id,
        index === 0 ? 3.105e-15 : 0,
      ]));
      const result = consensusDecision(scenario, {}, {
        correlations: { "candidate-a": first, "candidate-b": second },
        risks: { "candidate-a": 0, "candidate-b": 0 },
      });

      const compensated = new Map([
        [8, 6.000000000000001e-16],
        [9, 7.000000000000001e-16],
        [32, 3.000000000000001e-15],
        [33, 3.100000000000001e-15],
      ]);
      expect(result.consensus_scores).toEqual({
        "candidate-a": compensated.get(count),
        "candidate-b": 3.105e-15,
      });
      expect(result.consensus).toBe("candidate-b");
    },
  );

  it("aggregates exact formulas and breaks a 24-candidate top tie by declaration order", () => {
    const scenario = motivationScenario(24, true);
    const correlations: Record<string, Record<string, number>> = Object.create(null);
    const risks: Record<string, number> = Object.create(null);
    const expectedScores: Record<string, number> = Object.create(null);
    scenario.actions.forEach((action, index) => {
      const top = index >= 22;
      correlations[action.id] = {
        "individual-goal": top ? 1 : 0.25,
        "collective-goal": top ? 0.5 : 0.25,
      };
      risks[action.id] = 0.125;
      const individual = correlations[action.id]!["individual-goal"]! - risks[action.id]!;
      const collective = correlations[action.id]!["collective-goal"]! - risks[action.id]!;
      expectedScores[action.id] =
        (individual + collective) / 2 - 0.25 * Math.abs(individual - collective);
    });

    const result = consensusDecision(scenario, {}, { correlations, risks });

    expect(result.consensus_scores).toEqual(expectedScores);
    expect(result.goal_pull).toEqual({
      individual: "candidate-22",
      collective: "candidate-22",
    });
    expect(result.subsystem_preference).toEqual({
      individual: "candidate-22",
      collective: "candidate-22",
    });
    expect(result.consensus_scores["candidate-22"]).toBe(0.5);
    expect(result.consensus_scores["candidate-23"]).toBe(0.5);
    expect(result.consensus).toBe("candidate-22");
  }, 30_000);

  it("handles 1,000 tied candidates when the collective subsystem is absent", () => {
    const scenario = motivationScenario(1_000, false);
    const correlations = Object.fromEntries(scenario.actions.map((action) => [
      action.id,
      { "individual-goal": 0.5 },
    ]));
    const risks = Object.fromEntries(scenario.actions.map((action) => [action.id, 0.25]));
    const result = consensusDecision(scenario, {}, { correlations, risks });

    expect(result.goal_pull).toEqual({ individual: "candidate-0", collective: null });
    expect(result.subsystem_preference).toEqual({
      individual: "candidate-0",
      collective: null,
    });
    expect(result.consensus).toBe("candidate-0");
    expect(Object.keys(result.consensus_scores)).toEqual(
      scenario.actions.map((action) => action.id),
    );
    expect(Object.values(result.consensus_scores).every((score) => score === 0.25)).toBe(true);
  }, 30_000);

  it.each([9, 17, 33, 65, 129, 257])(
    "matches a sequential strict-maximum oracle across %i generated candidates",
    (count) => {
      const scenario = motivationScenario(count, true);
      const correlations: Record<string, Record<string, number>> = Object.create(null);
      const risks: Record<string, number> = Object.create(null);
      const rows = scenario.actions.map((action, index) => {
        const individual = ((index * 37) % 41) / 20 - 1;
        const collective = ((index * 53 + 7) % 43) / 21 - 1;
        const risk = ((index * 29 + 3) % 31) / 30;
        const individualPreference = individual - risk;
        const collectivePreference = collective - risk;
        const consensus =
          (individualPreference + collectivePreference) / 2 -
          0.25 * Math.abs(individualPreference - collectivePreference);
        correlations[action.id] = {
          "individual-goal": individual,
          "collective-goal": collective,
        };
        risks[action.id] = risk;
        return {
          id: action.id,
          individual,
          collective,
          individualPreference,
          collectivePreference,
          consensus,
        };
      });
      const best = (field: keyof (typeof rows)[number]): string => {
        let winner = rows[0]!;
        for (const row of rows.slice(1)) {
          if ((row[field] as number) > (winner[field] as number)) winner = row;
        }
        return winner.id;
      };

      const result = consensusDecision(scenario, {}, { correlations, risks });

      expect(result.goal_pull).toEqual({
        individual: best("individual"),
        collective: best("collective"),
      });
      expect(result.subsystem_preference).toEqual({
        individual: best("individualPreference"),
        collective: best("collectivePreference"),
      });
      expect(result.consensus).toBe(best("consensus"));
      expect(result.consensus_scores).toEqual(Object.fromEntries(
        rows.map((row) => [row.id, row.consensus]),
      ));
    },
    30_000,
  );
});

describe("large native PLN evaluation", () => {
  it.each([32, 100])(
    "matches a sequential revision oracle for %i deductions",
    (count) => {
      const program = generatedPlnProgram(count);
      const rows = deductionOracle(program);
      const expected = sequentialRevision(rows);
      const result = gradeBeliefs(program);

      expect(JSON.parse(result.rawOutputs[0]!)).toEqual(rows.map((row) => [
        row.ruleIndex,
        row.factIndex,
        row.ruleId,
        row.factId,
        row.strength,
        row.confidence,
      ]));
      expect(result.beliefs["scaled-action"]).toMatchObject(expected);
    },
    30_000,
  );

  it("finds the sole match in a sparse 10,000-rule program", () => {
    const count = 10_000;
    const rules = Array.from({ length: count }, (_, index) => ({
      id: `sparse-rule-${index}`,
      predicate: `sparse-predicate-${index}`,
      strength: 0.8,
      confidence: 0.9,
    }));
    const program: PlnProgram = {
      actionIds: ["scaled-action"],
      rules,
      facts: [{
        id: "sparse-fact",
        actionId: "scaled-action",
        predicate: `sparse-predicate-${count - 1}`,
        strength: 0.5,
        confidence: 0.7,
      }],
    };
    const result = gradeBeliefs(program);

    expect(result.beliefs["scaled-action"]).toMatchObject({
      strength: 0.5,
      confidence: 0.44999999999999996,
    });
    expect(JSON.parse(result.rawOutputs[0]!)).toEqual([
      [count - 1, 0, `sparse-rule-${count - 1}`, "sparse-fact", 0.5, 0.44999999999999996],
    ]);
  }, 30_000);

  it("preserves the public no-belief error for an empty fact set", () => {
    const program = generatedPlnProgram(100);
    expect(() => gradeBeliefs({ ...program, facts: [] })).toThrow(
      "PLN returned no belief for action: scaled-action",
    );
  }, 30_000);
});
