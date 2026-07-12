# Oh My Goals implementation plan

## Product outcome

Oh My Goals will be a local MeTTa memory and reasoning MCP for coding agents.
The user talks normally to Claude Code, Codex, or OpenCode. The agent translates
material parts of the conversation and repository state into controlled English
propositions. HyperBase parses those propositions into Semantic Hypergraph
structures. MeTTa TS stores the structures, reasons over them, and answers
questions before the agent chooses an action.

The user does not write MeTTa, JSON decision packets, or numeric scores. The MCP
and its installed Agent Skill teach the coding agent when and how to use the
reasoning loop.

```text
user and coding agent
        |
        | controlled English propositions and questions
        v
Oh My Goals MCP server
        |
        +--> HyperBase parser adapter
        |        |
        |        v
        |    nested SH propositions
        |
        +--> task, project, and user MeTTa spaces
        |        |
        |        +--> goals and norms
        |        +--> observations and hypotheses
        |        +--> provenance and revisions
        |        +--> derived propositions and proofs
        |
        +--> exact, logical, and semantic query routing
        |
        +--> action comparison and explanation
        v
agent acts, gathers evidence, or asks the user
```

## Success criteria

The first release is complete when all of the following are true:

- A user can install one local MCP and one matching Agent Skill for Claude Code,
  Codex, or OpenCode.
- The user can describe a coding task in ordinary English.
- The agent can store controlled English propositions without manually writing
  MeTTa atoms.
- HyperBase parses flat and nested propositions into validated SH trees.
- The parsed propositions are stored in a live MeTTa TS space with scope,
  provenance, epistemic kind, and lifecycle state.
- Project and user memory survives MCP restarts.
- Natural-language questions can retrieve relevant propositions.
- Mettabase `semmatch` retrieves proposition sources, complete SH edges, nested
  subtrees, connectors, and arguments from the selected memory scopes.
- Supported interrogatives compile into symbolic MeTTa queries with variable
  bindings and proofs.
- Goal, norm, PLN, SNARS, and decision queries consume the stored proposition
  state instead of requiring a new complete decision packet for every call.
- An agent can correct, retract, and permanently purge propositions.
- Removing a proposition also removes or invalidates its semantic index entries,
  derived conclusions, cached answers, and persisted representations.
- A coding agent can complete a multi-turn repository task while retaining an
  earlier user constraint through context compaction and MCP restart.
- No public surface, documentation, or package artifact depends on COLORE,
  OmegaClaw, a hackathon demo, or agent authentication credentials.

## Scope

### Included

- A MeTTa-first proposition memory.
- Controlled English authoring instructions.
- Real HyperBase parsing through a replaceable adapter.
- Nested propositions and explicit attribution.
- Task, project, and user memory scopes.
- Exact structural queries, MeTTa inference, and semantic retrieval.
- Natural-language interrogative compilation for a documented subset of English.
- Goals, norms, graded evidence, PLN, SNARS, directives, ranking, ties, and
  explanations over memory state.
- MCP tools, MCP prompts and resources, and Agent Skill installation.
- Retraction, supersession, and permanent purge.
- Optional Prolog interoperability for named compatibility predicates.

### Excluded

- COLORE loading or COLORE-specific projection APIs.
- OmegaClaw runtime integration.
- Demo and hackathon assets.
- A hosted model or a second chat interface.
- Reading Claude Code, Codex, or OpenCode login credentials.
- Storing hidden chain-of-thought or complete conversation transcripts.
- Treating semantic similarity as a logical proof.
- Treating a recommendation as user authorization.
- A general unrestricted English theorem prover.
- A port of ProbMeTTa.

## User experience

### Starting a task

The installed skill reminds the coding agent to use Oh My Goals when a task is
multi-step, consequential, constrained, ambiguous, or likely to outlive the
current context window. The agent skips the reasoning loop for trivial edits.

For a request such as:

> Upgrade the database package. Preserve the public API. Do not modify
> authentication. Avoid another dependency if possible.

the agent writes propositions such as:

```text
The user requires that the public API remains compatible.
The user prohibits changes to the authentication module.
The user prefers that the implementation adds no dependency.
Action upgrade_database updates the database package directly.
Action add_adapter updates the database package and adds an adapter dependency.
```

The agent stores them with their actual sources. It then queries project memory
for earlier decisions, relevant repository instructions, and known constraints.

