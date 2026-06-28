// Shared decide-and-execute pipeline. Ports goal_chainer/pipeline.py.
// solve decides AND executes: the report carries the ranked decisions and the
// motivation consensus, then the executed, leak-checked deliverable.

import { runGoalChainer } from "./core.js";
import { defaultIncident, executeAction } from "./execute.js";
import { motivationSummary } from "./motivation.js";
import { decisionToDict } from "./models.js";

export function solveIncident(request: string): Record<string, unknown> {
  const { decisions, motivation } = runGoalChainer(request);
  const recommended = decisions.find((d) => d.status === "recommended") ?? decisions[0]!;
  const incident = defaultIncident();
  return {
    request,
    decided: recommended.actionId,
    label: recommended.label,
    status: recommended.status,
    decisions: decisions.map(decisionToDict),
    motivation: motivationSummary(motivation),
    incident,
    executed: executeAction(recommended.actionId, incident),
  };
}
