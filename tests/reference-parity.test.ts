import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveNorms } from "../src/deontic.js";
import { consensusDecision } from "../src/motivation.js";
import { createGoal } from "../src/models.js";
import { decideActions, type DecideActionRow } from "../src/native_score.js";
import {
  goalCoverage,
  missingRequiredGoals,
  normalizeFiniteMotivation,
} from "../src/score.js";

const REFERENCE_COMMIT = "23f49515b1556ce04981f74bde4b56ee0a4375c6";
const referenceRoot = process.env.GOALCHAINER_REFERENCE_REPO;

const PYTHON_ORACLE = String.raw`
import json
import sys
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1] + "/src")

from goal_chainer.deontic import resolve_norms
from goal_chainer.models import EvidenceProjection, Goal, Norm
from goal_chainer.motivation import _score
from goal_chainer.scoring import (
    _combined_score,
    _decision_status,
    _goal_scores,
    _missing_required_goals,
    _normalized_motivation,
)

payload = json.load(sys.stdin)
norms = tuple(
    Norm(
        id=row["id"],
        mode=row["mode"],
        target_action=row["targetAction"],
        reason=row["reason"],
        priority=row["priority"],
    )
    for row in payload["norms"]
)
deontic = []
for action_id in payload["actionIds"]:
    result = resolve_norms(action_id, norms)
    deontic.append({
        "status": result.status,
        "reasons": list(result.reasons),
        "priority": result.priority,
    })

decisions = []
for row in payload["decisionRows"]:
    evidence = EvidenceProjection(
        strength=row[1],
        confidence=row[2],
        source="reference",
        deontic=row[0],
    )
    score = _combined_score(
        goal_score=0.0,
        individual_score=0.0,
        collective_score=0.0,
        evidence=evidence,
        deontic=row[0],
        motivation=row[3],
    )
    decisions.append([score, _decision_status(row[0], score, ["missing"] if row[4] else [])])

normalizations = []
for values in payload["normalizations"]:
    actions = [SimpleNamespace(id=str(index)) for index in range(len(values))]
    scenario = SimpleNamespace(actions=actions)
    scores = {str(index): value for index, value in enumerate(values)}
    normalized = _normalized_motivation(scenario, scores)
    normalizations.append([normalized[str(index)] for index in range(len(values))])

goals = tuple(Goal(**row) for row in payload["goals"])
coverage = []
missing = []
for satisfied in payload["satisfied"]:
    coverage.append(_goal_scores(goals, tuple(satisfied)))
    missing.append(_missing_required_goals(goals, tuple(satisfied)))

adversarial_coverage = []
motivation_dots = []
for count in (8, 9, 16, 17, 32, 33):
    numeric_goals = tuple(
        Goal(
            id=f"numeric-{index}",
            owner="caller",
            statement=f"Numeric goal {index}",
            weight=1e16 if index == 0 else 1.0,
            kind="individual",
            required=False,
        )
        for index in range(count)
    )
    adversarial_coverage.append(
        _goal_scores(numeric_goals, (numeric_goals[0].id,))
    )
    correlations = [1.0] + [1e-16] * (count - 2) + [-1.0]
    motivation_dots.append(
        _score([1.0] * count, {"corr": correlations, "risk": 0.0}, False)
    )

json.dump({
    "deontic": deontic,
    "decisions": decisions,
    "normalizations": normalizations,
    "coverage": coverage,
    "missing": missing,
    "adversarialCoverage": adversarial_coverage,
    "motivationDots": motivation_dots,
}, sys.stdout, allow_nan=False)
`;

function randomRows(): DecideActionRow[] {
  let state = 0x6d2b79f5;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const statuses = [
    "unregulated",
    "permitted",
    "obligated",
    "forbidden",
    "conflict",
  ] as const;
  return Array.from({ length: 128 }, (_, index) => [
    statuses[index % statuses.length]!,
    random(),
    random(),
    random(),
    index % 7 === 0 ? 1 : 0,
  ] as const);
}