### Updating the task

Tool results become observations, not conclusions:

```text
The test auth_refresh fails after action upgrade_database.
The dependency graph shows that package database imports package authentication.
```

MeTTa may derive a conclusion with a proof:

```text
The failing authentication test supports the proposition that action
upgrade_database conflicts with the authentication constraint.
```

The agent reruns the decision query. It either proceeds, gathers more evidence,
or asks one focused question.

### Correcting memory

If the user says that an earlier constraint was wrong, the agent uses `revise`.
The previous proposition remains historical and becomes inactive. The replacement
becomes active. Derived conclusions depending on the old proposition are
recomputed.

### Removing memory

The agent uses `forget` with exact proposition IDs. Broad natural-language
deletion first runs as a query and preview so unrelated propositions are not
removed accidentally.

The user can request either logical retraction or permanent purge. The difference
must be visible in the tool result.

## Controlled English contract

The instruction layer uses the following contract:

```text
Write one asserted proposition per sentence.
Use explicit entity names and stable identifiers.
Avoid pronouns and vague references.
Preserve code symbols, file names, tests, and commands exactly.
Nested complements introduced by "that" are allowed.
Separate observations, goals, norms, hypotheses, and conclusions.
Do not state an agent hypothesis as an observed fact.
Do not combine several independent claims with coordination.
Attach source and scope through the MCP fields, not invented prose.
```

Nested propositions preserve attribution:

```text
The user states that action deploy_preview is acceptable.
The agent hypothesizes that action deploy_preview is acceptable.
The test output supports the proposition that action deploy_preview is acceptable.
```

These propositions must never collapse into the unqualified assertion:

```text
Action deploy_preview is acceptable.
```

The parser adapter returns a quality receipt. It rejects empty parses, malformed
trees, missing roots, unexplained text coverage, and unsupported ambiguity. A
structurally valid parse is not automatically treated as semantically faithful.
When the quality gate fails, the tool asks the agent to rewrite the proposition
more simply without changing its meaning.

## Proposition model

The canonical MeTTa representation will use stable proposition IDs and separate
facts for content, provenance, truth, lifecycle, and derivation.

An illustrative shape is:

```metta
(MemoryProposition prop-42 project observation
  "The test auth_refresh fails after action upgrade_database."
  <nested-sh-tree>)

(MemoryProvenance prop-42 tool "npm test" "tests/auth.test.ts")
(MemoryTruth prop-42 1.0 1.0)
(MemoryState prop-42 active 7)
(MemoryRecordedAt prop-42 "2026-07-13T00:00:00Z")

(MemoryDerivation prop-51 rule-auth-conflict (prop-42 prop-11))
(MemorySupports prop-42 prop-51)
(MemorySupersedes prop-60 prop-11)
```

The final constructors and field order must be specified and tested in MeTTa
before TypeScript persistence code is written.

### Epistemic kinds

Every proposition has one of these initial kinds:

- `user-statement`
- `repository-instruction`
- `observation`
- `goal`
- `norm`
- `action`
- `hypothesis`
- `derived-conclusion`
- `decision`

The kind controls how the proposition may be used. An agent hypothesis cannot
silently become a user requirement. A semantically retrieved proposition is a
candidate premise until exact matching or an explicit reasoning rule admits it.

### Scopes

- `session` contains temporary facts and hypotheses for one active task.
- `project` contains repository-specific facts and decisions.
- `user` contains stable preferences explicitly promoted by the user.
- `derived` contains conclusions and proof dependencies calculated from the
  visible scopes.

Scope is part of every query. Project memory is keyed by a canonical repository
identity. A project query cannot read another project's memory by default.

### Identity and deduplication

Each stored proposition receives an opaque stable ID. The store also calculates
a canonical structural fingerprint from the normalized SH tree, kind, and scope.
The fingerprint detects repeated assertions without treating different sources as
the same evidence.

Two sources may support the same proposition. Removing one source must not remove
the proposition when another active source still supports it.

## Memory lifecycle and removal

Removal is part of the reasoning model rather than a raw filesystem operation.

### Retraction

Retraction makes a proposition inactive while preserving its history and
provenance. Normal queries, decisions, and semantic retrieval exclude it.
Historical inspection can still show it.

Retraction must:

1. Mark the proposition or selected supporting assertion inactive.
2. Remove it from the live semantic retrieval set.
3. Identify derived conclusions whose proof depends on it.
4. Remove invalid proof paths.
5. Keep a derived conclusion active when another valid proof remains.
6. Invalidate affected decision and query caches.
7. return a receipt listing every changed proposition and proof.

### Supersession

Supersession is the normal correction path. It stores a replacement proposition,
links the replacement to the earlier proposition, retracts the earlier active
assertion, and recomputes dependants in one transaction.

The operation fails if the caller supplies a stale expected revision. This stops
two agents from silently overwriting each other's memory updates.

### Permanent purge

Permanent purge is used for secrets, personal data, legally required deletion,
or an explicit request to remove all retained content. It physically removes the
selected proposition and its source payload.

Purge must remove the proposition from:

- the live MeTTa space;
- the durable proposition store;
- provenance and source-text records;
- exact indexes;
- semantic and embedding indexes;
- cached query answers;
- snapshots and replay data;
- derived proof paths;
- exported diagnostics and temporary artifacts owned by Oh My Goals.

The storage design must support purge without leaving the original sentence in an
append-only journal. If journaling is used, purge rewrites and atomically replaces
the affected journal segment before reporting success. Database storage must run
the corresponding compaction operation when deleted pages could retain content.

The returned receipt may contain the removed IDs and counts. Persistent logs must
not retain purged text. Logging uses IDs and operation outcomes only.

### Derived facts after removal

Every derived proposition records its complete premise set and rule ID. Removal
walks the reverse dependency graph. A derived proposition remains active only
when at least one complete proof path still has active premises.

PLN and SNARS values must be recomputed when supporting evidence changes. Cached
scalar truth values cannot survive the removal of their evidence.

### Removal authority

- The agent may retract its own session hypotheses when they are disproved.
- Removing a user statement or persistent project memory requires authority from
  the current user request.
- Permanent purge always requires an explicit user instruction.
- The MCP returns `confirmation_required` instead of guessing when authority is
  absent.
- A preview mode lists matching proposition IDs, scopes, sources, and dependent
  conclusions without changing state.

## Live AtomSpace and durable storage

The MeTTa TS space is the live reasoning state. A durable store preserves memory
across MCP restarts and supports concurrent coding-agent clients.

The persistence layer requires:

- transactions for remember, revise, retract, and purge;
- optimistic revisions;
- reverse proof dependencies;
- project-scope isolation;
- crash-safe restart;
- concurrent readers and serialized writers;
- exact deletion and compaction;
- a rebuild path from durable records into MeTTa spaces and semantic indexes.

SQLite in WAL mode is the initial implementation target because several stdio MCP
processes may access the same local memory. Before adding the package, verify its
Node 20, Node 22, and Node 24 install behavior in a packed consumer. Keep the
store behind a narrow interface so a future MeTTa-native persistence backend can
replace it without changing MCP tools.

The database is not the reasoner. It stores proposition records and indexes. On
startup, active records are decoded into the appropriate MeTTa spaces. Every
mutation commits the durable transaction and updates the live space as one
recoverable operation.

## HyperBase adapter

The current `src/hyperbase.ts` builds a shallow binary SH tree from caller-supplied
subject, predicate, and object fields. It does not parse English and cannot be the
memory ingestion path.

Introduce a `HyperbaseParser` interface with:

```ts
interface HyperbaseParser {
  parse(statements: readonly string[]): Promise<HyperbaseParseBatch>;
}
```

The first implementation invokes the real local mettabase AlphaBeta parser and
returns complete nested typed SH trees, roots, subedges, speech-act mood, source
coverage, and parser diagnostics. TypeScript validates every returned atom before
adding it to MeTTa.

The adapter boundary owns Python process management and timeouts. MeTTa owns the
stored proposition semantics and later reasoning. The server reports a clear
installation error when the parser is unavailable. It does not silently replace
HyperBase with the current flat renderer.

Required parser fixtures include:

- a simple subject-predicate-object observation;
- a user requirement containing a nested `that` complement;
- a belief about another proposition;
- evidence supporting a nested conclusion;
- negation;
- an interrogative with `which`;
- a yes-or-no interrogative;
- an imperative that becomes a goal;
- ambiguous coordination that must be rejected or rewritten;
- code symbols, paths, and command names that must survive parsing.

## Natural-language query pipeline

