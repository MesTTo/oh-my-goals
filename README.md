# goalchainer-ts

GoalChainer ranks actions against explicit goals, policy norms, and graded evidence before an agent acts. The decision rules run on [MeTTa-TS](https://github.com/MesTTo/Meta-TypeScript-Talk). The package accepts caller-supplied structured data and has no built-in scenario or action handlers.

## Install

Node.js 20 or newer is required.
The JavaScript entry point is ESM-only. CommonJS callers must use dynamic `import()`.

Until the package is published to npm, install a verified tarball from a checkout:

```bash
cd /path/to/goalchainer-ts
npm ci
npm run verify
mkdir -p ai-tmp
npm pack --pack-destination ai-tmp

cd /path/to/consumer-project
npm install /path/to/goalchainer-ts/ai-tmp/goalchainer-ts-0.1.0.tgz
npx --no-install goalchainer --help
```

After publication, consumers can use `npm install goalchainer-ts`.

SWI-Prolog is optional. It is used only when you call the live Prolog interoperability checks.

## Decide from JSON

The [complete input schema](skills/goalchainer/references/input-schema.md) lists every field and default. CLI input is limited to 2 MiB.

Write a scenario with goals, norms, actions, and any grounded evidence:

```json
{
  "scenario": {
    "title": "Choose a change strategy",
    "goals": [
      {
        "id": "preserve-behavior",
        "owner": "maintainers",
        "statement": "Keep the documented behavior unchanged",
        "weight": 1,
        "kind": "collective",
        "required": true
      },
      {
        "id": "limit-risk",
        "owner": "operator",
        "statement": "Limit the chance of an unsafe rollout",
        "weight": 0.9,
        "kind": "individual",
        "required": true
      }
    ],
    "norms": [
      {
        "id": "no-unverified-change",
        "mode": "forbid",
        "targetAction": "apply-unverified-change",
        "reason": "The change has no passing verification result",
        "priority": 10
      }
    ],
    "actions": [
      {
        "id": "apply-verified-change",
        "label": "Apply the verified change",
        "description": "Apply the change whose focused and regression checks pass",
        "satisfies": ["preserve-behavior", "limit-risk"]
      },
      {
        "id": "apply-unverified-change",
        "label": "Apply the unverified change",
        "description": "Apply the change before verification",
        "satisfies": ["preserve-behavior"]
      }
    ]
  },
  "evidence": {
    "apply-verified-change": {
      "strength": 0.9,
      "confidence": 0.95,
      "source": "caller calibration: 9 of 10 required checks passed with 95% check coverage"
    }
  }
}
```

In the example, strength comes from the observed pass ratio and confidence comes
from the caller's measured coverage. Do not copy these values for an uncalibrated
test result.

Run the decision gate:

```bash
npx --no-install goalchainer decide --input scenario.json --pretty
```

Use `--input -` to read JSON from stdin. Unknown fields, duplicate IDs, invalid probabilities, and dangling goal or action references are rejected with exit code 2. A valid decision writes JSON to stdout. Runtime failures use exit code 1.

The receipt identifies the selected action and includes the complete scenario declaration plus every ranked decision. The declaration retains goals, norms, actions, and notes so the score can be audited after a temporary input is removed. Decision scores retain full precision so threshold statuses can be replayed. `selection_tied`, `tied_actions`, and `automatic_execution_allowed` prevent an input-order tie from becoming an automatic action. The motivation audit retains the effective correlations, risks, subsystem vectors, and consensus scores. Each decision row contains its score, deontic status and reasons, satisfied goals, missing required goals, evidence projection, warnings, and provenance metadata. `forbidden` and `conflict` results are always blocked.

The motivation path computes `0.54 * normalized_motivation + 0.38 * strength * confidence`, plus `0.1` for an obligation. Motivation uses min-max normalization across the candidate consensus values. Equal positive values normalize to `1`. An entirely nonpositive vector normalizes to `0` so negative consensus cannot become recommendation support. When motivation is disabled, the score is `0.42 * goal_coverage + 0.38 * strength * confidence + 0.12 * min(individual_coverage, collective_coverage)`, plus the same obligation bonus. Blocked decisions have score `-1`. Other decisions are `recommended` at score `0.72` or higher with no missing required goal, `candidate` at score `0.5` or higher, and `weak` below `0.5`.

Do not put credentials, tokens, private keys, or unredacted sensitive data in the input. The receipt repeats scenario text and evidence provenance on stdout.

## TypeScript API

```ts
import {
  GoalChainer,
  executeDecision,
  explainDecisions,
  goalChainerRunToJson,
} from "goalchainer-ts";

const chainer = new GoalChainer();
const run = chainer.evaluate(input);

console.log(goalChainerRunToJson(run));
console.log(explainDecisions(run.decisions).join("\n"));

if (run.automaticExecutionAllowed && actionIsAvailable && userAlreadyAuthorizedIt) {
  await executeDecision(run.selected, context, {
    "apply-verified-change": async (value) => applyChange(value),
  });
}
```

`GoalChainer` validates unknown input at the boundary. `evaluateScenario` accepts a validated scenario and a custom evidence reasoner. `StaticEvidenceReasoner` reads explicit evidence and action defaults. `PlnEvidenceReasoner` projects beliefs from the generic PLN engine. `ContextualQueryEvidenceReasoner` passes each action's `evidenceQuery` and `evidenceAtoms` to a caller-injected synchronous adapter. Nonempty `evidenceAtoms` require a nonempty `evidenceQuery`. The `decide` CLI and `runGoalChainer` use static evidence and reject nonempty contextual declarations instead of ignoring them.

Omitted evidence uses a neutral strength of `0.5` with confidence `0`. It cannot
produce a recommendation by itself. `executeDecision` enforces the blocked-action
boundary. Automatic callers should require `automaticExecutionAllowed`; a top-score
tie leaves it false even when each tied action is individually `recommended`.
Scores within `1e-12` are treated as tied so binary64 rounding cannot authorize an
arbitrary winner.

The lower-level API also exports:

- `resolveNorms` and `resolveNormsBatch` for priority-aware deontic resolution.
- `scoreActions` and `decideActions` for the MeTTa-TS score and status rules.
- `gradeBeliefs` for PLN deduction and count-space revision.
- `consensusDecision` for individual and collective goal reconciliation with caller-supplied correlations and risks.
- `assess` and `derive` for SNARS subjective-logic receipts.
- `createDirectivePlan` and `DirectiveLifecycle` for ordered task status, assignment, and instance-local atomic claims.
- `makeProposition` and `buildHyperbasePacket` for structured propositions and Semantic-Hypergraph facts.
- `loadColoreContext` for the packaged COLORE ontology context. An explicit source takes precedence over `GOALCHAINER_COLORE_PATH`.
- `redactRecord`, `detectLeaks`, and `executeDecision` for caller-owned execution boundaries.

## Coding-agent skill

The package ships one [Agent Skills](https://agentskills.io/specification) definition and materializes the same files into each tool's supported location.

```bash
npx --no-install goalchainer install-skill --agent codex --scope project
npx --no-install goalchainer install-skill --agent claude --scope project
npx --no-install goalchainer install-skill --agent opencode --scope project
```

Use `--agent all` to install the shared `.agents/skills` layout used by Codex and OpenCode plus the `.claude/skills` layout used by Claude Code. Use `--agent opencode` when you specifically want `.opencode/skills` instead. User installs target the corresponding directories under your home directory. Existing differing files or modes are never replaced unless you pass `--force`.

OpenCode also scans `.claude/skills`. In a project installed with `--agent all`,
OpenCode may log a duplicate-name warning for the two identical copies. Install
only the target you use when you want one discovery entry.

The skill tells the coding agent to derive structured input from the current task, keep goals, norms, and evidence calibration attributable to the user or repository, call the JSON CLI, and stop unless automatic execution is allowed. It does not call a hosted model or read authentication state.

## MeTTa and Prolog

The deontic, scoring, motivation, PLN, SNARS, and directive rules run on `@metta-ts` 1.1.3. TypeScript handles validation, filesystem access, process I/O, and caller-owned executor dispatch.

The package also includes `assets/gc_score.pl` and `assets/gc_directive.pl`. Their relations are imported through `@metta-ts/prolog`, then compared with the native MeTTa-TS rules:

```bash
npx --no-install goalchainer prolog-check --pretty
```

The command starts the local `swipl` executable, runs both parity checks, disposes the bridge, and exits nonzero if a relation differs.

ProbMeTTa is not bundled. Its current library targets PeTTa, which compiles MeTTa programs to SWI-Prolog, while `@metta-ts/prolog` imports named Prolog relations into MeTTa-TS. A future probabilistic evidence reasoner can implement the existing `EvidenceReasoner` contract with native MeTTa-TS rules and BDD weighted model counting. A PeTTa-backed adapter would remain optional and would need an explicit compilation boundary rather than being loaded as a MeTTa-TS library.

## Development

```bash
npm ci
npm test
npm run build
npm run test:package
```

`npm run test:package` cleans the build output, packs the npm tarball from copied live sources, installs it into an isolated consumer, and checks the public API, CLI, assets, and Agent Skill.

## License

The original package code and documentation are MIT licensed. The packaged COLORE
ontology data is CC BY-SA 4.0. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and license scope.
