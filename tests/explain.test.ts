import { describe, expect, it } from "vitest";

import { explainDecisions } from "../src/explain.js";
import {
  createDecision,
  createEvidenceProjection,
  type Decision,
} from "../src/models.js";

function decision(overrides: Partial<Decision>): Decision {
  const normStatus = overrides.normStatus ?? "unregulated";
  const status =
    overrides.status ??
    (normStatus === "forbidden" || normStatus === "conflict" ? "blocked" : "candidate");
  return createDecision({
    actionId: overrides.actionId ?? "action",
    label: overrides.label ?? "Action",
    status,
    score: overrides.score ?? 0.5,
    goalScore: overrides.goalScore ?? 0.5,
    individualScore: overrides.individualScore ?? 0.5,
    collectiveScore: overrides.collectiveScore ?? 0.5,
    evidence:
      overrides.evidence ??
      createEvidenceProjection({
        strength: 0.8,
        confidence: 0.75,
        expectation: 0.725,
        source: "caller evidence",
        deontic: normStatus,
      }),
    normStatus,
    normReasons: overrides.normReasons,
    satisfiedGoals: overrides.satisfiedGoals,
    missingRequiredGoals: overrides.missingRequiredGoals,
    warnings: overrides.warnings,
    metadata: overrides.metadata,
  });
}

describe("plain-language decision explanations", () => {
  it("distinguishes selected, blocked, and unselected actions with their evidence", () => {
    const lines = explainDecisions([
      decision({
        actionId: "required-action",
        label: "Required action",
        status: "recommended",
        score: 0.81234,
        normStatus: "obligated",
        normReasons: ["oblige:verified policy"],
        satisfiedGoals: ["goal-a"],
      }),
      decision({
        actionId: "permitted-action",
        label: "Permitted action",
        status: "candidate",
        score: 0.61,
        normStatus: "permitted",
        normReasons: ["permit:verified policy"],
      }),
      decision({
        actionId: "open-action",
        label: "Open action",
        status: "weak",
        score: 0.2,
        normStatus: "unregulated",
      }),
      decision({
        actionId: "forbidden-action",
        label: "Forbidden action",
        status: "blocked",
        score: -1,
        normStatus: "forbidden",
        normReasons: ["forbid:verified policy"],
        missingRequiredGoals: ["goal-b"],
      }),
      decision({
        actionId: "conflicted-action",
        label: "Conflicted action",
        status: "blocked",
        score: -1,
        normStatus: "conflict",
        normReasons: ["forbid:rule one", "permit:rule two"],
      }),
    ]);

    expect(lines).toContain("Selected: Required action (score 0.812).");
    expect(lines).toContain(
      "  The deontic result requires this action. oblige:verified policy.",
    );
    expect(lines).toContain(
      "  Evidence strength=0.800, confidence=0.750, expectation=0.725.",
    );
    expect(lines).toContain("  Satisfies: goal-a.");
    expect(lines).toContain("Blocked: Forbidden action (score -1.000).");
    expect(lines).toContain(
      "  The deontic result forbids this action, so the action remains blocked. forbid:verified policy.",
    );
    expect(lines).toContain("  Missing required goals: goal-b.");
    expect(lines).toContain("Not selected: Permitted action (score 0.610).");
    expect(lines).toContain(
      "  The deontic result permits this action. permit:verified policy.",
    );
    expect(lines).toContain(
      "  Applicable deontic results conflict, so the action remains blocked. forbid:rule one; permit:rule two.",
    );
    expect(lines).toContain("  No applicable norm regulates this action.");
  });

  it("describes reasoner-derived deontic results without inventing static norms", () => {
    const lines = explainDecisions([
      decision({
        status: "blocked",
        score: -1,
        normStatus: "conflict",
        normReasons: ["permit:verified policy", "reasoner:forbidden"],
      }),
    ]);

    expect(lines).toContain(
      "  Applicable deontic results conflict, so the action remains blocked. permit:verified policy; reasoner:forbidden.",
    );
    expect(lines.join("\n")).not.toContain("Equal-priority");
    expect(lines.join("\n")).not.toContain("strongest applicable norm");
  });

  it("returns no prose for an empty ranking", () => {
    expect(explainDecisions([])).toEqual([]);
  });

  it("labels exact top-score ties without asserting an arbitrary winner", () => {
    const lines = explainDecisions([
      decision({ actionId: "first", label: "First", status: "recommended", score: 0.8 }),
      decision({ actionId: "second", label: "Second", status: "recommended", score: 0.8 }),
    ]);

    expect(lines).toContain("Tied for top: First (score 0.800).");
    expect(lines).toContain("Tied for top: Second (score 0.800).");
    expect(lines.join("\n")).not.toContain("Selected:");
  });

  it("rejects sparse or forged decision rankings", () => {
    const sparse: Decision[] = [];
    sparse.length = 1;
    expect(() => explainDecisions(sparse)).toThrow("decisions must not contain holes");
    const forged = { ...decision({}), score: Number.NaN } as unknown as Decision;
    expect(() => explainDecisions([forged])).toThrow("decision score must be finite");
    expect(() =>
      explainDecisions([
        decision({ actionId: "low", status: "weak", score: 0.1 }),
        decision({ actionId: "high", status: "recommended", score: 0.9 }),
      ]),
    ).toThrow("decisions must be ranked by non-increasing score");
    expect(
      explainDecisions([
        decision({ status: "blocked", score: -1, normStatus: "forbidden" }),
      ])[0],
    ).toBe("Blocked: Action (score -1.000).");
  });
});
