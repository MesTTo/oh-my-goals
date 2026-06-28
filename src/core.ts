// The shared decision core: evidence -> deontic + PLN -> MetaMo consensus ->
// ranked decisions, all on @metta-ts. Used by the solve, decision, and demo
// paths so the ranking is computed one way.

import { incidentResponseScenario } from "./scenarios.js";
import { buildHyperbasePacket, type HyperbasePacket } from "./hyperbase.js";
import { HyperBaseMettaReasoner } from "./reasoner.js";
import { consensusDecision, type MotivationResult } from "./motivation.js";
import { DecisionEngine } from "./score.js";
import type { Decision, GoalScenario } from "./models.js";

export interface GoalChainerRun {
  scenario: GoalScenario;
  packet: HyperbasePacket;
  reasoner: HyperBaseMettaReasoner;
  motivation: MotivationResult;
  decisions: Decision[];
}

export function runGoalChainer(request: string): GoalChainerRun {
  const scenario = incidentResponseScenario(request);
  const packet = buildHyperbasePacket(request);
  const reasoner = new HyperBaseMettaReasoner(packet.reasoner);
  const strengthByAction: Record<string, number> = {};
  for (const action of scenario.actions) {
    strengthByAction[action.id] = reasoner.project(action).strength;
  }
  const motivation = consensusDecision(scenario, strengthByAction);
  const decisions = new DecisionEngine(reasoner, motivation.consensus_scores).rank(scenario);
  return { scenario, packet, reasoner, motivation, decisions };
}
