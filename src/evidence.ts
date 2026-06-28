// Extract decision-relevant evidence from a natural-language request.
// Ports goal_chainer/evidence.py (keyword path). This is the layer that makes
// the decision depend on the input: everything downstream is a function of the
// IncidentEvidence produced here.

export interface IncidentEvidence {
  request: string;
  sensitiveCategories: readonly string[];
  publicDeclared: boolean;
  factsReady: boolean;
  coordinationNeeded: boolean;
  propositions: readonly string[];
  provenance: string;
  conceptScores: Record<string, number>;
  mood: string;
  riskGrounding: string;
}

// Sensitive-data categories and the request words that signal each.
const SENSITIVE_CATEGORIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["customer emails", ["email", "e-mail"]],
  ["order IDs", ["order"]],
  ["request payloads", ["payload"]],
  ["tokens or secrets", ["token", "secret", "credential", "api key", "apikey"]],
  ["full traces", ["trace", "stack trace", "stacktrace"]],
  ["raw logs", ["raw log", "logs", "log line"]],
];

const PUBLIC_SIGNALS: readonly string[] = [
  "no sensitive data",
  "no personal data",
  "no customer data",
  "nothing sensitive",
  "no pii",
  "not sensitive",
  "safe to share",
  "safe to publish",
  "publicly",
  "public information",
  "already public",
];

const NOT_READY_SIGNALS: readonly string[] = [
  "not verified",
  "unverified",
  "not confirmed",
  "unconfirmed",
  "facts are not ready",
  "facts not ready",
  "still investigating",
  "do not know yet",
  "don't know yet",
  "root cause is unknown",
  "no root cause",
];

const COORDINATION_SIGNALS: readonly string[] = [
  "engineering",
  "support",
  "responders",
  "coordinate",
  "incident room",
  "incident channel",
  "team",
  "on-call",
  "oncall",
];

const anySignal = (lower: string, signals: readonly string[]): boolean =>
  signals.some((s) => lower.includes(s));

export function hasSensitiveData(e: IncidentEvidence): boolean {
  return e.sensitiveCategories.length > 0;
}

/** True when there is identifiable data the agent must protect. */
export function privacyAtStake(e: IncidentEvidence): boolean {
  return hasSensitiveData(e) && !e.publicDeclared;
}

export function extractEvidence(request: string): IncidentEvidence {
  const lower = request.toLowerCase();
  const categories = SENSITIVE_CATEGORIES.filter(([, signals]) =>
    signals.some((s) => lower.includes(s)),
  ).map(([label]) => label);
  const publicDeclared = anySignal(lower, PUBLIC_SIGNALS);
  const factsReady = !anySignal(lower, NOT_READY_SIGNALS);
  const coordinationNeeded = anySignal(lower, COORDINATION_SIGNALS);
  const grounding =
    categories.length > 0
      ? `the raw logs contain ${categories.join(", ")}`
      : "the raw logs may expose identifiable data";
  return {
    request,
    sensitiveCategories: categories,
    publicDeclared,
    factsReady,
    coordinationNeeded,
    propositions: [],
    provenance: "keyword",
    conceptScores: {},
    mood: "declarative",
    riskGrounding: grounding,
  };
}

/** The snake_case dict shape goal_chainer's IncidentEvidence.to_dict emits. */
export function evidenceToDict(e: IncidentEvidence): Record<string, unknown> {
  return {
    sensitive_categories: [...e.sensitiveCategories],
    public_declared: e.publicDeclared,
    facts_ready: e.factsReady,
    coordination_needed: e.coordinationNeeded,
    privacy_at_stake: privacyAtStake(e),
    provenance: e.provenance,
    propositions: [...e.propositions],
    concept_scores: { ...e.conceptScores },
    mood: e.mood,
  };
}