describe.skipIf(referenceRoot === undefined)("pinned source differential parity", () => {
  it("matches deontic, scoring, normalization, and goal coverage semantics", () => {
    const root = resolve(referenceRoot!);
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(commit).toBe(REFERENCE_COMMIT);

    const actionIds = ["action-a", "action-b", "action-c"];
    const modes = ["permit", "oblige", "forbid"] as const;
    const norms = Array.from({ length: 96 }, (_, index) => ({
      id: `norm-${index}`,
      mode: modes[index % modes.length]!,
      targetAction: actionIds[index % actionIds.length]!,
      reason: `reason-${index}`,
      priority: (index * 17) % 11 - 5,
    }));
    const decisionRows = randomRows();
    const normalizations = [
      [-3, -1],
      [-2, -1, 0],
      [1, 2, 3],
      [3, 3],
      [0.125, 0.5, 0.875, 1],
    ];
    const goals = [
      { id: "g-a", owner: "one", statement: "A", weight: 2, kind: "individual", required: true },
      { id: "g-b", owner: "two", statement: "B", weight: 3, kind: "collective", required: false },
      { id: "g-c", owner: "three", statement: "C", weight: 5, kind: "collective", required: true },
      ...Array.from({ length: 38 }, (_, index) => ({
        id: `g-extra-${index}`,
        owner: `owner-${index % 4}`,
        statement: `Extra goal ${index}`,
        weight: (index % 7) + 1,
        kind: (index % 2 === 0 ? "individual" : "collective") as
          | "individual"
          | "collective",
        required: index % 3 === 0,
      })),
    ];
    const satisfied = [
      [],
      ["g-a"],
      ["g-b", "g-c"],
      goals.filter((_, index) => index % 3 !== 1).map((goal) => goal.id),
    ];
    const process = spawnSync("python3", ["-c", PYTHON_ORACLE, root], {
      input: JSON.stringify({ actionIds, norms, decisionRows, normalizations, goals, satisfied }),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(process.status, process.stderr).toBe(0);
    const reference = JSON.parse(process.stdout) as {
      deontic: Array<{ status: string; reasons: string[]; priority: number }>;
      decisions: Array<[number, string]>;
      normalizations: number[][];
      coverage: Array<{ all: number; individual: number; collective: number }>;
      missing: string[][];
      adversarialCoverage: Array<{ all: number; individual: number; collective: number }>;
      motivationDots: number[];
    };

    expect(actionIds.map((actionId) => {
      const result = resolveNorms(actionId, norms);
      return { status: result.status, reasons: [...result.reasons], priority: result.priority };
    })).toEqual(reference.deontic);

    const decisions = decideActions(decisionRows);
    decisions.forEach((decision, index) => {
      expect(decision[0]).toBeCloseTo(reference.decisions[index]![0], 14);
      expect(decision[1]).toBe(reference.decisions[index]![1]);
    });
    normalizations.forEach((values, index) => {
      const actual = normalizeFiniteMotivation(values);
      actual.forEach((value, valueIndex) =>
        expect(value).toBeCloseTo(reference.normalizations[index]![valueIndex]!, 14)
      );
    });

    const stableGoals = goals.map((goal) => createGoal(goal));
    satisfied.forEach((goalIds, index) => {
      expect(goalCoverage(stableGoals, goalIds)).toEqual(reference.coverage[index]);
      expect(missingRequiredGoals(stableGoals, goalIds)).toEqual(reference.missing[index]);
    });

    [8, 9, 16, 17, 32, 33].forEach((count, index) => {
      const numericGoals = Array.from({ length: count }, (_, goalIndex) => createGoal({
        id: `numeric-${goalIndex}`,
        owner: "caller",
        statement: `Numeric goal ${goalIndex}`,
        weight: goalIndex === 0 ? 1e16 : 1,
        kind: "individual",
        required: false,
      }));
      expect(goalCoverage(numericGoals, [numericGoals[0]!.id])).toEqual(
        reference.adversarialCoverage[index],
      );

      const actionId = `numeric-action-${count}`;
      const correlations = Object.fromEntries(numericGoals.map((goal, goalIndex) => [
        goal.id,
        goalIndex === 0 ? 1 : goalIndex === count - 1 ? -1 : 1e-16,
      ]));
      const motivation = consensusDecision({
        title: `Numeric motivation ${count}`,
        goals: numericGoals,
        norms: [],
        actions: [{
          id: actionId,
          label: actionId,
          description: actionId,
          satisfies: [],
          evidenceQuery: "",
          evidenceAtoms: [],
          defaultStrength: 1,
          defaultConfidence: 1,
        }],
        notes: [],
      }, {}, {
        correlations: { [actionId]: correlations },
        risks: { [actionId]: 0 },
      });
      expect(motivation.consensus_scores[actionId]).toBe(reference.motivationDots[index]);
    });
  });
});
