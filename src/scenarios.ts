// Incident scenario whose action/goal links are derived from the evidence.
// Ports goal_chainer/scenarios.py.

import type { IncidentEvidence } from "./evidence.js";
import { extractEvidence, privacyAtStake } from "./evidence.js";
import type { CandidateAction, Goal, GoalScenario, Norm } from "./models.js";

export const DEFAULT_INCIDENT_REQUEST =
  "Checkout is down. Engineering wants to paste raw logs into the incident room. " +
  "Support says the logs may include customer emails, order IDs, and request payloads.";

export function incidentGoals(): Goal[] {
  return [
    {
      id: "preserve_privacy",
      owner: "ava",
      statement: "Do not expose identifiable user data.",
      weight: 0.95,
      kind: "individual",
      required: true,
    },
    {
      id: "restore_service",
      owner: "ops-team",
      statement: "Restore the failing service quickly.",
      weight: 0.9,
      kind: "collective",
      required: true,
    },
    {
      id: "coordinate_team",
      owner: "incident-team",
      statement: "Give responders enough shared context to coordinate.",
      weight: 0.75,
      kind: "collective",
      required: true,
    },
  ];
}

export function policyNorms(): Norm[] {
  return [
    { id: "no-raw-pii", mode: "forbid", targetAction: "publish_raw_log", priority: 20, reason: "raw incident logs may contain personal data" },
    { id: "share-redacted-status", mode: "oblige", targetAction: "publish_redacted_summary", priority: 12, reason: "responders need a status artifact that protects privacy" },
    { id: "temporary-hold-permitted", mode: "permit", targetAction: "hold_external_update", priority: 5, reason: "a short hold is allowed while facts are checked" },
  ];
}

function rawLogSatisfies(evidence: IncidentEvidence): string[] {
  const goals = ["restore_service", "coordinate_team"];
  if (!privacyAtStake(evidence)) goals.unshift("preserve_privacy");
  return goals;
}

function redactedSatisfies(evidence: IncidentEvidence): string[] {
  const goals = ["preserve_privacy"];
  if (evidence.factsReady) goals.push("restore_service", "coordinate_team");
  return goals;
}

function notes(evidence: IncidentEvidence): string[] {
  if (!privacyAtStake(evidence)) {
    return [
      "The request carries no identifiable data, so the raw log is no longer privacy-risky and becomes an acceptable option.",
      "The redacted summary still covers every goal and stays the safe default.",
    ];
  }
  if (!evidence.factsReady) {
    return [
      "The raw log is blocked by the derived privacy prohibition.",
      "Facts are not ready, so an external update is premature and holding wins.",
    ];
  }
  return [
    "The raw log advances coordination but is blocked by the derived privacy prohibition.",
    "The redacted summary satisfies all required goals and is the recommended action.",
    "The hold protects privacy but misses the required collective goals.",
  ];
}

export function incidentScenario(evidence: IncidentEvidence): GoalScenario {
  const actions: CandidateAction[] = [
    {
      id: "publish_raw_log",
      label: "Publish raw incident log",
      description: "Share the full raw log with the whole response channel.",
      satisfies: rawLogSatisfies(evidence),
      evidenceQuery: "(: $prf (Acceptable publish_raw_log) $tv)",
      evidenceAtoms: [],
      defaultStrength: 0.18,
      defaultConfidence: 0.99,
    },
    {
      id: "publish_redacted_summary",
      label: "Publish redacted summary",
      description: "Share a summary with identifiers removed and enough detail to coordinate.",
      satisfies: redactedSatisfies(evidence),
      evidenceQuery: "(: $prf (Acceptable publish_redacted_summary) $tv)",
      evidenceAtoms: [],
      defaultStrength: 0.91,
      defaultConfidence: 0.99,
    },
    {
      id: "hold_external_update",
      label: "Hold external update",
      description: "Keep information internal until the team checks the evidence.",
      satisfies: ["preserve_privacy"],
      evidenceQuery: "(: $prf (Acceptable hold_external_update) $tv)",
      evidenceAtoms: [],
      defaultStrength: 0.58,
      defaultConfidence: 0.99,
    },
  ];
  return {
    title: "Incident response with individual privacy and collective repair goals",
    goals: incidentGoals(),
    norms: policyNorms(),
    actions,
    notes: notes(evidence),
  };
}

export function incidentResponseScenario(request: string = DEFAULT_INCIDENT_REQUEST): GoalScenario {
  return incidentScenario(extractEvidence(request));
}
