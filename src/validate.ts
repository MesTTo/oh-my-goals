// Differential evidence that the decision depends on the input.
// Ports goal_chainer/validation.py. Runs the offline ranking (no MetaMo) over a
// battery of contrasting requests and checks the decision changes as it should:
// the same code blocks the raw log under PII and permits it when the data is public.

import { incidentResponseScenario } from "./scenarios.js";
import { buildHyperbasePacket } from "./hyperbase.js";
import { HyperBaseMettaReasoner } from "./reasoner.js";
import { DecisionEngine } from "./score.js";
import { roundN, type Decision } from "./models.js";

interface ValidationCase {
  name: string;
  request: string;
  summary: string;
}

const CASES: ValidationCase[] = [
  {
    name: "pii_incident",
    request:
      "Checkout is down. Engineering wants to paste raw logs into the incident " +
      "room. Support says the logs may include customer emails, order IDs, and " +
      "request payloads.",
    summary: "sensitive data present, facts ready",
  },
  {
    name: "public_no_data",
    request:
      "The outage is resolved. There is no sensitive data in this status, it is " +
      "safe to share publicly with engineering and support.",
    summary: "no sensitive data, declared safe to share",
  },
  {
    name: "facts_not_ready",
    request:
      "Checkout is down. Engineering wants to share raw logs with customer emails " +
      "and order IDs, but the root cause is unknown and the facts are not ready.",
    summary: "sensitive data present, facts not ready",
  },
];

const check = (label: string, condition: boolean): { check: string; passed: boolean } => ({
  check: label,
  passed: Boolean(condition),
});

export function runValidation(): Record<string, unknown> {
  const results = CASES.map(runCase);
  const rawStatus: Record<string, string> = {};
  const topAction: Record<string, string> = {};
  for (const r of results) {
    rawStatus[r.name as string] = (r.deontic as Record<string, string>).publish_raw_log!;
    topAction[r.name as string] = r.top_action as string;
  }
  const crossChecks = [
    check(
      "raw log forbidden only when privacy is at stake",
      rawStatus.pii_incident === "forbidden" && rawStatus.public_no_data !== "forbidden",
    ),
    check(
      "the recommended action differs across the three requests",
      new Set([topAction.pii_incident, topAction.public_no_data, topAction.facts_not_ready]).size >= 2,
    ),
  ];
  const passed =
    results.every((r) => r.passed) && crossChecks.every((c) => c.passed);
  return {
    passed,
    cases: results,
    cross_checks: crossChecks,
    raw_log_status_by_case: rawStatus,
    top_action_by_case: topAction,
  };
}

function runCase(c: ValidationCase): Record<string, unknown> {
  const scenario = incidentResponseScenario(c.request);
  const packet = buildHyperbasePacket(c.request);
  const reasoner = new HyperBaseMettaReasoner(packet.reasoner);
  const decisions = new DecisionEngine(reasoner).rank(scenario);
  const byId: Record<string, Decision> = {};
  for (const d of decisions) byId[d.actionId] = d;
  const deontic: Record<string, string> = {};
  for (const d of decisions) deontic[d.actionId] = d.normStatus;
  const top = decisions[0]!;
  const checks = caseChecks(c.name, byId, top);
  return {
    name: c.name,
    summary: c.summary,
    request: c.request,
    evidence: packet.evidence,
    top_action: top.actionId,
    deontic,
    ranking: decisions.map((d) => ({
      action_id: d.actionId,
      status: d.status,
      score: roundN(d.score, 4),
      deontic: d.normStatus,
      evidence_strength: roundN(d.evidence.strength, 4),
    })),
    checks,
    passed: checks.every((ch) => ch.passed),
  };
}

function caseChecks(
  name: string,
  byId: Record<string, Decision>,
  top: Decision,
): { check: string; passed: boolean }[] {
  const raw = byId.publish_raw_log!;
  if (name === "pii_incident") {
    return [
      check("raw log is blocked", raw.status === "blocked"),
      check("raw log deontic is forbidden", raw.normStatus === "forbidden"),
      check("redacted summary is recommended", top.actionId === "publish_redacted_summary"),
    ];
  }
  if (name === "public_no_data") {
    return [
      check("raw log is not blocked", raw.status !== "blocked"),
      check("raw log deontic is permitted", raw.normStatus === "permitted"),
    ];
  }
  if (name === "facts_not_ready") {
    return [
      check("raw log is blocked", raw.status === "blocked"),
      check("holding outranks publishing", top.actionId === "hold_external_update"),
    ];
  }
  return [];
}
