# Structured decision input

The CLI accepts one strict JSON object. Unknown fields and dangling references are errors.

```json
{
  "scenario": {
    "title": "<decision title>",
    "goals": [
      {
        "id": "<goal-id>",
        "owner": "<person-or-group>",
        "statement": "<observable desired outcome>",
        "weight": 0.8,
        "kind": "individual",
        "required": true
      }
    ],
    "norms": [
      {
        "id": "<norm-id>",
        "mode": "forbid",
        "targetAction": "<action-id>",
        "reason": "<policy source and reason>",
        "priority": 10
      }
    ],
    "actions": [
      {
        "id": "<action-id>",
        "label": "<short label>",
        "description": "<what the agent would do>",
        "satisfies": ["<goal-id>"],
        "defaultStrength": 0.5,
        "defaultConfidence": 0
      }
    ],
    "notes": []
  },
  "evidence": {
    "<action-id>": {
      "strength": 0.75,
      "confidence": 0.8,
      "source": "<file, command, user statement, or tool result>",
      "projection": null,
      "proofs": []
    }
  }
}
```

`kind` is `individual` or `collective`. `mode` is `oblige`, `permit`, or
`forbid`. Declare at least one goal and one action. Each goal weight is finite and
non-negative, and their aggregate must be finite and positive. Evidence strength,
confidence, and an optional `expectation` are finite values from 0 through 1.
Optional `deontic` is `unregulated`, `permitted`, `obligated`, `forbidden`, or
`conflict`.

The enforced defaults are `required=false`, `priority=0`, `notes=[]`, `evidenceQuery=""`, `evidenceAtoms=[]`, `defaultStrength=0.5`, `defaultConfidence=0`, top-level `evidence={}`, evidence `projection=null`, evidence `proofs=[]`, and evidence `deontic=unregulated`. When evidence `expectation` is omitted, the static reasoner derives `0.5 + confidence * (strength - 0.5)`. Any parseable `STV` in `projection` must agree with the explicit strength and confidence. Omit non-nullable optional fields instead of supplying `null`. Nonempty `evidenceAtoms` require a nonempty `evidenceQuery`. The `decide` CLI accepts static evidence only and rejects nonempty contextual declarations. The contextual fields are available through the TypeScript API when `evaluateScenario` receives a `ContextualQueryEvidenceReasoner`.

Omitted evidence has strength `0.5` and confidence `0`. The neutral prior cannot
produce a recommendation on its own. Set action defaults only when the caller has an
explicit prior that applies before action-specific evidence is available.

Every `satisfies` entry must name a declared goal and may appear only once per action. Every norm and evidence entry must name a declared action. IDs must be unique within each entity kind.

Strength measures support for the action-evidence proposition. Confidence measures
the reliability and coverage of that estimate. Use numeric values only when the
source provides a defensible mapping, such as an explicit truth value, a measured
rate with known coverage, or a named policy-engine result. A passing command proves
only what that command checks. It does not justify high confidence for unrelated
claims. Omit the evidence entry, or use confidence `0`, when no numeric calibration
can be defended.

The decision receipt contains the full scenario declaration, `selected`, `status`,
`tied_actions`, `selection_tied`, `automatic_execution_allowed`, ranked `decisions`,
and the effective motivation inputs and scores. Each decision
includes its score, norm status and reasons, satisfied goals, missing required
goals, warnings, evidence projection, and provenance metadata. Scores within
`1e-12` are treated as tied, and automatic execution remains disabled for those
near ties.