`query` accepts an English question and returns a structured answer plus
supporting proposition IDs and proofs.

The query router uses these paths in order:

1. Parse the question with HyperBase.
2. Detect interrogative mood and question concepts such as `Ci`.
3. Compile supported question concepts into MeTTa variables.
4. Run exact structural matching over visible active spaces.
5. Run MeTTa inference when the requested relation is derivable.
6. Use semantic retrieval to find candidate premises when exact compilation is
   unavailable or incomplete.
7. Re-run symbolic reasoning over admitted candidates.
8. Return exact answers, inferred answers, and semantic matches as distinct
   result classes.

Semantic similarity never becomes a proof by itself. The response labels a
semantic-only result as `related`, not `entailed`.

An answer receipt contains:

```text
question
normalized query proposition
query mode used
variable bindings
answer propositions
proof paths
source propositions
truth or uncertainty values
unsupported or ambiguous parts
```

The first symbolic compiler target is the structurally explicit question:

```text
Which action preserves the public API?
```

The parsed `which action` concept becomes a constrained MeTTa variable. The query
matches active propositions whose predicate and object satisfy the parsed pattern.

## Mettabase `semmatch` integration

Reuse the existing mettabase `semmatch` design for natural-language retrieval.
Do not create a second incompatible vector-search vocabulary inside Oh My Goals.

The canonical MeTTa-facing operations are:

```metta
(mb-add-candidate $space $atom-id $text)
(semmatch $space $query $candidate $out)
(semmatch $space $query $candidate $out $opts)
(semmatch? $space $query $candidate)
(semmatch-score $space $query $candidate)
```

Oh My Goals ports those relations into its MeTTa TS module. It does not add a
PeTTa runtime dependency for semantic matching. TypeScript supplies the embedding
provider and vector index as grounded operations. MeTTa composes retrieved
candidates with active-memory, scope, type, polarity, and structural constraints.

### Candidate generation

Follow mettabase's `semantic_candidates_for_edge` decomposition. One stored root
proposition produces searchable candidates for:

- the original controlled English sentence;
- the complete typed SH edge;
- each nested subtree;
- each connector;
- each role-bearing argument.

Candidate IDs derive deterministically from the proposition ID:

```text
prop-42:source
prop-42:edge
prop-42:subtree:0
prop-42:connector:0
prop-42:arg:s:0
```

Each candidate retains its proposition ID, scope, unit type, edge ID, role,
polarity, epistemic kind, and raw typed MeTTa payload. A search result can always
map back to the canonical proposition and its provenance.

### Scope mapping

Map Oh My Goals memory scopes to distinct semantic space IDs:

```text
omg:user
omg:project:<repository-identity>
omg:session:<session-id>
```

A query searches only the requested space IDs. The vector payload filter is an
efficiency aid. MeTTa still checks authoritative scope and active-state facts
before admitting a candidate into reasoning.

### Retrieve, then verify

`semmatch` is a candidate generator and branch filter. The reasoning path is:

1. Retrieve the top semantic candidates for the natural-language question.
2. Map every candidate back to its canonical proposition.
3. Remove inactive, retracted, superseded, or out-of-scope propositions.
4. Check exact entities, roles, polarity, and proposition kind in MeTTa.
5. Run the applicable PLN, SNARS, goal, norm, or structural query.
6. Preserve the semantic score as retrieval evidence.
7. Report a proof only when the symbolic reasoning path establishes one.

Use mettabase's anchored corroboration pattern when deciding whether two
paraphrases support the same relation. Candidate statements must share the same
resolved entity anchor and compatible polarity before similarity can count as
corroboration. Similar wording with different subjects or objects is not
corroborating evidence.

### Embedding quality

Mettabase currently defaults to a deterministic token-hash embedding. It is a
useful offline test backend, but it is not sufficient for the public claim that
Oh My Goals understands paraphrased natural-language memory queries.

Define an embedding provider interface and verify at least one local contextual
embedding provider against a pinned retrieval fixture. Keep token-hash as the
deterministic test and degraded fallback. Report the active provider and model in
query receipts. Do not silently label token overlap as semantic understanding.

Threshold and `top-k` defaults require a measured retrieval evaluation over the
controlled English fixture corpus. User-visible answers must not depend on an
unexplained universal threshold.

### Semantic deletion

