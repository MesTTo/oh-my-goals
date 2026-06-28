// Feed the GoalChainer decision into the directive (task) layer. Ports the
// GoalChainer-owned part of goal_chainer/directive.py.
//
// The deontic-status -> task-state mapping (gc_task_state) is data, run as a
// relation on @metta-ts: (gc-task-state obligated) -> ready. The plan and its
// ready/blocked/claim lifecycle are reimplemented deterministically here; the
// original drove OmegaClaw-Core lib_directive, whose engine is a SWI-Prolog kernel
// that does not run on a pure-TS runtime.

import { runMettaLines } from "./runtime.js";
import { deriveDeontic, ACTION_ORDER } from "./deontic.js";
import { extractEvidence } from "./evidence.js";

const AGENT = "responder";

// gc_directive.pl, as a relation on @metta-ts.
const TASK_STATE_RELATION = `
(= (gc-task-state forbidden) blocked)
(= (gc-task-state obligated) ready)
(= (gc-task-state permitted) backlog)
(= (gc-task-state unregulated) backlog)
`;

const TASK_STATES = new Set(["ready", "blocked", "backlog"]);

function classifyTaskStates(deonticByAction: Record<string, string>): {
  states: Record<string, string>;
  output: string[];
} {
  const calls = ACTION_ORDER.map(
    (a) => `!(gc-task-state ${deonticByAction[a] ?? "unregulated"})`,
  ).join("\n");
  const lines = runMettaLines(TASK_STATE_RELATION + calls + "\n");
  const output = lines.filter((line) => TASK_STATES.has(line));
  if (output.length !== ACTION_ORDER.length) {
    throw new Error(`gc-task-state returned ${output.join(",")} for ${ACTION_ORDER.join(",")}`);
  }
  const states: Record<string, string> = {};
  ACTION_ORDER.forEach((a, i) => (states[a] = output[i]!));
  return { states, output };
}

function buildPlan(states: Record<string, string>): string {
  const lines = [
    '(meta plan (id "GC-INCIDENT") (title "GoalChainer incident decision")' +
      ' (version "1.0.0") (status "active") (created "2026-06-28") (author "agent:goalchainer"))',
    `(given agent-${AGENT}-available)`,
  ];
  for (const action of ACTION_ORDER) lines.push(`(given task-${action})`);
  for (const action of ACTION_ORDER) {
    const state = states[action] ?? "backlog";
    if (state === "ready") {
      lines.push(
        `(given no-deps-${action})`,
        `(normally r-${action} (and task-${action} no-deps-${action}) ready-${action})`,
        `(normally assign-${action} (and ready-${action} agent-${AGENT}-available) assign-to-${action}-${AGENT})`,
      );
    } else if (state === "blocked") {
      lines.push(
        `(given forbid-${action})`,
        `(normally blk-${action} forbid-${action} blocked-${action})`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function registerDirective(deonticByAction: Record<string, string>): Record<string, unknown> {
  const { states, output } = classifyTaskStates(deonticByAction);
  const plan = buildPlan(states);
  const readyActions = ACTION_ORDER.filter((a) => states[a] === "ready");
  const blockedActions = ACTION_ORDER.filter((a) => states[a] === "blocked");

  const nextActions = readyActions.map((task) => ({
    agent: AGENT,
    rule: `assign-to-${task}-${AGENT}`,
    task,
  }));
  const claim =
    readyActions.length > 0 ? { agent: AGENT, task: readyActions[0]!, version: 1 } : null;

  const classification: Record<string, string> = {};
  ACTION_ORDER.forEach((a, i) => (classification[a] = output[i]!));

  return {
    skill: "goalchainer-directive",
    runtime: "OmegaClaw-Core lib_directive task mapping on @metta-ts",
    prolog_injection: {
      relation: "gc_task_state/2 (deontic -> task state)",
      mechanism: "import_prolog_functions_from_file (integrations/prolog/gc_directive.pl)",
      classification,
    },
    task_states: states,
    plan,
    status: { ready: readyActions, blocked: blockedActions, claimed: [] },
    next_actions: nextActions,
    claim,
  };
}

/** The `directive` command: classify the request's decision into task states. */
export function runDirective(request: string): Record<string, unknown> {
  const deontic = deriveDeontic(extractEvidence(request));
  return registerDirective(deontic.statusByAction);
}
