# Architecture

Oh My Goals is a native MeTTa framework with a TypeScript host. The package runs on MeTTa TS 1.1.4.

[`metta/oh-my-goals.metta`](metta/oh-my-goals.metta) declares the semantic rules. Public TypeScript functions validate caller data, encode it as atoms, query that module, and decode the returned values. For large inputs, the module selects bounded grounded implementations of specific collection transforms and structural joins. Those mirrors are listed below.

The native paths use the MeTTa TS standard library directly. `foldl-atom` carries compensated sums and small PLN revision state, `map-atom` and `filter-atom` implement bounded collection transforms, `msort` orders decorated decision keys, and `is-member` performs structural identity checks. Large inputs switch to bounded grounded primitives when the standard recursive forms would copy large captured atoms or exceed the evaluator stack.

## Evaluation path

```text
caller data
    |
    v
TypeScript validation and atom encoding
    |
    v
metta/oh-my-goals.metta
    |
    v
TypeScript receipt decoding and caller-owned action dispatch
```

The caller supplies goals, norms, available actions, evidence, and any optional correlation or risk inputs. Oh My Goals does not infer policy from an agent account or authentication state.

The shared evaluator parses the packaged module and adds its definitions to a MeTTa space. Pure API calls reuse that rule space. Stateful directive lifecycles use isolated spaces so claims from one lifecycle cannot affect another.

## Rule ownership

The MeTTa module declares and routes the following decisions. Large-input mirrors implement the named collection steps under the TypeScript boundary below.

| Concern | Native relations | Result declared by the module |
| --- | --- | --- |
| Deontic policy | `gc-resolve-norm-tree`, `gc-merge-norm-status` | Highest-priority applicable norms, conflicts, reasons, and effective status |
| Goals and evidence | `gc-goal-analysis`, `gc-goal-scores`, `gc-evidence-expectation`, `gc-default-risk` | Coverage, missing required goals, omitted-expectation derivation, and default risk |
| Scoring and ranking | `gc-evaluate-action`, `gc-evaluate-action-analysis`, `gc-evaluate-and-rank`, `gc-rank-decisions`, `gc-automatic-execution-allowed` | Scores, statuses, stable order, ties, and automatic-execution eligibility |
| Motivation | `gc-motivation-mask`, `gc-motivation-candidate`, `gc-motivation-availability`, `gc-motivation-score-row`, `gc-motivation-aggregate`, `gc-motivation-consensus`, `gc-normalize-values-fast` | Membership masks, effective correlations and risks, subsystem preferences, consensus scores, selected consensus, and score normalization |
| PLN | `gc-pln-evaluate` and its deduction and revision relations | Deductions and count-space belief revision |
| SNARS | `gc-snars-assess`, `gc-snars-deduction` | Subjective opinions, expectations, and two-premise deductions |
| Directives | `gc-directive-task-state` and the `gc-directive-*` lifecycle relations | Task state, readiness, claimability, claims, and next assignments |

TypeScript checks the shape and vocabulary of the returned atoms before exposing them as public values. Those checks detect malformed or inconsistent evaluator output. The grounded mirrors implement only the collection steps documented below; the remaining host code does not choose a different outcome.

An explicit evidence expectation is caller-supplied evidence and remains unchanged. When the caller omits it, `gc-evidence-expectation` derives the default from strength and confidence.

For an action whose goal list or satisfied-goal list has more than 16 entries, the host first queries the bulk goal fold and `gc-goal-scores`. It then sends an `EvaluateAnalyzedRequest` to MeTTa. The request uses `AnalyzedAction` for the already-validated action identity and label. Its `GoalAnalysisSummary` contains the MeTTa-derived all, individual, and collective coverage scores plus the missing-required-goal count. MeTTa still merges the norm status, computes the action score, and derives the decision status from that summary. The host retains the original satisfied-goal IDs and the ordered missing-required-goal IDs for the receipt, requires MeTTa to return the analyzed-result markers, and verifies that the returned scores and count match the prior analysis.

## TypeScript boundary

TypeScript hosts runtime work and the bounded primitives required to keep large inputs finite and stack-safe:

- strict schema and model validation;
- atom construction, encoding, decoding, and evaluator setup;
- JSON, filesystem, CLI, and process handling;
- evidence adapters that call caller-managed systems;
- the SWI-Prolog adapter and bridge lifecycle;
- low-level bulk numeric grounded operations;
- receipt and explanation formatting;
- redaction, executor lookup, and caller-owned action dispatch.

