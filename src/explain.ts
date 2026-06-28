// Render the decision's proof chain in English. Ports goal_chainer/explain.py.
// It states why the recommended action won and why the others lost, reading the
// real artifacts the pipeline produced (deontic verdict, PLN belief + opinion).

import type { Decision } from "./models.js";
import type { HyperbaseReasonResult } from "./reasoner.js";

export function explainDecisions(decisions: Decision[], reasoner: HyperbaseReasonResult): string[] {
  const evidenceByAction: Record<string, { opinion?: Record<string, number> }> = {};
  for (const row of reasoner.action_evidence) evidenceByAction[row.action_id] = row;

  const lines: string[] = [];
  const top = decisions[0]!;
  lines.push(`Recommended: ${top.label} (score ${top.score.toFixed(3)}).`);
  lines.push("  " + why(top, evidenceByAction[top.actionId]));
  if (top.satisfiedGoals.length > 0) {
    lines.push("  It satisfies: " + top.satisfiedGoals.join(", ") + ".");
  }
  for (const decision of decisions.slice(1)) {
    const verdict = decision.status === "blocked" ? "blocked" : "not chosen";
    lines.push(`${capitalize(verdict)}: ${decision.label} (score ${decision.score.toFixed(3)}).`);
    lines.push("  " + why(decision, evidenceByAction[decision.actionId]));
    if (decision.missingRequiredGoals.length > 0) {
      lines.push("  Missing required goals: " + decision.missingRequiredGoals.join(", ") + ".");
    }
  }
  return lines;
}

function why(decision: Decision, evidenceRow: { opinion?: Record<string, number> } | undefined): string {
  const deontic = decision.normStatus;
  const opinion = evidenceRow?.opinion;
  const op = opinion ? ` PLN belief b=${opinion.b}, d=${opinion.d}, u=${opinion.u}.` : "";
  if (deontic === "forbidden")
    return `lib_deontic derived this action forbidden, so the score is forced negative.${op}`;
  if (deontic === "obligated")
    return `lib_deontic derived this action obligated (the norm positively requires it).${op}`;
  if (deontic === "permitted")
    return `lib_deontic derived this action permitted (allowed, not required).${op}`;
  return `lib_deontic left this action unregulated.${op}`;
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
