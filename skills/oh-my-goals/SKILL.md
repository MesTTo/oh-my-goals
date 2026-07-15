---
name: oh-my-goals
description: Local MeTTa memory and reasoning for a coding agent. Use when a task is multi-step, consequential, constrained by user rules or repository policy, ambiguous, or likely to outlive the current context window. Store the material facts, goals, and constraints as short English propositions that survive across turns and MCP restarts, query them before you plan, and rank candidate actions against them before you act. Reach for it to hold a user constraint through context compaction, to choose between actions under a policy, or to keep a decision traceable to its evidence.
---

# Oh My Goals

Oh My Goals is a local memory and reasoning loop for a coding task. You talk to the
user normally. You translate the parts that matter into short English propositions,
store them with their real sources, and let MeTTa keep them, reason over them, and
rank actions before you act. The user never writes MeTTa, a JSON decision packet, or
a numeric score.

You reach the loop through six MCP tools: `remember`, `query`, `solve`, `revise`,
`forget`, and `explain`. English is parsed as data through a real Semantic
Hypergraph parser and stored as structured propositions with provenance, epistemic
kind, scope, and lifecycle. A recommendation from the loop is advice, never
authorization: you still need the user's approval and an available, unblocked action
before you act.

The same memory is a scientific literature assistant, reached through six more
tools: `find_papers`, `ingest_paper`, `add_claim`, `citations`, `review`, and
`check_retractions`. A paper is a source, so a claim drawn from a paper stays active
only while the paper is not retracted, and `review` reads corroboration and
contradiction across papers. See "Scientific literature" below.

## When to use it

Use Oh My Goals when a task is any of: multi-step, consequential, constrained by a
user rule or repository policy, ambiguous, or likely to outlive the current context
window. Spend the few tool calls when you must remember a constraint through context
compaction, decide between actions under a policy, or keep a decision traceable to
its evidence.

Skip it for a trivial edit with no constraints and no branching. Do not narrate the
loop to the user; just use it and report the outcome.

## The loop

1. Translate the material parts of the request into controlled-English propositions
   and `remember` them with their real sources. A user statement or a repository
   instruction carries authority; an agent belief is a hypothesis; a tool result is
   an observation. Store each candidate action as `Action <id> ...`.
2. `query` existing memory before you propose a plan, so you do not repeat earlier
   work or violate a standing constraint.
3. `solve` to rank the candidate actions against the stored goals, norms, and
   evidence. A recommendation is reported only for a clear, unblocked winner, never
   on a tie.
4. When a tool result changes the picture, `remember` it as an observation. If it
   settles a conflict, record the conclusion as a `derived-conclusion` with its
   premises, then `solve` again. A derived conclusion stays active only while its
   premises do, so retracting the evidence recomputes the decision.
5. Use `revise` to correct a proposition and `forget` to retract a disproved
   hypothesis. Ask the user when a missing policy choice would change the outcome.

## Controlled English

The parser accepts a documented subset of English, not free prose. Write
propositions that follow this contract:

- Write one asserted proposition per sentence.
- Use explicit entity names and stable identifiers.
- Avoid pronouns and vague references.
- Preserve code symbols, file names, tests, and commands exactly.
- Nested complements introduced by "that" are allowed.
- Separate observations, goals, norms, hypotheses, and conclusions.
- Do not state an agent hypothesis as an observed fact.
- Do not combine several independent claims with coordination.
- Attach source and scope through the MCP fields, not invented prose.

Nested propositions preserve attribution. These three are different claims and must
stay distinct:

```text
The user states that action deploy_preview is acceptable.
The agent hypothesizes that action deploy_preview is acceptable.
The test output supports the proposition that action deploy_preview is acceptable.
```

