# oh-my-goals

A native MeTTa decision gate for coding agents.

oh-my-goals ranks proposed actions against explicit goals, policy norms, and graded evidence before an agent acts. It returns an auditable decision receipt and leaves execution with the caller.

For a verified change and a policy-forbidden unverified alternative, selected receipt fields are:

```json
{
  "selected": "apply-verified-change",
  "status": "recommended",
  "selection_tied": false,
  "automatic_execution_allowed": true
}
```

## What it is

The policy and ranking rules live in [`metta/oh-my-goals.metta`](metta/oh-my-goals.metta). MeTTa is a symbolic programming language, and [MeTTa TS 1.1.4](https://github.com/MesTTo/MeTTa-TS) runs those rules inside the TypeScript host. TypeScript validates strict JSON, encodes and decodes atoms, handles files and processes, connects the optional Prolog checks, and dispatches only caller-owned action handlers. See [ARCHITECTURE.md](ARCHITECTURE.md) for the exact runtime boundary.

## Why

An agent's preferred action is a proposal, not authority to act. oh-my-goals records the declared goals, applicable norms, evidence calibration, score, tie state, and execution eligibility before an action handler can run.

## Quickstart

Node.js 20 or newer is required. The package is not yet published to npm, so run it from a source checkout:

```bash
git clone https://github.com/MesTTo/oh-my-goals.git
cd oh-my-goals
npm ci
npm run build
node dist/cli.js --help
```

The JavaScript entry point is ESM-only. CommonJS callers must use dynamic `import()`. SWI-Prolog is optional and starts only through the explicit Prolog API or `prolog-check` command.

To install the current checkout into another project, pack the verified source:

```bash
cd /path/to/oh-my-goals
npm ci
npm run verify
mkdir -p ai-tmp
npm pack --pack-destination ai-tmp

cd /path/to/consumer-project
npm install /path/to/oh-my-goals/ai-tmp/oh-my-goals-0.1.0.tgz
npx --no-install oh-my-goals --help
```

## Highlights

- MeTTa owns norm resolution, goal analysis, scoring, status assignment, stable ranking, tie handling, motivation consensus, and the selected PLN and SNARS formulas.
- A recommendation is not execution authority. Ties, forbidden actions, conflicts, missing required goals, and unavailable handlers block automatic execution.
- The same Agent Skill protocol works with Claude Code, Codex, and OpenCode. The framework does not call hosted models or read their authentication state.
- Boundary tests cover 5,000 goals, 1,000 ranked actions, and 1,000 motivation candidates across native and large-input paths.
- Optional SWI-Prolog checks compare only the named score and directive relations.

## Decide from JSON

The [complete input schema](skills/oh-my-goals/references/input-schema.md) lists every field and default. CLI input is limited to 2 MiB.

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
npx --no-install oh-my-goals decide --input scenario.json --pretty
```

Use `--input -` to read JSON from stdin. Unknown fields, duplicate IDs, invalid probabilities, and dangling goal or action references are rejected with exit code 2. A valid decision writes JSON to stdout. Runtime failures use exit code 1.

The receipt identifies the selected action and includes the complete scenario declaration plus every ranked decision. The declaration retains goals, norms, actions, and notes so the score can be audited after a temporary input is removed. Decision scores retain full precision so threshold statuses can be replayed. `selection_tied`, `tied_actions`, and `automatic_execution_allowed` prevent an input-order tie from becoming an automatic action. The motivation audit retains the effective correlations, risks, subsystem vectors, and consensus scores. Each decision row contains its score, deontic status and reasons, satisfied goals, missing required goals, evidence projection, warnings, and provenance metadata. `forbidden` and `conflict` results are always blocked.

The motivation path computes `0.54 * normalized_motivation + 0.38 * strength * confidence`, plus `0.1` for an obligation. Motivation uses `1` and `0` subsystem membership masks for individual and collective goals. Goal weights affect coverage scoring, not the motivation consensus vectors. Consensus values use min-max normalization across the candidates. Equal values normalize to `1`. When motivation is disabled, the score is `0.42 * goal_coverage + 0.38 * strength * confidence + 0.12 * min(individual_coverage, collective_coverage)`, plus the same obligation bonus. Blocked decisions have score `-1`. Other decisions are `recommended` at score `0.72` or higher with no missing required goal, `candidate` at score `0.5` or higher, and `weak` below `0.5`.

Do not put credentials, tokens, private keys, or unredacted sensitive data in the input. The receipt repeats scenario text and evidence provenance on stdout.

## TypeScript API

```ts
import {
  GoalChainer,
  executeDecision,
  explainDecisions,
  goalChainerRunToJson,
} from "oh-my-goals";

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

`GoalChainer` validates unknown input at the boundary. `evaluateScenario` accepts a validated scenario and a custom evidence reasoner. `StaticEvidenceReasoner` reads explicit evidence and action defaults. `PlnEvidenceReasoner` projects beliefs from the package's selected native PLN deduction and revision relations. `ContextualQueryEvidenceReasoner` passes each action's `evidenceQuery` and `evidenceAtoms` to a caller-injected synchronous adapter. Nonempty `evidenceAtoms` require a nonempty `evidenceQuery`. The `decide` CLI and `runGoalChainer` use static evidence and reject nonempty contextual declarations instead of ignoring them.

Omitted evidence uses a neutral strength of `0.5` with confidence `0`. It cannot
produce a recommendation by itself. `executeDecision` enforces the blocked-action
boundary. Automatic callers should require `automaticExecutionAllowed`; a top-score
tie leaves it false even when each tied action is individually `recommended`.
Scores within `1e-12` are treated as tied so binary64 rounding cannot authorize an
arbitrary winner.

The lower-level API also exports:

- `resolveNorms` and `resolveNormsBatch` for priority-aware deontic resolution.
- `scoreActions` and `decideActions` for the native MeTTa score and status rules.
- `gradeBeliefs` for PLN deduction and count-space revision.
- `consensusDecision` for individual and collective goal reconciliation with caller-supplied correlations and risks.
- `assess` and `derive` for SNARS subjective-logic receipts.
- `createDirectivePlan` and `DirectiveLifecycle` for ordered task status, assignment, and instance-local atomic claims.
- `makeProposition` and `buildHyperbasePacket` for structured propositions and Semantic-Hypergraph facts.
- `loadColoreContext` for a caller-supplied COLORE adapter source and caller-declared projection specifications. No ontology data or preset projections are bundled.
- `decideActionsWithProlog`, `verifyScorePrologParity`, and `checkDirectivePrologParity` for explicit optional SWI-Prolog evaluation and comparison.
- `redactRecord`, `detectLeaks`, and `executeDecision` for caller-owned execution boundaries.

`loadColoreContext` reads a strict line-oriented adapter format, not arbitrary CLIF.
Each noncomment line must use one of these forms:

```metta
(colore module MODULE "SOURCE")
(colore pred MODULE PREDICATE ARITY)
(colore axiom MODULE AXIOM_ID KIND EXPRESSION)
(colore gloss MODULE AXIOM_ID "TEXT")
```

An unsupported record raises a syntax error with its line number. Convert a source
ontology into these records before loading it.

## Coding-agent integration

The package ships one [Agent Skills](https://agentskills.io/specification) definition for Claude Code, Codex, and OpenCode. The installer copies the same canonical skill into each tool's supported location.

```bash
npx --no-install oh-my-goals install-skill --agent codex --scope project
npx --no-install oh-my-goals install-skill --agent claude --scope project
npx --no-install oh-my-goals install-skill --agent opencode --scope project
```

Use `--agent all` to install the shared `.agents/skills` layout used by Codex and OpenCode plus the `.claude/skills` layout used by Claude Code. Use `--agent opencode` when you specifically want `.opencode/skills` instead. User installs target the corresponding directories under your home directory. Existing differing files or modes are never replaced unless you pass `--force`.

OpenCode also scans `.claude/skills`. In a project installed with `--agent all`,
OpenCode may log a duplicate-name warning for the two identical copies. Install
only the target you use when you want one discovery entry.

Earlier local skill installs used a `goalchainer` directory. The installer does not delete user-owned skill trees. Install `oh-my-goals`, check that the new skill is discovered, then remove the old directory if you no longer need it. The `goalchainer` and `goalchainer-ts` binaries remain compatibility aliases during this transition.

The skill tells the coding agent to derive structured input from the current task, keep goals, norms, and evidence calibration attributable to the user or repository, call the JSON CLI, and stop unless automatic execution is allowed. oh-my-goals does not call a hosted model or read the agent's authentication state.

## MeTTa and Prolog

The framework pins `@metta-ts/core`, `@metta-ts/edsl`, `@metta-ts/hyperon`, `@metta-ts/prolog`, and the `@metta-ts/node` development CLI to 1.1.4. The packaged [`oh-my-goals.metta`](metta/oh-my-goals.metta) module declares the policy and reasoning rules. Its native paths use the MeTTa TS stdlib operations `foldl-atom`, `map-atom`, `filter-atom`, `msort`, and `is-member`. The TypeScript host registers low-level operations for large compensated vector sums and dot products, normalization, mask and correlation mapping, candidate validation, structural tree construction, Python-compatible rounding, indexed PLN matching, and stack-safe evaluator batching.

MeTTa derives coverage from goal aggregates, derives every decision row, computes every motivation score and strict maximum, selects the consensus, and computes PLN deductions and revision. Grounded large-input paths mirror satisfied-goal membership and partitioning, mask and correlation mapping, stable descending-score ranking and epsilon ties, and PLN matching by action and predicate. MeTTa still decides automatic-execution eligibility. A raw-shape router returns a deferred native relation for bounded scalar-only motivation inputs and sends large, reducible, or malformed inputs to the motivation bridge. The bridge validates `[0,1]` membership masks, candidate dimensions, correlations, risks, and identities. Reducible scalar and identity terms must have exactly one normal form. A grounded kernel computes the two compensated dot products and builds a balanced pull tree. `gc-motivation-consensus-canonical` subtracts risk, applies the disagreement penalty, merges all five strict maxima, preserves declaration-order ties, and selects the consensus in MeTTa. The router and bridge do not compare scores or select winners.

SWI-Prolog remains an optional interoperability path. The package imports the relations in `assets/gc_score.pl` and `assets/gc_directive.pl` through `@metta-ts/prolog`, then compares them with the corresponding MeTTa score, decision-status, and directive-state relations:

```bash
npx --no-install oh-my-goals prolog-check --pretty
```

The command starts the local `swipl` executable, runs both checks, disposes the bridge, and exits nonzero if a relation differs. It checks only those named relations. Prolog is not the framework's primary evaluator and the command does not claim parity for every MeTTa relation.

ProbMeTTa is not ported or bundled. It targets PeTTa, which compiles MeTTa programs to SWI-Prolog. A caller can connect a separately managed PeTTa and ProbMeTTa process through `EvidenceReasoner` or `ContextualQueryEvidenceReasoner`, then return the resulting strength, confidence, source, and proof data. That adapter is optional and remains outside the native MeTTa TS rule module.

The framework ports the reusable relations exposed by this package. Its PLN code implements the selected deduction and count-space revision formulas. Its SNARS code implements opinion construction and two-premise deduction. The deontic and motivation modules implement the static policy and consensus slices used by the decision gate. These exports are not replacements for complete chaining, deontic logic, probabilistic logic, or NARS systems.

## Status

oh-my-goals is at version 0.1.0 and is not yet published to npm. `npm run verify` checks the MeTTa module, TypeScript API, CLI, packed tarball, and Agent Skill. The test suite runs the named Prolog parity checks when SWI-Prolog is installed.

The package implements the documented decision relations. It is not a general theorem prover, a complete planner, a probabilistic logic runtime, or a full NARS implementation.

## Development

```bash
npm ci
npx metta-ts --check metta/oh-my-goals.metta
npm test
npm run build
npm run test:package
```

`npm run test:package` cleans the build output, packs the npm tarball from copied live sources, installs it into an isolated consumer, and checks the public API, CLI, MeTTa module, Prolog assets, and Agent Skill.

## License

The package code and documentation are MIT licensed. See [LICENSE](LICENSE).