The host registers these low-level validation, numeric, and vector operations:

- `gc-vector-sum-atom` computes a finite vector sum with Python 3.12-compatible compensated binary64 accumulation;
- `gc-vector-dot-atom` computes a finite dot product with the same accumulation order;
- `gc-goal-mask-atom` maps a large validated goal atom sequence to the kind selected by MeTTa;
- `gc-correlation-values-atom` maps a large validated sequence of explicit or default correlation specifications to numbers;
- `gc-pack-candidate-atom` packages an ID, MeTTa-derived correlation vector, and MeTTa-derived risk as one structural atom;
- `gc-motivation-inputs-simple-atom` inspects raw atom shape without reducing it. Bounded scalar-only inputs stay on the standalone native path. Reducible or malformed terms route to the canonical bridge. Its standalone MeTTa fallback returns `True` because no host bridge exists there;
- `gc-motivation-consensus-bridge-atom` validates and canonicalizes large or reducible direct consensus calls, then returns a deferred `gc-motivation-consensus-canonical` expression for the outer evaluator;
- `gc-motivation-pull-tree-atom` validates canonical vectors and candidates, computes only the two compensated dot products for each candidate, preserves the ID and risk atoms, and builds a balanced pull tree;
- the host registration for `gc-motivation-consensus` is a structural routing wrapper. It returns a deferred `gc-motivation-consensus-expressions` call for bounded scalar-only inputs and delegates large, reducible, or malformed inputs to `gc-motivation-consensus-bridge-atom`. The standalone module uses the public MeTTa equation directly;
- `gc-round-number-atom` applies Python-compatible decimal rounding to a binary64 value;
- `gc-affine-normalize-atom` applies affine normalization to a vector.

Large structural inputs use these additional grounded operations:

- `gc-goal-fold-atom` validates goal atoms, accumulates total and covered weights, and retains ordered missing-required-goal IDs. `gc-goal-scores` converts those aggregates into coverage scores in MeTTa;
- `gc-rank-decision-rows-atom` validates and stably orders large `DecisionRow` sequences. It vectorizes the same `gc-score-tied` absolute-epsilon predicate used by the bounded native path and returns the equivalent leading action IDs. MeTTa derives each row and decides automatic-execution eligibility;
- `gc-motivation-consensus-bridge-atom` validates membership-mask values in `[0,1]`, candidate correlations in `[-1,1]`, risks in `[0,1]`, dimensions, and identities. Reducible scalar and identity terms must have exactly one normal form. The bridge rebuilds candidates from those normal forms and defers evaluation. `gc-motivation-pull-tree-atom` computes the generic dot-product kernel and tree shape. `gc-motivation-consensus-canonical` subtracts risk, applies the disagreement penalty, merges all five strict maxima, preserves declaration-order ties, and selects the final consensus in MeTTa. `gc-motivation-score-tree-atom` remains the structural input path for the public `gc-motivation-aggregate` relation;
- `gc-flatten-motivation-consensus-tree-atom` flattens the MeTTa-produced consensus-score tree without comparing scores or selecting an action;
- `gc-pln-match-tree-atom` indexes validated PLN facts by action and predicate, preserves rule and fact order, and builds a balanced tree of matching pairs. MeTTa computes each deduction and performs count-space revision.

The grounded operations contain no scoring constants, status thresholds, risk subtraction, disagreement penalty, motivation preference or consensus rules, or PLN deduction and revision formulas. The motivation routing operations inspect raw shape, size, and validation state. The pull-tree operation is a compensated dot-product and structural kernel. The remaining grounded operations mirror these large-input collection semantics from the bounded MeTTa path:

- satisfied-goal membership, individual and collective partitioning, and ordered required-goal omission;
- individual and collective membership masks plus explicit or default correlation mapping;
- descending-score ranking with declaration-order stability and absolute-epsilon tie selection;
- PLN applicability matching by target action and predicate, preserving rule and fact order.

They also execute generic numeric kernels and structural transforms, including affine normalization with parameters derived by MeTTa. Boundary tests compare the native and grounded paths at each dispatch threshold. MeTTa derives every decision row, computes coverage from the grounded goal aggregates, derives risk and normalization parameters, computes motivation scores and winners, computes PLN deductions and revision from the grounded match set, and decides every status and automatic-execution conclusion.