The current mettabase `VectorIndex` contract provides `upsert` and `search`, but
no per-candidate delete operation. Oh My Goals needs deletion before `forget` can
be correct.

Extend the ported index contract with an operation equivalent to:

```ts
delete(spaceId: string, atomIds: readonly string[]): Promise<void> | void;
```

Expose a grounded removal operation for the MeTTa lifecycle path. Retraction
removes all candidates derived from the inactive supporting assertion. Purge
removes every candidate derived from the proposition. The in-memory backend,
persistent backend, and any Qdrant adapter must implement identical deletion
semantics.

If an index cannot delete individual points, `forget` fails closed or rebuilds
the affected space before reporting success. It must not leave a forgotten
proposition retrievable until a later maintenance task.

## MeTTa and TypeScript ownership

MeTTa owns:

- proposition visibility and lifecycle predicates;
- active-source aggregation;
- supersession selection;
- exact structural query relations;
- query result classification;
- proof dependency validity;
- goals and required-goal coverage;
- norms and conflict resolution;
- PLN and SNARS formulas;
- motivation consensus;
- action evaluation, ranking, ties, and explanations;
- directive readiness derived from decisions.

TypeScript owns:

- MCP transport and schemas;
- Agent Skill installation;
- HyperBase process integration;
- timestamps, filesystem paths, and repository identity;
- persistence transactions and locking;
- semantic embedding and vector-index calls;
- validated atom encoding and result decoding;
- process lifecycle, cancellation, and timeouts;
- redaction and user-facing receipts.

Grounded TypeScript operations may implement bounded storage, indexing, and
numeric kernels. They must not contain competing goal, norm, truth, or ranking
semantics.

## MCP interface

The server uses the official TypeScript MCP SDK and exposes a small tool surface.

### `remember`

Stores one or more controlled English propositions.

```json
{
  "statements": ["The user requires that the public API remains compatible."],
  "scope": "project",
  "kind": "goal",
  "source": {
    "type": "user",
    "reference": "current request"
  }
}
```

The result contains proposition IDs, normalized English, SH trees, parse-quality
information, deduplication results, and the committed revision.

### `query`

Answers a natural-language question over selected scopes.

```json
{
  "question": "Which action preserves the public API?",
  "scopes": ["session", "project"],
  "mode": "hybrid"
}
```

Modes are `exact`, `reasoned`, `semantic`, and `hybrid`. The result keeps their
evidential meanings distinct.

### `solve`

Frames a nontrivial coding problem against stored goals, norms, observations, and
candidate actions. The agent supplies candidate actions in English when they are
not already present in memory. The result recommends, rejects, ties, or requests
more evidence and includes a proof-oriented explanation.

### `revise`

Supersedes a proposition with a corrected controlled English proposition. It
requires the earlier proposition ID and expected revision.

### `forget`

Retracts or permanently purges exact propositions.

```json
{
  "proposition_ids": ["prop-42"],
  "mode": "retract",
  "expected_revision": 7,
  "reason": "The user corrected the earlier requirement.",
  "preview": false
}
```

`mode` is `retract` or `purge`. The result lists invalidated proofs, recomputed
conclusions, removed index entries, affected decisions, and the new revision.

### `explain`

Explains a proposition, answer, or decision through active premises, rules,
sources, and uncertainty. It returns externalized reasons and proof artifacts,
not hidden model chain-of-thought.

### MCP prompts and resources

The server publishes:

- a problem-solving prompt that teaches the proposition loop;
- the controlled English contract;
- a resource describing the memory scopes and current project identity;
- a resource exposing the MeTTa proposition schema;
- a resource describing removal authority and purge behavior.

Agent support for MCP prompts and resources differs. The packaged Agent Skill
remains the portable instruction surface.

## Agent Skill behavior

The installed skill teaches the agent to:

1. Use Oh My Goals for nontrivial decisions and durable task state.
2. Translate material claims into controlled English before storing them.
3. Preserve exact user and repository wording when it carries authority.
4. Label hypotheses and observations correctly.
5. Query existing memory before proposing a plan that may repeat earlier work.
6. Store only material tool evidence, not whole command logs.
7. Re-query after goals, norms, evidence, or available actions change.
8. Ask the user when a conflict or missing policy choice changes the outcome.
9. Avoid executing tied, blocked, or under-evidenced actions automatically.
10. Retract disproved session hypotheses.
11. Use `revise` for corrections and `forget` only with the required authority.
12. Never store credentials, tokens, private keys, or unnecessary personal data.

