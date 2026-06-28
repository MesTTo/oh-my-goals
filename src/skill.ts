// OmegaClaw skill surface for GoalChainer, ported from gcskill.py /
// omegaclaw_skill.py. Each function returns a short plain string the agent reads
// as feedback. The full pipeline runs on @metta-ts.

import { runGoalChainer } from "./core.js";
import { solveIncident } from "./pipeline.js";
import { runMotivation } from "./cli_support.js";
import { deriveIncident } from "./snars.js";
import { decisionToDict } from "./models.js";

const SYSTEM_PROMPT =
  "GoalChainer is a goal-aware decision skill. Given an incident request, it weighs " +
  "individual goals, collective goals, deontic norms, and graded evidence before the " +
  "agent acts. It runs on @metta-ts (pure-TypeScript MeTTa): lib_deontic for the " +
  "forbidden/obligated/permitted verdict, a PLN contextual query for graded belief, " +
  "SNARS for a subjective-logic opinion, and MetaMo to reconcile the individual goal " +
  "against the collective one. Call goalchainer-decision to rank actions, " +
  "goalchainer-solve to decide and execute on real data with a leak check, " +
  "goalchainer-motivation for the individual-vs-collective consensus, and " +
  "goalchainer-snars for the subjective-logic deduction.";

interface DecisionDict {
  action_id: string;
  status: string;
  score: number;
  norm_status: string;
}

const recommended = (decisions: DecisionDict[]): DecisionDict =>
  decisions.find((d) => d.status === "recommended") ?? decisions[0]!;
const blockedOf = (decisions: DecisionDict[]): DecisionDict | undefined =>
  decisions.find((d) => d.status === "blocked");

function reasoningLines(
  decisions: DecisionDict[],
  motivation: { goal_pull: { individual: string; collective: string }; consensus: string } | null,
): string[] {
  const lines: string[] = [];
  const blocked = blockedOf(decisions);
  if (blocked) lines.push(`  blocked:     ${blocked.action_id}  (lib_deontic: ${blocked.norm_status})`);
  if (motivation) {
    lines.push(`  individual -> ${motivation.goal_pull.individual} ; collective -> ${motivation.goal_pull.collective}`);
    lines.push(`  consensus (MetaMo): ${motivation.consensus}`);
  }
  return lines;
}

export function systemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function decision(request: string): string {
  const { decisions, motivation } = runGoalChainer(request);
  const dd = decisions.map(decisionToDict) as unknown as DecisionDict[];
  const top = recommended(dd);
  const lines = [
    "DECISION (GoalChainer on @metta-ts: lib_deontic + PLN + MetaMo)",
    `  recommended: ${top.action_id}  (score ${top.score})`,
    ...reasoningLines(dd, motivation),
  ];
  return lines.join("\n");
}

export function solve(request: string): string {
  const payload = solveIncident(request);
  const executed = payload.executed as Record<string, unknown>;
  const leak = executed.leak_check as Record<string, unknown>;
  const decisions = (payload.decisions as unknown as DecisionDict[]) ?? [];
  const motivation = payload.motivation as
    | { goal_pull: { individual: string; collective: string }; consensus: string }
    | null;
  const lines = [
    `SOLVE: decided ${payload.decided} (${payload.status}), channel ${executed.channel}`,
    ...reasoningLines(decisions, motivation),
  ];
  const artifact = executed.artifact as { diagnostics?: Record<string, string> } | null;
  if (artifact && artifact.diagnostics) {
    const kept = artifact.diagnostics.error_code;
    const redacted = Object.entries(artifact.diagnostics)
      .filter(([, v]) => v === "[redacted]")
      .map(([k]) => k);
    lines.push(`  redacted: ${redacted.join(", ")}`);
    lines.push(`  kept: error_code=${kept}`);
  }
  lines.push(`  leak check: safe=${leak.safe} leaked=${JSON.stringify(leak.leaked)}`);
  return lines.join("\n");
}

export function motivation(request: string): string {
  const m = runMotivation(request);
  if (!m.consensus) return "motivation: MetaMo runtime unavailable";
  return (
    `MOTIVATION: individual -> ${m.goal_pull.individual} ; ` +
    `collective -> ${m.goal_pull.collective} ; consensus -> ${m.consensus}`
  );
}

export function snars(request: string): string {
  const payload = deriveIncident(request) as Record<string, unknown>;
  const op = payload.opinion as Record<string, number> | undefined;
  if (!op) return "snars: runtime unavailable";
  return (
    `SNARS: ${payload.claim}  (derived=${payload.derived})  ` +
    `opinion b=${op.b} d=${op.d} u=${op.u}`
  );
}