Execution remains outside the reasoning module. A `recommended` result is not authority to perform an action. `executeDecision` requires a caller-supplied action map and rejects blocked decisions. Automatic callers must also check `automaticExecutionAllowed`, the tie state, action availability, and the authority already granted by the user.

## Memory

Memory stores controlled-English propositions with provenance, lifecycle, and derivation. Visibility, active-source aggregation, retraction, supersession, and reverse proof invalidation are decided by the `gc-mem-*` relations in `oh-my-goals.metta`. A proposition is active when its state is active, it has an active supporting assertion or a valid proof, and it is not superseded.

Statements enter through the real HyperBase parser (`src/hyperbase.ts`), which returns nested typed SH trees, roots, speech-act mood, and coverage. Ingestion stores a statement only when it parses into one faithful proposition whose mood suits its kind: a question is never an assertion, and an imperative is stored only as a goal. Rejections return controlled-English rewrite feedback and write nothing.

The MeTTa space is the live reasoning state; a durable store keeps it across restarts. `MemorySpace` (`src/memory.ts`) validates caller data, writes ground facts, reads visibility back, and writes every mutation through to the store in one transaction. `DurableStore` (`src/durable_store.ts`) has a SQLite WAL implementation, so several stdio MCP processes can share one local memory with concurrent readers and a serialized writer, and an in-memory implementation for tests. On construction the space loads the records in scope and rebuilds the live facts from them; generated ids continue past the highest stored id, and a caller-supplied id that already exists is rejected.

Scope isolation follows the identity a space opens with. User memory is global; project and derived memory belong to a repository; session memory belongs to one session in one repository. `retract` and `supersede` preserve history and report the dependent conclusions they invalidate. `purge` is the permanent form: it deletes the record, removes the live facts, and, with SQLite `secure_delete` and a WAL checkpoint, scrubs the content so it cannot be recovered from the database, its journal, or a rebuilt space.

Natural-language retrieval ports mettabase's `semmatch`. One proposition decomposes into searchable candidates for its sentence, its typed edge, each subtree, connector, and role-bearing argument (`src/candidates.ts`), each embedded and kept in a per-scope vector index (`src/vector_index.ts`, `src/embedding.ts`). Because embedding is asynchronous while the record space is synchronous, `SemanticMemory` (`src/semantic_memory.ts`) is the async facade: it reconciles the index against the active set after every mutation, drops candidates for a proposition that becomes inactive or is purged, and rebuilds the index from the stored SH trees on open, so search survives a restart without re-running the parser. A search returns candidates whose canonical proposition is still active and in scope, keeping each proposition's best-scoring candidate. Semantic similarity is retrieval evidence, not a proof.

Two embedding providers sit behind one interface. The default is a deterministic token-hash bag of tokens (`TokenEmbeddingProvider`): offline, dependency-free, and stable, but blind to paraphrase. The opt-in contextual provider (`TransformersEmbeddingProvider`) runs `bge-small-en-v1.5` locally through transformers.js, an optional peer dependency loaded by dynamic import so the base install carries none of its weight. Its 384-dim vectors match the mettabase PyTorch BGE reference to about `1e-7`. Each provider carries the query threshold measured for its score scale over a controlled-English retrieval fixture: BGE at 0.65, where recall stays high while false matches fall away, and token-hash at none, because its relevant and unrelated scores overlap. The active provider, model, and threshold are reported in the semantic config so a fallback is never presented as contextual understanding. The contextual provider fails closed to token-hash when its dependency or model is absent.

`queryMemory` (`src/query.ts`) answers an English question over memory. A supported question compiles to a one-slot structural pattern: "Which action preserves the public API?" parses to a relation whose questioned argument is a free slot and whose relation, roles, and remaining entities are fixed, so it matches the declarative "The verified change preserves the public API." and binds the slot. Answers come in three classes the receipt keeps distinct. An exact answer is a structural match against an active proposition. A reasoned answer is the same structural match against a derived conclusion that carries a stored proof. A related match is semantic retrieval, and it is never reported as a proof. Question forms that do not compile, an object question that needs do-support or a statement submitted as a question, return a precise limitation code and controlled-English rewrite feedback rather than a wrong answer.

