// Render a ranked decision receipt in plain language.

import {
  createDecision,
  SCORE_EQUIVALENCE_EPSILON,
  type Decision,
} from "./models.js";
import {
  mettaCall,
  mettaFloat,
  mettaInteger,
  mettaSymbol,
  mettaTuple,
  sharedGoalChainerMetta,
} from "./metta.js";
import { assertDenseArray } from "./records.js";
import { nativeRankingFields } from "./score.js";

const SELECTION_PREFIXES = {
  blocked: "Blocked",
  tied: "Tied for top",
  selected: "Selected",
  "not-selected": "Not selected",
} as const;

type SelectionLabel = keyof typeof SELECTION_PREFIXES;

function nativeSelectionLabels(decisions: readonly Decision[]): SelectionLabel[] {
  const db = sharedGoalChainerMetta();
  const rows = decisions.map((decision, index) =>
    mettaCall(
      "DecisionRow",
      mettaInteger(index),
      mettaInteger(index),
      mettaFloat(decision.score),
      mettaSymbol(decision.status),
    ),
  );
  const rankingResults = db.evalJs(mettaCall(
    "gc-rank-decisions",
    mettaTuple(rows),
    mettaFloat(SCORE_EQUIVALENCE_EPSILON),
  ));
  if (rankingResults.length !== 1) {
    throw new Error(
      `oh-my-goals.metta returned ${rankingResults.length} explanation rankings`,
    );
  }
  const [rankedRows, tiedRows] = nativeRankingFields(rankingResults[0], "explanation");
  const rankedIndexes = rankedRows.map((row, index) => {
    if (
      !Array.isArray(row) ||
      row.length !== 5 ||
      row[0] !== "DecisionRow" ||
      !Number.isSafeInteger(row[1]) ||
      !Number.isSafeInteger(row[2]) ||
      typeof row[3] !== "number" ||
      !Number.isFinite(row[3]) ||
      typeof row[4] !== "string"
    ) {
      throw new Error(`oh-my-goals.metta returned an invalid explanation row at ${index}`);
    }
    const decisionIndex = row[1] as number;
    const decision = decisions[decisionIndex];
    if (
      decision === undefined ||
      row[2] !== decisionIndex ||
      row[3] !== decision.score ||
      row[4] !== decision.status
    ) {
      throw new Error(`oh-my-goals.metta returned an inconsistent explanation row at ${index}`);
    }
    return decisionIndex;
  });
  if (rankedIndexes.some((decisionIndex, index) => decisionIndex !== index)) {
    throw new RangeError("decisions must be ranked by non-increasing score");
  }
  const tiedIndexes = tiedRows;
  if (
    tiedIndexes.length === 0 ||
    tiedIndexes.some(
      (index) =>
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= decisions.length,
    ) ||
    new Set(tiedIndexes).size !== tiedIndexes.length
  ) {
    throw new Error("oh-my-goals.metta returned invalid tied explanation rows");
  }
  const tied = new Set<number>(tiedIndexes as number[]);
  const selectionResults = db.evalJsMany(decisions.map((decision, index) =>
    mettaCall(
      "gc-selection-label",
      mettaSymbol(decision.status),
      tied.has(index),
      tied.size > 1,
    ),
  ));
  return selectionResults.map((values, index) => {
    if (
      values.length !== 1 ||
      typeof values[0] !== "string" ||
      !(values[0] in SELECTION_PREFIXES)
    ) {
      throw new Error(`oh-my-goals.metta returned an invalid selection label at ${index}`);
    }
    return values[0] as SelectionLabel;
  });
}

export function explainDecisions(decisions: readonly Decision[]): string[] {
  assertDenseArray(decisions, "decisions");
  if (decisions.length === 0) return [];
  const validated = decisions.map((decision) => createDecision(decision));
  const selectionLabels = nativeSelectionLabels(validated);
  const lines: string[] = [];
  validated.forEach((decision, index) => {
    const prefix = SELECTION_PREFIXES[selectionLabels[index]!];
    lines.push(`${prefix}: ${decision.label} (score ${decision.score.toFixed(3)}).`);
    lines.push(`  ${normExplanation(decision)}`);
    lines.push(
      `  Evidence strength=${decision.evidence.strength.toFixed(3)}, ` +
        `confidence=${decision.evidence.confidence.toFixed(3)}, ` +
        `expectation=${decision.evidence.expectation.toFixed(3)}.`,
    );
    if (decision.satisfiedGoals.length > 0) {
      lines.push(`  Satisfies: ${decision.satisfiedGoals.join(", ")}.`);
    }
    if (decision.missingRequiredGoals.length > 0) {
      lines.push(`  Missing required goals: ${decision.missingRequiredGoals.join(", ")}.`);
    }
  });
  return lines;
}

function normExplanation(decision: Decision): string {
  const reasons = decision.normReasons.length > 0 ? ` ${decision.normReasons.join("; ")}.` : "";
  switch (decision.normStatus) {
    case "forbidden":
      return `The deontic result forbids this action, so the action remains blocked.${reasons}`;
    case "conflict":
      return `Applicable deontic results conflict, so the action remains blocked.${reasons}`;
    case "obligated":
      return `The deontic result requires this action.${reasons}`;
    case "permitted":
      return `The deontic result permits this action.${reasons}`;
    default:
      return "No applicable norm regulates this action.";
  }
}
