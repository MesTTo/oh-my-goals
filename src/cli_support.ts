// Per-command output builders shared by the CLI and the differential tests.

import { runGoalChainer } from "./core.js";
import { explainDecisions } from "./explain.js";
import { decisionToDict } from "./models.js";
import { loadColoreContext } from "./ontology.js";
import type { MotivationResult } from "./motivation.js";

/** The `motivation` command: the full individual-vs-collective consensus. */
export function runMotivation(request: string): MotivationResult {
  return runGoalChainer(request).motivation;
}

/** The `decision` / `demo` command: the rich packet, ranked decisions, why, and
 * the individual-vs-collective consensus. */
export function runDecision(request: string): Record<string, unknown> {
  const ontology = loadColoreContext();
  const { scenario, packet, reasoner, motivation, decisions } = runGoalChainer(request, ontology);
  return {
    scenario: scenario.title,
    notes: [...scenario.notes],
    runtime: { reasoner: reasoner.source },
    hyperbase: packet,
    decisions: decisions.map(decisionToDict),
    explanation: explainDecisions(decisions, packet.reasoner),
    motivation,
  };
}