The semantic hits are anchored with the exact checks mettabase's `matchx` runs beside `semmatch`. Each related match reports which of the question's fixed entities it asserts in the same argument role, along with its own polarity and kind. A proposition that shares the entities but paraphrases the relation verb anchors; a merely topical neighbour does not. Whether a paraphrase agrees or contradicts is left to the caller: an embedding cannot separate a synonym from an antonym, so the shared entities, the relation, and the polarity travel with the hit and the anchor never promotes it to an answer.

`solveFromMemory` (`src/solve.ts`) ranks a decision from what memory currently holds, so the agent stores goals, norms, and candidate actions once and re-solves as evidence arrives rather than re-supplying a full decision packet each call. The projection is pure and deterministic: active goal propositions become goals, active action propositions become candidate actions keyed by the `(+ action <id>)` identifier they declare, and an action-targeting norm becomes a deontic norm while an entity-constraining one is reported unlinked rather than misapplied. The projected scenario runs through the same native `DecisionEngine`, so scoring, ranking, ties, and automatic-execution eligibility stay in MeTTa.

The dynamic signal is the set of active derived conclusions that structurally reference an action. A conflict conclusion forbids the action through the deontic gate; a support conclusion raises its evidence. Because a derived conclusion is proof-only, retracting the observation it rests on invalidates its proof and deactivates it, so a recommendation changes when a conflict is derived and restores when the evidence is retracted. The solver reads this explicit active state and never guesses whether an observation is good or bad for an action; that judgement lives in the agent's derivation, carried with a proof. The receipt keeps advice separate from authority: the ranked decisions are advice, and a recommendation is reported only for a clear, unblocked winner, never on a tie.

## MCP server

`src/mcp.ts` serves the memory and reasoning loop to a coding agent over the official Model Context Protocol SDK. The server owns only transport, schemas, and lifecycle; every reasoning decision stays in the module it wraps. Six tools cover the loop: `remember` ingests controlled-English propositions through the real parser or, given premises, records a proof-backed derived conclusion; `query` answers an English question and keeps exact, reasoned, and related results distinct; `solve` ranks the stored actions through the native decision engine; `revise` supersedes a proposition; `forget` retracts or purges; and `explain` reads a proposition back to its premises and sources. A bad argument returns a structured tool error, and a recommendation from `solve` is never authority to act.

Six more tools serve the scientific literature layer: `find_papers`, `ingest_paper`, `add_claim`, `citations`, `review`, and `check_retractions`. See "Scientific literature" below.

The server also publishes two prompts, a problem-solving loop and the controlled-English contract, and three resources: the memory scopes with the current project identity, the proposition schema, and the removal-authority policy. Agent support for prompts and resources varies, so the Agent Skill stays the portable instruction surface.

The `oh-my-goals mcp` CLI command serves one session over stdio, the transport a coding agent spawns as a child process. It reads the durable store path, project identity, and session from the environment, defaulting the store to `.oh-my-goals/memory.db` under the working directory so each project keeps isolated memory. Because the store is SQLite in WAL mode, several stdio server processes can share one project's memory with concurrent readers and a serialized writer. When the transport closes, the runtime closes the store and the parser subprocess.

## Scientific literature

The literature layer reuses the memory core and adds an acquisition side and two symbolic reasoners over it. The design and build order are recorded in `docs/scientific-literature-assistant.md`.

A work is a bibliographic record with external ids and a status of active, retracted, corrected, concern, or withdrawn. A paper is a source, so a claim drawn from a paper is a proposition sourced from a work: marking the work retracted retracts that source, and the existing reverse invalidation deactivates the claim and any conclusion resting on it. Retraction and withdrawal invalidate; a correction or expression of concern is flagged. The invalidating set is a configurable memory option.

The research worker (`assets/research_worker.py`, driven by `src/research_worker.ts` over line-framed JSON like the parser) is the only part that touches the network: GROBID through `scipdf_parser` for PDF sections and references, Crossref for metadata and retraction status, arXiv for preprints, and Semantic Scholar and OpenAlex for search and citation edges. It never touches a model, and without GROBID ingestion degrades to metadata and references. The claim extractor (`src/extractor.ts`) is an optional OpenAI-compatible model, local or hosted, that reads a parsed paper into controlled-English claims; it only proposes, and each claim is stored only if the HyperBase parser validates it, so model output never enters the knowledge base unchecked.

