# MCP tool reference

Oh My Goals exposes six tools over the Model Context Protocol. Each tool takes a
small typed argument object and returns text plus structured content. A bad argument
returns a tool error with the reason; a rejected statement returns rewrite feedback
and stores nothing.

Two enumerations recur:

- `scope`: `session`, `project`, `user`, or `derived`.
- `kind`: `user-statement`, `repository-instruction`, `observation`, `goal`, `norm`,
  `action`, `hypothesis`, `derived-conclusion`, or `decision`.

A `source` object attributes a claim: `type` (a category such as `user`,
`repository`, `tool`, or `agent`), `reference` (what the claim is attributed to, such
as a request or a command), and optional `strength` and `confidence` in `[0,1]`.

## remember

Store one or more controlled-English propositions.

```json
{
  "statements": ["The user requires that the public API remains compatible."],
  "scope": "project",
  "kind": "goal",
  "source": { "type": "user", "reference": "current request" }
}
```

- `statements`: array, one asserted proposition per string.
- `scope`, `kind`, `source`: as above.
- `premises` (optional): proposition ids this conclusion follows from. Requires
  `kind: "derived-conclusion"` and exactly one statement. The conclusion stays active
  only while every premise stays active.

The result lists, per statement, either `{ stored: true, id, normalizedEnglish,
kind, scope, mood, polarity, revision }` or `{ stored: false, reasons, feedback }`.

## query

Answer an English question over memory.

```json
{ "question": "Which action preserves the public API?", "scope": "project", "includeRelated": true }
```

- `question`: the English question.
- `scope` (optional): restrict to one scope; the default searches all active memory.
- `includeRelated` (optional): also list semantic neighbours beside exact answers.

The result separates `answers` (each classified `exact`, `reasoned`, or `related`),
`related` matches, `unsupported` limitation codes, the normalized query, bindings,
proof paths, and the active semantic provider and threshold. A `related` match is
never a proof.

## solve

Rank the candidate actions in memory against its goals, norms, and evidence.

```json
{ "scope": "project", "title": "Upgrade the database package" }
```

- `scope`: the scope to solve within.
- `title` (optional): a label for the decision.
- `motivationScores` (optional): per-action motivation, an object keyed by action id.

The result reports `recommended` (only for a clear, unblocked winner, else null),
`automaticExecutionAllowed`, `tiedActionIds`, `blockedActionIds`, the ranked
`decisions` (each with status, score, norm status, satisfied and missing required
goals, warnings), the `evidence` traces, and diagnostics.

## revise

Supersede a proposition with a corrected controlled-English statement.

```json
{
  "id": "prop-12",
  "statement": "The user requires that the public API stays source-compatible.",
  "source": { "type": "user", "reference": "clarification" },
  "expectedRevision": 3
}
```

- `id`: the proposition to correct.
- `statement`: the corrected proposition.
- `source`: as above.
- `kind`, `scope` (optional): default to the superseded proposition's.
- `expectedRevision` (optional): a stale value is rejected so two agents cannot
  overwrite each other.

The result reports the superseded and replacement propositions and the dependent
conclusions that were recomputed.

## forget

Retract or permanently purge exact propositions.

```json
{
  "propositionIds": ["prop-42"],
  "mode": "retract",
  "expectedRevision": 7,
  "reason": "The user corrected the earlier requirement.",
  "preview": false
}
```

- `propositionIds`: the ids to remove.
- `mode`: `retract` (inactive, history kept) or `purge` (removed and scrubbed).
- `expectedRevision` (optional): applied to each target; a stale revision is rejected.
- `reason` (optional): why the removal happened.
- `preview` (optional): when true, list the targets and the conclusions a removal
  would invalidate without changing any state.

## explain

Explain a proposition through its active premises, rules, sources, and lifecycle
state.

```json
{ "id": "prop-51" }
```

The result returns the proposition, its sources, its derivations with each premise's
active state, and whether it is currently active. These are externalized reasons and
proof artifacts, not model reasoning.

## Controlled English

Statements must follow the controlled-English contract so the parser can store them
faithfully. See [SKILL.md](../SKILL.md) for the contract and the loop. When a
statement is rejected, rewrite it more simply without changing its meaning and retry;
do not force a rejected statement into memory.
