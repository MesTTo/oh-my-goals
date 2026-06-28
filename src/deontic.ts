// Derive each action's deontic status with a defeasible-deontic micro-engine on
// @metta-ts. Ports goal_chainer/deontic_engine.py.
//
// The original ran OmegaClaw-Core's lib_deontic on PeTTa, whose platform layer
// registers SWI-Prolog kernels (grounding.pl, reason.pl, deontic.pl) -- so it
// cannot run on a pure-TS runtime. Here the same theory GoalChainer generates
// (given facts; defeasible `normally` rules with must/may/forbidden heads) is run
// through a small defeasible engine written in MeTTa: a `normally` rule fires its
// deontic head when its body is a `given` fact. The F>O>P dominance fold (which
// the Python did in `_parse_status`) stays in TypeScript.

import { runMettaLines } from "./runtime.js";
import type { IncidentEvidence } from "./evidence.js";
import { privacyAtStake } from "./evidence.js";

export const ACTION_ORDER = [
  "publish_raw_log",
  "publish_redacted_summary",
  "hold_external_update",
] as const;

const MODE_TO_STATUS: Record<string, string> = { F: "forbidden", O: "obligated", P: "permitted" };
const STATUS_RANK: Record<string, number> = {
  forbidden: 3,
  obligated: 2,
  permitted: 1,
  unregulated: 0,
};

export interface DeonticResult {
  statusByAction: Record<string, string>;
  theory: string;
  conclusions: string;
}

export function deonticStatus(result: DeonticResult, actionId: string): string {
  return result.statusByAction[actionId] ?? "unregulated";
}

// The fixed defeasible engine: fire every `normally` rule whose body is `given`,
// and collect any directly-given deontic literal. Output is the set of deontic
// literals (MODE action) that hold.
const DEONTIC_ENGINE = `
(= (deon-lit) (match &self (normally $n $b $h) (match &self (given $b) $h)))
(= (deon-lit) (match &self (given (forbidden $a)) (forbidden $a)))
(= (deon-lit) (match &self (given (may $a)) (may $a)))
(= (deon-lit) (match &self (given (must $a)) (must $a)))
!(collapse (deon-lit))
`;

/** Project the evidence into a pure-MeTTa defeasible-deontic theory. */
export function buildTheory(evidence: IncidentEvidence): string {
  const lines: string[] = [];
  const privacy = privacyAtStake(evidence);
  // publish_raw_log: forbidden when identifiable data is at stake, else permitted.
  if (privacy) {
    lines.push(
      "(given (risky publish_raw_log))",
      "(normally rRawForbid (risky publish_raw_log) (forbidden publish_raw_log))",
    );
  } else {
    lines.push(
      "(given (safe publish_raw_log))",
      "(normally rRawPermit (safe publish_raw_log) (may publish_raw_log))",
    );
  }
  // publish_redacted_summary: obliged when facts are ready, otherwise permitted.
  lines.push("(given (protects publish_redacted_summary))");
  if (evidence.factsReady) {
    lines.push(
      "(normally rRedOblige (protects publish_redacted_summary) (must publish_redacted_summary))",
    );
  } else {
    lines.push(
      "(normally rRedPermit (protects publish_redacted_summary) (may publish_redacted_summary))",
    );
  }
  // hold_external_update: obliged while facts are not ready, otherwise permitted.
  if (!evidence.factsReady) {
    lines.push(
      "(given (factsUnready))",
      "(normally rHoldOblige (factsUnready) (must hold_external_update))",
    );
  } else {
    lines.push("(given (may hold_external_update))");
  }
  return lines.join("\n") + "\n";
}

const LITERAL_RE = /\((forbidden|may|must)\s+([a-z_]+)\)/g;
const MODE_LETTER: Record<string, string> = { forbidden: "F", must: "O", may: "P" };

export function deriveDeontic(evidence: IncidentEvidence): DeonticResult {
  const theory = buildTheory(evidence);
  const lines = runMettaLines(theory + DEONTIC_ENGINE);
  // The engine emits one collapsed group: a tuple of deontic literals.
  const conclusions = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
  const statusByAction: Record<string, string> = {};
  for (const match of conclusions.matchAll(LITERAL_RE)) {
    const action = match[2]!;
    const candidate = MODE_TO_STATUS[MODE_LETTER[match[1]!]!]!;
    if ((STATUS_RANK[candidate] ?? 0) > (STATUS_RANK[statusByAction[action] ?? "unregulated"] ?? 0)) {
      statusByAction[action] = candidate;
    }
  }
  for (const actionId of ACTION_ORDER) {
    if (!(actionId in statusByAction)) statusByAction[actionId] = "unregulated";
  }
  return { statusByAction, theory, conclusions };
}
