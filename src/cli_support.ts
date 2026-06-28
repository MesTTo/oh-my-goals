// Per-command output builders shared by the CLI and the differential tests.

import { runGoalChainer } from "./core.js";
import { explainDecisions } from "./explain.js";
import { decisionToDict } from "./models.js";
import type { MotivationResult } from "./motivation.js";

/** The `motivation` command: the full individual-vs-collective consensus. */
export function runMotivation(request: string): MotivationResult {
  return runGoalChainer(request).motivation;
}

/** The `decision` / `demo` command: ranked decisions + why + motivation. */
export function runDecision(request: string): Record<string, unknown> {
  const { scenario, packet, reasoner, motivation, decisions } = runGoalChainer(request);
  return {
    scenario: scenario.title,
    notes: [...scenario.notes],
    runtime: { reasoner: reasoner.source },
    evidence: packet.evidence,
    decisions: decisions.map(decisionToDict),
    explanation: explainDecisions(decisions, packet.reasoner),
    motivation,
  };
}
