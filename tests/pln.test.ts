import { describe, expect, it } from "vitest";

import { createCandidateAction } from "../src/models.js";
import { gradeBeliefs, type PlnProgram } from "../src/pln.js";
import { PlnEvidenceReasoner } from "../src/reasoner.js";

const oneDeduction = (): PlnProgram => ({
  actionIds: ["action_one"],
  rules: [
    {
      id: "rule_one",
      predicate: "supports_goal",
      strength: 0.8,
      confidence: 0.9,
    },
  ],
  facts: [
    {
      id: "fact_one",
      actionId: "action_one",
      predicate: "supports_goal",
      strength: 0.5,
      confidence: 0.7,
    },
  ],
});

describe("generic PLN reasoning", () => {
  it("deduces strength and confidence from one matching rule and fact", () => {
    const result = gradeBeliefs(oneDeduction());

    expect(result.beliefs.action_one!.strength).toBeCloseTo(0.5, 12);
    expect(result.beliefs.action_one!.confidence).toBeCloseTo(0.45, 12);
    expect(result.beliefs.action_one!.proof).toBe(
      '(: (rule-proof "rule_one" "fact_one") (Acceptable "action_one") (STV 0.5 0.44999999999999996))',
    );
    expect(result.deductionProgram).toContain('(pln-rule 0 "supports_goal" "rule_one" 0.8 0.9)');
    expect(result.deductionProgram).toContain(
      '(pln-fact 0 "action_one" "fact_one" "supports_goal" 0.5 0.7)',
    );
    expect(result.deductionProgram).toContain("(= (pln-deduction $action)");
    expect(result.deductionProgram).toContain('!(pln-deduction "action_one")');
    expect(JSON.parse(result.rawOutputs[0]!)).toEqual([
      [0, 0, "rule_one", "fact_one", 0.5, 0.44999999999999996],
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.beliefs)).toBe(true);
    expect(Object.isFrozen(result.beliefs.action_one)).toBe(true);
    expect(Object.isFrozen(result.rawOutputs)).toBe(true);
  });

  it("revises multiple deductions in declared rule and fact order", () => {
    const result = gradeBeliefs({
      actionIds: ["action_merge"],
      rules: [
        {
          id: "rule_first",
          predicate: "quality_first",
          strength: 0.95,
          confidence: 0.97,
        },
        {
          id: "rule_second",
          predicate: "quality_second",
          strength: 0.92,
          confidence: 0.95,
        },
      ],
      facts: [
        {
          id: "fact_first",
          actionId: "action_merge",
          predicate: "quality_first",
          strength: 1,
          confidence: 0.97,
        },
        {
          id: "fact_second",
          actionId: "action_merge",
          predicate: "quality_second",
          strength: 0.95,
          confidence: 0.95,
        },
      ],
    });

    expect(result.beliefs.action_merge!.strength).toBe(0.9339042316258351);
    expect(result.beliefs.action_merge!.confidence).toBe(0.9771490750816104);
    expect(result.beliefs.action_merge!.proof).toContain(
      '(merge/revision (rule-proof "rule_first" "fact_first") (rule-proof "rule_second" "fact_second"))',
    );
  });

  it("uses a neutral strength when revising two zero-confidence deductions", () => {
    const result = gradeBeliefs({
      actionIds: ["action_unknown"],
      rules: [
        { id: "rule_a", predicate: "signal_a", strength: 0.9, confidence: 0 },
        { id: "rule_b", predicate: "signal_b", strength: 0.1, confidence: 0 },
      ],
      facts: [
        {
          id: "fact_a",
          actionId: "action_unknown",
          predicate: "signal_a",
          strength: 1,
          confidence: 0,
        },
        {
          id: "fact_b",
          actionId: "action_unknown",
          predicate: "signal_b",
          strength: 1,
          confidence: 0,
        },
      ],
    });

    expect(result.beliefs.action_unknown).toMatchObject({ strength: 0.5, confidence: 0 });
  });

  it("preserves requested action order explicitly and in proof outputs", () => {
    const result = gradeBeliefs({
      actionIds: ["action_zeta", "action_alpha"],
      rules: [
        { id: "rule_zeta", predicate: "property_zeta", strength: 0.7, confidence: 0.8 },
        { id: "rule_alpha", predicate: "property_alpha", strength: 0.6, confidence: 0.9 },
      ],
      facts: [
        {
          id: "fact_alpha",
          actionId: "action_alpha",
          predicate: "property_alpha",
          strength: 0.8,
          confidence: 0.7,
        },
        {
          id: "fact_zeta",
          actionId: "action_zeta",
          predicate: "property_zeta",
          strength: 0.9,
          confidence: 0.8,
        },
      ],
    });

    expect(result.actionIds).toEqual(["action_zeta", "action_alpha"]);
    expect(result.proofOutputs[0]).toContain('(Acceptable "action_zeta")');
    expect(result.proofOutputs[1]).toContain('(Acceptable "action_alpha")');
  });

  it("labels positional outputs when integer-like record keys reorder", () => {
    const result = gradeBeliefs({
      actionIds: ["10", "2"],
      rules: [
        { id: "rule_ten", predicate: "ten", strength: 0.9, confidence: 0.8 },
        { id: "rule_two", predicate: "two", strength: 0.4, confidence: 0.7 },
      ],
      facts: [
        { id: "fact_two", actionId: "2", predicate: "two", strength: 1, confidence: 0.7 },
        { id: "fact_ten", actionId: "10", predicate: "ten", strength: 1, confidence: 0.8 },
      ],
    });

    expect(Object.keys(result.beliefs)).toEqual(["2", "10"]);
    expect(result.actionIds).toEqual(["10", "2"]);
    expect(result.proofOutputs[0]).toContain('(Acceptable "10")');
    expect(result.proofOutputs[1]).toContain('(Acceptable "2")');
  });

  it("stores prototype-named action IDs as ordinary beliefs", () => {
    const base = oneDeduction();
    const program: PlnProgram = {
      ...base,
      actionIds: ["__proto__"],
      facts: [{ ...base.facts[0]!, actionId: "__proto__" }],
    };

    const result = gradeBeliefs(program);
    expect(Object.hasOwn(result.beliefs, "__proto__")).toBe(true);
    const reasoner = PlnEvidenceReasoner.from(result);
    const action = createCandidateAction({
      id: "__proto__",
      label: "Prototype-named option",
      description: "Exercises an arbitrary caller ID",
      satisfies: [],
    });
    expect(reasoner.project(action).strength).toBeCloseTo(0.5, 12);
  });

  it("snapshots PLN beliefs and emits round-trip-safe projection values", () => {
    const beliefs = {
      action: { strength: 1 / 3, confidence: 2 / 3, proof: "caller proof" },
    };
    const reasoner = new PlnEvidenceReasoner(beliefs);
    beliefs.action.strength = 1;
    const action = createCandidateAction({
      id: "action",
      label: "Action",
      description: "Use the snapshotted belief",
      satisfies: [],
    });

    expect(reasoner.project(action)).toMatchObject({
      strength: 1 / 3,
      confidence: 2 / 3,
      projection: `(Acceptable "action") (STV ${String(1 / 3)} ${String(2 / 3)})`,
    });
    expect(() => new PlnEvidenceReasoner(42 as any)).toThrow(
      "PLN beliefs must be a plain object record",
    );
  });

  it("reports missing deductions and missing projected beliefs", () => {
    expect(() =>
      gradeBeliefs({
        ...oneDeduction(),
        actionIds: ["action_one", "action_without_fact"],
      }),
    ).toThrow("PLN returned no belief for action: action_without_fact");

    const reasoner = PlnEvidenceReasoner.from(gradeBeliefs(oneDeduction()));
    const missingAction = createCandidateAction({
      id: "action_without_fact",
      label: "Unmatched option",
      description: "No PLN belief was supplied",
      satisfies: [],
    });
    expect(() => reasoner.project(missingAction)).toThrow(
      "PLN returned no evidence for action: action_without_fact",
    );
  });

  it("rejects malformed IDs and dangling fact references", () => {
    const invalidPrograms: Array<[PlnProgram, RegExp]> = [
      [{ ...oneDeduction(), actionIds: [] }, /actionIds must not be empty/],
      [{ ...oneDeduction(), actionIds: ["action_one", "action_one"] }, /duplicate ID/],
      [{ ...oneDeduction(), actionIds: [""] }, /must not contain empty IDs/],
      [
        {
          ...oneDeduction(),
          rules: [...oneDeduction().rules, { ...oneDeduction().rules[0]! }],
        },
        /rules contains duplicate ID/,
      ],
      [
        {
          ...oneDeduction(),
          facts: [...oneDeduction().facts, { ...oneDeduction().facts[0]! }],
        },
        /facts contains duplicate ID/,
      ],
      [
        {
          ...oneDeduction(),
          facts: [{ ...oneDeduction().facts[0]!, actionId: "action_unknown" }],
        },
        /references unknown action/,
      ],
      [
        {
          ...oneDeduction(),
          facts: [{ ...oneDeduction().facts[0]!, predicate: "property_unknown" }],
        },
        /has no matching rule/,
      ],
    ];

    for (const [program, expected] of invalidPrograms) {
      expect(() => gradeBeliefs(program)).toThrow(expected);
    }
  });

  it("rejects unknown or accessor-backed PLN program fields", () => {
    expect(() => gradeBeliefs({ ...oneDeduction(), actionId: ["action_one"] } as any)).toThrow(
      "PLN program contains unknown fields: actionId",
    );
    expect(() =>
      gradeBeliefs({
        ...oneDeduction(),
        rules: [{ ...oneDeduction().rules[0]!, strenght: 1 }],
      } as any),
    ).toThrow("rules[0] contains unknown fields: strenght");

    const program = oneDeduction() as any;
    Object.defineProperty(program, "actionIds", {
      enumerable: true,
      get: () => ["action_one"],
    });
    expect(() => gradeBeliefs(program)).toThrow("must be an enumerable data property");
  });

  it("rejects non-string identifiers and predicates before MeTTa evaluation", () => {
    const base = oneDeduction();
    const cases: Array<[PlnProgram, RegExp]> = [
      [{ ...base, actionIds: [1] as any }, /actionIds must contain string IDs/],
      [{ ...base, rules: [{ ...base.rules[0]!, id: 1 as any }] }, /rules must contain string IDs/],
      [
        { ...base, rules: [{ ...base.rules[0]!, predicate: 1 as any }] },
        /rules\[0\]\.predicate must be a nonblank string/,
      ],
      [{ ...base, facts: [{ ...base.facts[0]!, id: 1 as any }] }, /facts must contain string IDs/],
      [
        { ...base, facts: [{ ...base.facts[0]!, actionId: 1 as any }] },
        /facts\[0\]\.actionId must be a nonblank string/,
      ],
      [
        { ...base, facts: [{ ...base.facts[0]!, predicate: 1 as any }] },
        /facts\[0\]\.predicate must be a nonblank string/,
      ],
    ];

    for (const [program, expected] of cases) {
      expect(() => gradeBeliefs(program)).toThrow(expected);
    }
  });

  it("rejects non-finite and out-of-range truth values", () => {
    const cases: Array<["rules" | "facts", "strength" | "confidence", number]> = [
      ["rules", "strength", -0.01],
      ["rules", "confidence", 1.01],
      ["rules", "strength", Number.NaN],
      ["facts", "strength", Number.POSITIVE_INFINITY],
      ["facts", "confidence", -1],
    ];

    for (const [collection, field, value] of cases) {
      const program = oneDeduction();
      const row = program[collection][0]!;
      const invalid = {
        ...program,
        [collection]: [{ ...row, [field]: value }],
      } as PlnProgram;
      expect(() => gradeBeliefs(invalid)).toThrow(/must be finite and within \[0, 1\]/);
    }
  });
});