They must never collapse into the bare assertion `Action deploy_preview is
acceptable.` A statement joined by coordination ("upgrade the package and add an
adapter") is rejected; split it into two propositions. When `remember` rejects a
statement, it returns the reason and asks you to rewrite it more simply without
changing its meaning. Rewrite and retry; do not force it.

## Kinds and scopes

Every proposition has one epistemic `kind`. The kind controls how the proposition
may be used, so an agent hypothesis cannot silently become a user requirement:
`user-statement`, `repository-instruction`, `observation`, `goal`, `norm`, `action`,
`hypothesis`, `derived-conclusion`, `decision`.

Every proposition lives in one `scope`:

- `session`: temporary facts and hypotheses for one active task.
- `project`: repository-specific facts and decisions, keyed by the repository.
- `user`: stable preferences the user has explicitly promoted.
- `derived`: conclusions and their proof dependencies, computed from the visible
  scopes.

Project memory is isolated by repository. A question is never stored as an
assertion; an imperative is stored only with kind `goal`.

## Tools

### remember

Store one or more controlled-English propositions. Fields: `statements` (one
proposition per string), `scope`, `kind`, `source` (`type`, `reference`, optional
`strength` and `confidence` in `[0,1]`). The result reports, per statement, whether
it was stored, its id, normalized English, mood, and revision, or the rejection
reason and rewrite feedback.

```json
{
  "statements": ["The user requires that the public API remains compatible."],
  "scope": "project",
  "kind": "goal",
  "source": { "type": "user", "reference": "current request" }
}
```

To record a conclusion that follows from evidence, add `premises` (the ids it
follows from) with `kind: "derived-conclusion"` and a single statement. The
conclusion deactivates when any premise is retracted, so the world-knowledge
judgment lives in your explicit derivation, carried with a proof, not in the solver.

### query

Answer an English question over memory. Fields: `question`, optional `scope`,
optional `includeRelated`. The result keeps three classes distinct: an exact answer
(a structural match against an active proposition), a reasoned answer (the same
match against a derived conclusion carrying a proof), and related matches (semantic
neighbours, never a proof). An unsupported question form returns a precise
limitation and rewrite feedback rather than a wrong answer.

```json
{ "question": "Which action preserves the public API?", "scope": "project" }
```

### solve

Rank the candidate actions in memory against its goals, norms, and evidence. Field:
`scope`, optional `title`, optional `motivationScores`. The result ranks each action
with its status, norm status, satisfied and missing required goals, plus the blocked
and tied action ids and whether automatic execution is allowed. A recommendation is
reported only for a clear, unblocked winner. Treat a tie, a block, or a weak result
as a request for more evidence, another action, or a user decision.

### revise

Supersede a proposition with a corrected statement. Fields: `id`, `statement`,
`source`, optional `kind` and `scope` (default to the superseded proposition's),
optional `expectedRevision`. The earlier proposition becomes historical and
inactive; the replacement becomes active; conclusions that depended on the old one
are recomputed. A stale `expectedRevision` is rejected so two agents cannot silently
overwrite each other.

### forget

Retract or permanently purge exact propositions. Fields: `propositionIds`, `mode`
(`retract` or `purge`), optional `expectedRevision`, `reason`, `preview`.
Retraction makes a proposition inactive while keeping its history; purge removes it
and scrubs its text irrecoverably. Run a broad deletion as a `preview` first: it
lists the targets and the conclusions a removal would invalidate without changing
anything.

### explain

Explain a proposition through its active premises, rules, sources, and lifecycle
state. Field: `id`. It returns externalized reasons and proof artifacts, not model
reasoning.

## Scientific literature

Use these when the task is to read, track, or reason about scientific papers. They
share the memory loop's storage and lifecycle, so a paper is a source and its claims
follow the same activation rules.

- `find_papers` (`query`, optional `limit`, `scope`, `sources`) searches Semantic
  Scholar and OpenAlex, ranked across sources; results already in a scope are
  flagged so you do not re-ingest them.
- `ingest_paper` (`id` DOI or arXiv, `scope`, optional `extractClaims`) fetches,
  parses, and stores the work with its retraction status and citation edges. Set
  `extractClaims` to have the configured model read it into validated claims; each
  is parsed and checked before it is stored.
- `add_claim` (`statement`, `workId`, `locator`, `scope`) stores one
  controlled-English claim drawn from a work when no model is configured, or to add
  a claim the model missed. The locator is the section and quote it rests on.
- `citations` (`workId`, `direction` references or citedBy, optional `transitive`,
  `external`) walks the citation graph. Use it to find what a paper rests on or what
  builds on it.
- `review` (`question`, `scope`, optional `limit`) gathers the claims about a topic
  and returns structured evidence: statements several works corroborate, statements
  that are contradicted, each with its supporting and opposing works and a projected
  opinion. It returns evidence, not a verdict; you write the review.
- `check_retractions` (`scope`, optional `checkReferences`) re-checks every work
  against Crossref, invalidates the claims of a newly retracted or withdrawn work,
  and flags corrections. With `checkReferences` it also flags the retracted works
  you cite.

When you ingest a paper and add claims from it, a later retraction deactivates those
claims automatically. Do not assert a contradiction `review` only surfaced as a
candidate; report it as evidence for the user to judge.

## Guardrails

- A `solve` recommendation is advice, not authority. Never execute a tied, blocked,
  or under-evidenced action automatically. Execution needs the user's approval and
  an available, unblocked action.
- Preserve the user's authority. A user statement or repository instruction carries
  authority; your own belief is a hypothesis. Do not promote a hypothesis to a
  requirement, and do not convert a preference into an obligation.
- Store material tool evidence, not whole command logs. A passing command supports
  only the behavior it checks.
- Re-query and re-solve after goals, norms, evidence, or available actions change.
  Retract a session hypothesis when it is disproved.
- Removing a user statement or persistent project memory needs authority from the
  current user request. Permanent purge always needs an explicit user instruction.
  When authority is absent, return the preview and ask.
- Never store credentials, tokens, private keys, or unnecessary personal data. Use a
  redacted reference in `source` instead. Purge remains available if something
  sensitive is stored by mistake.
- Oh My Goals runs locally and does not read or copy the coding agent's
  authentication state.
