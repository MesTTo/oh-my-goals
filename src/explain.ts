// Render a ranked decision receipt in plain language.

import {
  createDecision,
  SCORE_EQUIVALENCE_EPSILON,
  type Decision,
} from "./models.js";
import { assertDenseArray } from "./records.js";

export function explainDecisions(decisions: readonly Decision[]): string[] {
  assertDenseArray(decisions, "decisions");
  if (decisions.length === 0) return [];
  const validated = decisions.map((decision) => createDecision(decision));
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index]!.score > validated[index - 1]!.score) {
      throw new RangeError("decisions must be ranked by non-increasing score");
    }
  }
  const lines: string[] = [];
  const topScore = validated[0]!.score;
  const topTieCount = validated.filter(
    (decision) => Math.abs(decision.score - topScore) <= SCORE_EQUIVALENCE_EPSILON,
  ).length;
  validated.forEach((decision, index) => {
    const prefix =
      decision.status === "blocked"
        ? "Blocked"
        : topTieCount > 1 &&
            Math.abs(decision.score - topScore) <= SCORE_EQUIVALENCE_EPSILON
        ? "Tied for top"
        : index === 0
          ? "Selected"
          : "Not selected";
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
