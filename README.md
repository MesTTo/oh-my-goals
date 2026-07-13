# oh-my-goals

**A local MeTTa memory and reasoning MCP for coding agents.**

You talk to a coding agent normally. Oh My Goals gives the agent a local memory: it
turns the material parts of the conversation into short English propositions, parses
them into Semantic Hypergraph structures through a real parser, and keeps them in a
MeTTa space that survives across turns and MCP restarts. The agent queries that
memory before it plans and ranks its candidate actions against the stored goals,
norms, and evidence before it acts.

The reasoning is written in [MeTTa](https://metta-lang.dev/docs/learn/) and runs
locally on [MeTTa TS](https://github.com/MesTTo/MeTTa-TS). Nobody writes MeTTa, a
JSON decision packet, or a numeric score: the agent authors controlled English and
the memory does the rest. The same package is an MCP server for Claude Code, Codex,
and OpenCode, a matching Agent Skill, and a TypeScript library.

> [!IMPORTANT]
> A recommendation from Oh My Goals is advice, not authorization. The agent must
> still enforce user approval, handler availability, and any operating-system
> security controls before it acts.

## The memory loop

A coding agent reaches the loop through six MCP tools:

| Tool | What it does |
| --- | --- |
| `remember` | Store controlled-English propositions (facts, goals, norms, actions) with their real sources, or a proof-backed derived conclusion. |
| `query` | Answer an English question over memory, keeping exact, reasoned, and semantically related results distinct. |
| `solve` | Rank the stored candidate actions against the goals, norms, and evidence, reporting a recommendation only for a clear, unblocked winner. |
| `revise` | Supersede a proposition with a correction. |
| `forget` | Retract or permanently purge exact propositions. |
| `explain` | Read a proposition back to its premises, sources, and lifecycle. |

From a built checkout, register the server and install the Agent Skill for your
agent in one step:

```bash
node dist/cli.js install --agent claude --scope project
```

That merges the MCP server into the agent's config and installs the skill that
teaches the agent when to use it. The [Agent Skill](skills/oh-my-goals/SKILL.md)
describes the loop and the controlled-English contract; the
[MCP tool reference](skills/oh-my-goals/references/input-schema.md) lists every
field. Memory scopes, lifecycle, persistence, semantic retrieval, and the HyperBase,
MeTTa, and MCP boundaries are documented in [ARCHITECTURE.md](ARCHITECTURE.md).

The parser is the local mettabase AlphaBeta parser, reached through a replaceable
adapter. Set `OH_MY_GOALS_METTABASE_DIR` and `OH_MY_GOALS_HYPERBASE_PYTHON` so the
server can parse English; `install` and `install-mcp` carry those settings into the
registered server when they are present in your environment.

## A decision in one minute

Underneath `solve` is a decision core you can also call directly with a complete JSON
scenario. Suppose a coding agent can apply a verified change or apply the same change
before verification.

| Candidate action | Required goal | Explicit rule | Evidence | Result |
| --- | --- | --- | --- | --- |
| Apply the verified change | Satisfied | None blocks it | 9 of 10 checks passed, with 95% coverage | Recommended |
| Apply the unverified change | Missing | Forbidden until verification passes | No calibrated evidence | Blocked |

The abridged receipt is:

```json
{
  "selected": "apply-verified",
  "status": "recommended",
  "selection_tied": false,
  "automatic_execution_allowed": true,
  "decisions": [
    {
      "action_id": "apply-verified",
      "score": 0.8649,
      "status": "recommended",
      "norm_status": "unregulated",
      "missing_required_goals": []
    },
    {
      "action_id": "apply-unverified",
      "score": -1,
      "status": "blocked",
      "norm_status": "forbidden",
      "norm_reasons": [
        "forbid:No passing verification result"
      ],
      "missing_required_goals": [
        "safe-change"
      ]
    }
  ]
}
```

The verified action wins because it satisfies the required goal and has
attributable evidence. The other action is blocked by an explicit norm rather
than merely receiving a lower score. The receipt preserves both outcomes so the
choice can be reviewed later.

## Why use it

A model can propose an action, but the proposal does not carry your goals,
policies, or authority. A plain allow-or-deny check also cannot answer every
choice. You may need to compare several permitted actions, account for required
outcomes, weigh evidence of different quality, and refuse to break a tie
silently.

Oh My Goals makes those inputs explicit and gives the caller one replayable
result:

- priority-aware obligations, permissions, and prohibitions;
- weighted required and optional goals;
- evidence with separate strength, confidence, and source;
- ranked candidate actions with reasons and missing goals;
- explicit tie detection and automatic-execution eligibility;
- the complete scenario declaration needed to audit the result.

## Quickstart

Node.js 22.13.0 or newer is required. The package is currently installed from a
checkout because version 0.1.0 is not yet published to npm.

```bash
git clone https://github.com/MesTTo/oh-my-goals.git
cd oh-my-goals
npm ci
npm run build
```

Save this as `scenario.json`:

```json
{
  "scenario": {
    "title": "Apply a change?",
    "goals": [
      {
        "id": "safe-change",
        "owner": "maintainers",
        "statement": "Ship only a verified change",
        "weight": 1,
        "kind": "collective",
        "required": true
      }
    ],
    "norms": [
      {
        "id": "require-verification",
        "mode": "forbid",
        "targetAction": "apply-unverified",
        "reason": "No passing verification result",
        "priority": 10
      }
    ],
    "actions": [
      {
        "id": "apply-verified",
        "label": "Apply the verified change",
        "description": "Apply after the required checks pass",
        "satisfies": ["safe-change"]
      },
      {
        "id": "apply-unverified",
        "label": "Apply the unverified change",
        "description": "Apply before the required checks pass",
        "satisfies": []
      }
    ]
  },
  "evidence": {
    "apply-verified": {
      "strength": 0.9,
      "confidence": 0.95,
      "source": "9 of 10 required checks passed with 95% check coverage"
    }
  }
}
```

Run the decision:

```bash
node dist/cli.js decide --input scenario.json --pretty
```

The command prints the complete version of the receipt shown above. Use
`--input -` to read JSON from stdin. Invalid input exits with code 2. Runtime
failures exit with code 1.

The [input reference](skills/oh-my-goals/references/input-schema.md) lists every
field and default. Input is limited to 2 MiB.

### Install the packed library into another project

Build and verify a tarball from the checkout:

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

The JavaScript entry point is ESM-only. CommonJS callers must use dynamic
`import()`.

## What you provide

| Input | Meaning |
| --- | --- |
| Actions | The choices that are actually available. Each action declares which goals it satisfies. |
| Goals | Outcomes an action should advance. Goals can be weighted, required, and marked as individual or collective. |
| Norms | Explicit rules that oblige, permit, or forbid an action. Higher-priority rules defeat lower-priority conflicts. |
| Evidence | Support for an action as a strength, a confidence value, and an attributable source. |

Oh My Goals does not invent any of these values. If a policy choice would change
the result, the caller must obtain that choice from the user or another
authoritative source.

### Strength and confidence are different

`strength` measures how strongly the evidence supports the action.
`confidence` measures the reliability or coverage of that estimate. A passing
test supports only the behavior that test checks. It does not justify confidence
about unrelated behavior.

When evidence is omitted, the action receives a neutral strength of `0.5` with
confidence `0`. That prior cannot produce a recommendation by itself.

## How to read the receipt

| Field | What it tells you |
| --- | --- |
| `selected` | The highest-ranked action after norms, goals, motivation, and evidence are evaluated. |
| `status` | The selected action's status: `recommended`, `candidate`, `weak`, or `blocked`. |
| `decisions[].score` | The exact score used for stable ranking. Blocked decisions use `-1`. |
| `norm_status` and `norm_reasons` | Whether the action is unregulated, permitted, obligated, forbidden, or in conflict, plus the rules that caused it. |
| `missing_required_goals` | Required outcomes the action does not satisfy. |
| `selection_tied` and `tied_actions` | Whether more than one action shares the top score within the tie tolerance. |
| `automatic_execution_allowed` | Whether the reasoning result is recommended and untied. It is not user authorization. |
| `scenario_declaration` | The normalized goals, norms, actions, and notes needed to replay the decision. |

Even when `automatic_execution_allowed` is true, an automatic caller should
also confirm that the selected handler exists and that the user has already
authorized the action.

## How it works

```text
caller-owned actions + goals + norms + evidence
                        |
                        v
        TypeScript validation and atom encoding
                        |
                        v
             native MeTTa decision rules
        norms -> goals -> scores -> ranking -> ties
                        |
                        v
            decoded, auditable JSON receipt
                        |
                        v
     caller checks authorization and handler availability
                        |
                        v
              optional caller-owned execution
```

The main rule module is
[`metta/oh-my-goals.metta`](metta/oh-my-goals.metta). MeTTa owns norm
resolution, goal analysis, scoring, status assignment, stable ranking, tie
handling, motivation consensus, automatic-execution eligibility, and the
selected PLN and SNARS formulas.

TypeScript owns the runtime boundary. It validates input, encodes and decodes
atoms, manages files and optional processes, and dispatches caller-provided
action handlers. Large collections use bounded grounded operations for specific
numeric and structural work, while MeTTa still makes the decision. The exact
boundary is documented in [ARCHITECTURE.md](ARCHITECTURE.md).

## Use it with coding agents

An agent reaches Oh My Goals two ways, and the CLI sets up both. The MCP server makes
the tools reachable; the [Agent Skill](https://agentskills.io/specification) teaches
Claude Code, Codex, and OpenCode when and how to use them.

```bash
node dist/cli.js install --agent all --scope project
```

The `install` command registers the MCP server in the agent's config and installs
the matching skill. `install-mcp` and `install-skill` do each step alone, and
`install-mcp --remove` deregisters the server. Registration keeps three config
formats and merges into an existing config without disturbing the user's other
servers: Claude Code's `.mcp.json`, Codex's `.codex/config.toml`, and OpenCode's
`opencode.json`. The registered server launches this same CLI, so the exact installed
version runs.

`--agent all` sets up the shared `.agents` layout used by Codex and the `.claude`
layout used by Claude Code; use `--agent opencode` for OpenCode. Use `--scope user`
for the corresponding directories under your home directory. Existing differing skill
files are preserved unless you pass `--force`.

Once installed, a request can be as direct as:

> Remember that preserving the public API is required and that applying an unverified
> change is forbidden, then compare applying the verified change against gathering
> more evidence.

The agent stores the task's goals, norms, and candidate actions as controlled English
through `remember`, ranks them with `solve`, and reads memory back with `query` and
`explain`. Oh My Goals does not call a hosted model, read agent credentials, or gain
permission to execute an action.

<details>
<summary>Upgrading from the former local skill name</summary>

Earlier local installs used a `goalchainer` directory. The installer does not
delete user-owned skill trees. Install `oh-my-goals`, confirm that the new skill
is discovered, then remove the old directory if you no longer need it. The
`goalchainer` and `goalchainer-ts` binaries remain compatibility aliases
during this transition.

</details>

## TypeScript API

```ts
import { readFile } from "node:fs/promises";
import {
  GoalChainer,
  explainDecisions,
  goalChainerRunToJson,
} from "oh-my-goals";

const input = JSON.parse(await readFile("scenario.json", "utf8"));
const chainer = new GoalChainer();
const run = chainer.evaluate(input);

console.log(goalChainerRunToJson(run));
console.log(explainDecisions(run.decisions).join("\n"));

if (!run.automaticExecutionAllowed) {
  process.exitCode = 2;
}
```

`GoalChainer` rejects unknown fields, duplicate IDs, invalid probabilities,
and dangling goal or action references. `executeDecision` refuses blocked
decisions and requires a matching caller-owned handler.

After the caller separately confirms user authorization and handler
availability, it can call `executeDecision(run.selected, context, handlers)`.
That call does not infer or grant authorization.

The CLI and `runGoalChainer` use static evidence. Applications that need
queries against another reasoner can call `evaluateScenario` with a custom
`EvidenceReasoner`. `ContextualQueryEvidenceReasoner` passes each action's
`evidenceQuery` and `evidenceAtoms` to a caller-injected synchronous adapter.

## Decision behavior

### Norms

Norm modes are `oblige`, `permit`, and `forbid`. The highest-priority
applicable norms decide the effective status. Opposing top-priority norms
produce `conflict` instead of an arbitrary winner. Forbidden and conflicting
actions are blocked.

### Goals

Goal weights determine coverage. A required goal can prevent an otherwise
high-scoring action from becoming `recommended`. Individual and collective
goal membership also feeds the optional motivation consensus path.

### Statuses and ties

| Status | Meaning |
| --- | --- |
| `recommended` | Score is at least `0.72`, the action is not blocked, and no required goal is missing. |
| `candidate` | Score is at least `0.5`, but the recommendation conditions are not all met. |
| `weak` | Score is below `0.5` and the action is not blocked. |
| `blocked` | A prohibition or unresolved norm conflict prevents selection for execution. |

Scores within `1e-12` are treated as tied. The declaration order remains
stable, but `automatic_execution_allowed` is false so input order cannot
silently authorize one of the tied actions.

<details>
<summary>Exact default scoring model</summary>

With motivation enabled, the score is:

```text
0.54 * normalized_motivation
+ 0.38 * strength * confidence
+ 0.10 when the action is obligated
```

Motivation uses individual and collective goal membership masks plus
caller-supplied correlations and risks. Goal weights affect coverage, while
membership feeds motivation. Consensus values are min-max normalized. Equal
values normalize to `1`.

With motivation disabled, the score is:

```text
0.42 * goal_coverage
+ 0.38 * strength * confidence
+ 0.12 * min(individual_coverage, collective_coverage)
+ 0.10 when the action is obligated
```

Blocked decisions use score `-1`.

</details>

## Library surfaces

| Area | Public entry points |
| --- | --- |
| Complete decision gate | `GoalChainer`, `runGoalChainer`, `evaluateScenario` |
| Norm resolution | `resolveNorms`, `resolveNormsBatch` |
| Scoring and ranking | `scoreActions`, `decideActions` |
| Evidence and PLN | `StaticEvidenceReasoner`, `PlnEvidenceReasoner`, `ContextualQueryEvidenceReasoner`, `gradeBeliefs` |
| Motivation | `consensusDecision` |
| SNARS opinions | `assess`, `derive` |
| Task directives | `createDirectivePlan`, `DirectiveLifecycle` |
| Memory and HyperBase ingestion | `createMemorySpace`, `createHyperbaseParser`, `ingestStatements` |
| Optional Prolog comparison | `decideActionsWithProlog`, `verifyScorePrologParity`, `checkDirectivePrologParity` |
| Caller safety helpers | `redactRecord`, `detectLeaks`, `executeDecision` |

## MeTTa and optional interop

The framework pins the MeTTa TS runtime packages to version 1.1.4. The native
paths use standard-library operations such as `foldl-atom`, `map-atom`,
`filter-atom`, `msort`, and `is-member`. Bounded host operations cover
large compensated vector math, structural trees, stable ranking, and indexed PLN
matching. They do not compare candidate scores or select a winner outside
MeTTa.

SWI-Prolog is optional. The named score and directive relations can be compared
with their MeTTa counterparts:

```bash
node dist/cli.js prolog-check --pretty
```

The command starts the local `swipl` executable and exits nonzero if a checked
relation differs. It does not claim Prolog parity for every MeTTa relation.

ProbMeTTa is not ported or bundled. A separately managed PeTTa and ProbMeTTa
process can be connected through an `EvidenceReasoner` or
`ContextualQueryEvidenceReasoner`, returning strength, confidence, source, and
proof data to this decision gate.

## Scope and limits

- Oh My Goals does not discover available actions or invent goals, norms, or
  evidence.
- It does not intercept shell commands, isolate processes, filter prompts, or
  replace operating-system permissions.
- It does not call Claude Code, Codex, OpenCode, or another hosted model. Agent
  authentication remains with the caller.
- It contains no built-in scenario data or action handlers.
- The JSON CLI accepts static evidence. Contextual evidence requires an injected
  TypeScript reasoner.
- Its PLN, SNARS, deontic, motivation, and directive exports are the documented
  decision relations, not complete replacements for a theorem prover, planner,
  probabilistic logic runtime, or NARS system.

Do not put credentials, private keys, tokens, or unredacted sensitive text in
the input. The receipt repeats the scenario and evidence provenance.

## Status and verification

Oh My Goals is at version 0.1.0 and is not yet published to npm.

`npm run verify` checks the native MeTTa module, TypeScript API, CLI, packed
tarball, optional named Prolog comparisons when SWI-Prolog is available, and the
Agent Skill. Package smoke tests install the tarball into an isolated consumer
and execute the packaged MeTTa source.

Boundary tests cover 5,000 goals, 1,000 ranked actions, 1,000 motivation
candidates, large PLN rule sets, malformed inputs, non-finite values, and stable
tie behavior.

## Development

```bash
npm ci
npm run check:metta
npm test
npm run build
npm run test:package
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for rule ownership, large-input
boundaries, evaluator isolation, optional interop, and verification scope.

## License

The package code and documentation are MIT licensed. See [LICENSE](LICENSE).