The installer configures the MCP and skill for Claude Code, Codex, and OpenCode.
It remains reversible and does not modify any model account or authentication
state.

## COLORE removal

Remove the following as one atomic cleanup before the memory API is stabilized:

- `src/ontology.ts`;
- ontology exports from `src/index.ts`;
- `OntologyContext` parameters and `ontology_grounding` from HyperBase packets;
- `ontologyHint` fields that exist only for COLORE projection hints;
- COLORE fixtures and tests;
- README and architecture references to COLORE;
- package files and environment variables related to COLORE.

Generic domain rules remain possible through validated MeTTa modules and stored
rule propositions. No public API names a specific ontology repository.

## Delivery phases

Each phase lands as an atomic commit with its tests and documentation.

### Phase 1: Scope reset

- Add this plan to the repository.
- Remove COLORE and the obsolete ontology packet surface.
- Reframe package descriptions around agent memory and reasoning.
- Preserve the existing MeTTa decision and reasoning behavior while removing the
  unrelated surface.
- Record the new architecture boundary in `ARCHITECTURE.md`.

Exit criterion: build, current tests, package smoke, MeTTa checks, and duplication
checks pass without any COLORE reference in shipped files.

### Phase 2: MeTTa proposition and lifecycle schema

- Define proposition, provenance, source, truth, scope, revision, support,
  supersession, and derivation constructors in MeTTa.
- Implement active visibility, source aggregation, retraction, and supersession
  relations.
- Implement reverse proof invalidation semantics.
- Add direct MeTTa fixtures before adding persistence.

Exit criterion: MeTTa tests demonstrate active, retracted, superseded, and
multi-source propositions plus alternate-proof survival.

### Phase 3: Real HyperBase ingestion

- Add the async parser interface.
- Integrate the actual local AlphaBeta parser.
- Replace the shallow manual tree builder on the ingestion path.
- Validate typed SH output and parser coverage.
- Add controlled English rewrite feedback.

Exit criterion: nested attribution, negation, questions, imperatives, code terms,
and ambiguous-input handling pass against the real parser.

### Phase 4: Durable scoped memory

- Add the durable store interface and initial SQLite implementation.
- Create task, project, user, and derived scope loading.
- Add repository identity and revision control.
- Rebuild live MeTTa state after restart.
- Port the mettabase `semmatch` contract and HyperBase candidate decomposition.
- Add semantic index insertion, scoring, generation, and per-candidate deletion.
- Implement transactional remember, revise, retract, and purge.

Exit criterion: restart, concurrent-client, crash-recovery, scope-isolation, and
purge tests pass. Purged text cannot be recovered from normal database pages,
snapshots, indexes, logs, or rebuilt AtomSpaces.

### Phase 5: Natural-language query

- Parse English questions through HyperBase.
- Compile supported `Ci` question concepts into MeTTa variables.
- Add exact and inferred query paths.
- Compose `semmatch` generation with exact MeTTa scope, lifecycle, entity, role,
  polarity, and proposition-kind checks.
- Add anchored semantic corroboration for structurally compatible paraphrases.
- Evaluate and pin the contextual embedding provider, thresholds, and `top-k`.
- Return bindings, answers, sources, proofs, and result classification.

Exit criterion: documented question forms answer correctly, unsupported forms
return a precise limitation, and semantic similarity is never reported as proof.

### Phase 6: Memory-backed solving

- Project stored goals, norms, actions, and observations into the existing
  reasoning relations.
- Replace one-shot complete decision packets in the agent path with memory-backed
  queries.
- Recompute affected decisions after evidence or memory changes.
- Separate advice from automatic-execution eligibility.

Exit criterion: a multi-turn coding scenario changes its recommendation when a
test result is remembered, restores the earlier result when that evidence is
retracted, and blocks execution on a tie.

### Phase 7: MCP and instruction layer

- Add the official TypeScript MCP SDK.
- Implement `remember`, `query`, `solve`, `revise`, `forget`, and `explain`.
- Publish MCP prompts and resources.
- Update the Agent Skill and installer for all three coding agents.
- Add concise structured error results and cancellation.

Exit criterion: each agent discovers the same tools and completes the same
fixture task using its existing local authentication. The MCP never reads or
copies that authentication state.