The citation graph is `(Cites citing key)` and `(WorkKey work key)` atoms reflected from references; `gc-cites-*` and `gc-cited-by-*` walk it by backward and forward chaining, cycle-safe through a visited set. Corroboration and contradiction are `(ClaimCore claim core polarity work)` atoms: two claims share a core when they make the same statement, and a statement asserted by some works and negated by others is contradicted, a paraconsistent state carrying positive and negative evidence at once, projected to a Subjective-Logic opinion through `gc-snars-assess`. The grouping, the traversal, and the invalidation are all MeTTa relations; the worker and the extractor only acquire and propose.

## Agent integration

An agent reaches Oh My Goals two ways, and the installer sets up both. The packaged Agent Skill teaches Claude Code, Codex, and OpenCode when and how to use the loop; `src/skill_installer.ts` copies it into each agent's skill layout. The MCP server makes the tools reachable; `src/mcp_installer.ts` registers it in each agent's config file, which keeps three formats: Claude Code's `.mcp.json` (`mcpServers`), Codex's `config.toml` (`[mcp_servers.oh-my-goals]`), and OpenCode's `opencode.json` (`mcp`). Registration merges into an existing config without disturbing the user's other servers, is idempotent, writes atomically, and reverses through a `remove` that deletes only our entry. The registered server launches this same CLI, so the exact installed version runs, and it carries the parser paths from the installing environment when they are set. The `install` CLI command does both steps for the chosen agent and scope; `install-skill` and `install-mcp` do each alone.

Oh My Goals does not call those agents as models. It does not read or transfer their login state. Authentication remains owned by the agent tool that the user already configured.

## Prolog interoperability

SWI-Prolog is optional. The primary evaluator remains `oh-my-goals.metta` on MeTTa TS.

`assets/gc_score.pl` exposes score and decision-status predicates. `assets/gc_directive.pl` exposes the directive task-state predicate. `@metta-ts/prolog` imports those named predicates into a MeTTa TS evaluator. The `prolog-check` command compares their outputs with the corresponding native relations and disposes the bridge after the check.

The check covers only those predicates. It does not run the full framework in Prolog and does not establish parity for motivation, PLN, SNARS, complete norm resolution, ranking, tie handling, or directive claims.

## Parity scope

The package ports the reusable framework slice represented by its public API:

- static priority-aware norm resolution;
- goal coverage, evidence projection, scoring, ranking, and tie handling;
- individual and collective motivation consensus;
- the selected PLN deduction and count-space revision formulas;
- SNARS opinion construction and two-premise deduction;
- directive state and claim lifecycle relations.

The package does not claim to implement a general theorem prover, a complete deontic-logic library, a complete planner or chainer, a full NARS runtime, or a probabilistic logic runtime.

ProbMeTTa is not ported. ProbMeTTa currently targets PeTTa and SWI-Prolog. A caller that needs its distribution semantics can run it behind a separate evidence adapter and return a graded `EvidenceProjection`. The native rule module does not import PeTTa or ProbMeTTa programs.

## Verification

The repository checks the native module directly, exercises each public reasoning surface, compares the named Prolog predicates when SWI-Prolog is available, and installs the packed tarball into an isolated consumer. Package verification must confirm that `metta/oh-my-goals.metta` is present in the installed package because runtime behavior depends on that file.

The memory loop has its own release proof. A packed-artifact end-to-end test installs the tarball into a fresh consumer, spawns the packed `oh-my-goals mcp` server over stdio, and drives registration, a natural-language query, solving, a derived conflict and its retraction, a purge whose canary is then absent from the database and its journals, and a restart, and, when a research worker is configured, the literature tools end to end: search, ingest, claim, review, citations, and a retraction sweep, all against the real HyperBase parser and a real SQLite store. A property-based lifecycle test replays generated sequences of remember, derive, retract, restore, supersede, add-proof, purge, and restart, and checks the active set, revisions, scope boundaries, purge removal, and restart against a model of the MeTTa rules after every step; it caught a purged-id reuse across restart that a persisted id high-water mark now prevents. The parser-dependent tests are gated on the parser environment and skip cleanly without it, so the parser-free suite runs anywhere. Cross-agent discovery is checked by reading the installer's config back through each agent's own MCP CLI.
