// goalchainer-ts: a goal-aware agent decision layer whose reasoning runs on
// @metta-ts (pure-TypeScript MeTTa). Public API.

export * from "./models.js";
export { extractEvidence, privacyAtStake, evidenceToDict, type IncidentEvidence } from "./evidence.js";
export { incidentScenario, incidentResponseScenario, DEFAULT_INCIDENT_REQUEST } from "./scenarios.js";

// Reasoning engines on @metta-ts
export { deriveDeontic, buildTheory, ACTION_ORDER, type DeonticResult } from "./deontic.js";
export { gradeBeliefs, type Belief } from "./pln.js";
export { derive, deriveIncident } from "./snars.js";
export { consensusDecision, motivationSummary, type MotivationResult } from "./motivation.js";
export { reasonOverHyperbase, HyperBaseMettaReasoner } from "./reasoner.js";

// Decision + execution
export { DecisionEngine } from "./score.js";
export { runGoalChainer } from "./core.js";
export { solveIncident } from "./pipeline.js";
export { runValidation } from "./validate.js";
export { runDirective, registerDirective } from "./directive.js";
export { runMotivation, runDecision } from "./cli_support.js";
export { explainDecisions } from "./explain.js";
export { defaultIncident, executeAction, redact, type Incident } from "./execute.js";

// Truth-value kernels
export { deduce, revise, slOpinion, nalExpectation, evidenceToOpinion } from "./truth.js";

// OmegaClaw skill surface
export * as skill from "./skill.js";