### Phase 8: Release verification

- Pack and install the npm tarball into isolated consumers on supported Node
  versions.
- Verify the packaged MeTTa source, skill, MCP entry point, and parser check.
- Run end-to-end sessions in Claude Code, Codex, and OpenCode.
- Measure exact and hybrid query latency on a representative project memory.
- Fix public CI and publish a release only after all gates pass.

Exit criterion: installation, restart persistence, natural-language query,
problem solving, retraction, and purge work from the packed artifact.

## Test strategy

### Unit and contract tests

- MeTTa proposition constructors and visibility rules.
- Source aggregation and duplicate structural propositions.
- HyperBase adapter validation.
- Query compilation and variable binding.
- Persistence encoding and migrations.
- MCP schemas and structured errors.
- `semmatch` bound filtering, variable generation, scoring, options, and
  space isolation.
- HyperBase source, edge, subtree, connector, and argument candidate generation.
- Semantic-index deletion for every supported backend.

### Property-based lifecycle tests

Generate sequences of remember, revise, retract, restore, and purge operations.
After every operation, assert:

- active propositions have active supporting assertions;
- inactive propositions do not appear in normal queries;
- no derived proof references a missing active premise;
- alternate proof paths preserve a conclusion;
- revisions increase monotonically;
- scope boundaries remain intact;
- a restart produces the same active MeTTa state;
- purged text and atoms never reappear after rebuilding indexes.

### Parser tests

Test both structural validity and semantic fidelity. Human-reviewed fixtures pin
the expected root predicate, roles, nesting, polarity, mood, and question
concepts. `ParseResult.failed = false` alone is not acceptance evidence.

### Removal tests

- Retract one source while another source supports the same proposition.
- Retract the final source and invalidate the conclusion.
- Remove one premise from a two-premise proof.
- Preserve a conclusion with an alternate proof.
- Supersede a user requirement and recompute a decision.
- Purge a proposition containing a unique canary string.
- Confirm the canary is absent from the database, snapshots, logs, vector index,
  AtomSpace, query results, and a fresh restart.
- Confirm no `semmatch` candidate derived from the canary proposition remains.
- Race two revisions and reject the stale writer.
- Preview a broad deletion without mutating state.

### Agent acceptance scenarios

1. A long refactor retains the original API-compatibility requirement after
   context compaction.
2. A repository instruction conflicts with a proposed action and the agent asks
   instead of choosing around it.
3. A failed test becomes evidence, changes the selected action, and appears in
   the explanation.
4. A corrected user statement supersedes the old proposition.
5. A user asks the agent to forget a sensitive statement and purge verification
   proves that it is gone.
6. Claude Code stores a project proposition and Codex retrieves it through the
   same project memory without sharing either agent's credentials.

## Security and trust boundaries

- English is parsed as data. It is never evaluated as raw MeTTa source.
- Stored repository text cannot promote itself to a system instruction.
- Proposition kind and source remain separate from sentence content.
- Tool output is untrusted until validated and attributed.
- Project scope is resolved from an explicit root and canonical repository
  identity, not arbitrary text supplied inside a proposition.
- MCP logs omit proposition text by default.
- Secrets are rejected before persistence when detectors identify them.
- Purge remains available when prevention misses sensitive content.
- Exported explanations redact restricted source fields.
- The reasoning result does not grant filesystem, shell, network, or publishing
  authority.

## Documentation deliverables

- A README that begins with the normal coding-agent conversation.
- A five-minute installation and first-query path.
- A controlled English guide with accepted and rejected examples.
- An MCP tool reference.
- A memory scope and removal guide.
- A MeTTa proposition schema reference.
- An architecture document showing the HyperBase, MeTTa, persistence, semantic
  retrieval, MCP, and Agent Skill boundaries.
- A troubleshooting guide for parser availability, stale revisions, failed
  purges, unavailable semantic indexes, and unsupported question forms.

## Release gates

Before calling the memory MCP complete:

```text
npm run check:metta
npm test
npm run build
npm run test:package
npm run verify
jscpd
git diff --check
```

The release also requires packed-consumer MCP discovery, real HyperBase parser
fixtures, persistence restart tests, cross-process revision tests, and the purge
canary suite. A passing decision-engine test does not stand in for any of these
memory claims.
