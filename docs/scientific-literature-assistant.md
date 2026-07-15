# Scientific literature assistant

This is the design for turning oh-my-goals into a self-contained scientific
literature research assistant. It records what we build, what we reuse, and the
order we build it in. The prose is the design; the slice list at the end is the
plan.

## Goal

Make oh-my-goals a research assistant for the scientific literature. A caller
gives it a paper by DOI or arXiv id, or a research question, and oh-my-goals
fetches the paper, reads it into checkable claims, keeps those claims with their
provenance in a durable knowledge base, and reasons over them: it corroborates a
claim across papers, detects contradictions between papers, and when a paper is
retracted it deactivates every claim and conclusion that rested on it, with a
proof of why.

The selling point is not retrieval. It is a persistent, verifiable,
contradiction-aware knowledge base with retraction-aware invalidation. A
stateless retrieval-augmented system re-reads papers per question and answers.
oh-my-goals accumulates a knowledge base whose claims carry provenance and
lifecycle, reasons over it symbolically, and explains every conclusion.

## What we reuse, not reinvent

Every mechanical part is an existing, proven, mostly-keyless tool. The novel part
is the combination and the symbolic layer on top.

- **GROBID** (Apache-2.0), through the `scipdf_parser` wrapper, turns a PDF into a
  clean JSON structure: title, abstract, sections, and a parsed reference list.
  It is what Semantic Scholar's S2ORC corpus and PaperQA2 both use.
- **Semantic Scholar API** (`semanticscholar` client) gives search, TLDRs, and
  forward and backward citations over 200M+ papers. Key optional.
- **OpenAlex** (`pyalex`) gives the citation graph over 250M+ works, keyless.
- **Crossref REST API** gives DOI metadata, a parsed reference list, and
  retraction status. Retraction Watch was acquired by Crossref in 2023 and made
  open, updated every working day; per DOI, Crossref reports an `update-type` of
  retraction, correction, expression-of-concern, or withdrawn. Keyless.
- **arXiv API** fetches preprints.
- A **pluggable LLM adapter** does the one step that genuinely needs a language
  model: reading paper prose into controlled-English claims. Local and hosted
  models both speak the OpenAI-compatible `/chat/completions` API, so a single
  adapter configured by base URL, model, and an optional key covers Ollama, LM
  Studio, and llama.cpp on the local side and OpenAI, OpenRouter, and Groq on the
  hosted side. It is optional and swappable, the same way the embedding provider
  already is.

Reused from oh-my-goals itself: the HyperBase parser (controlled-English to
Semantic-Hypergraph tree), the `semmatch` semantic index, the MeTTa lifecycle and
reverse-proof invalidation, and the decision engine.

We reuse PaperQA2's component choices and its citation-traversal idea, but we do
not embed its LLM-driven agent, because oh-my-goals keeps a symbolic core and
treats the model as a side component.

## Architecture

```
research/coding agent (the caller's LLM)
        |  MCP: remember, query, solve, explain, forget, revise + the new tools
        v
+---------------------- oh-my-goals TS core -----------------------------+
|  persistent KB + symbolic reasoning (SQLite + MeTTa):                  |
|  works, claims, citations, lifecycle, contradiction, invalidation     |
|     |                    |                         |                   |
|     v                    v                         v                   |
|  HyperBase parser   Claim extractor          Research worker           |
|  (controlled-EN     (LLM adapter,            (Python subprocess,       |
|   -> SH-tree,        local OR api via        line-framed JSON,         |
|   already exists)    OpenAI-compatible,      env-configured):          |
|                      optional)                 GROBID  PDF->sections/refs
|                                                Semantic Scholar/OpenAlex  search + citations
|                                                Crossref  metadata + retraction
|                                                arXiv  fetch             |
+------------------------------------------------------------------------+
```

The worker fetches and parses and never touches a model. The extractor proposes
claims and never touches the store. The HyperBase parser validates each proposed
claim into a tree before anything is stored. The symbolic core owns the knowledge
base and all reasoning.

## The idea that keeps this small: a paper is a source

oh-my-goals already holds that a claim is active only while it has an active
supporting source, and that retracting a source deactivates everything resting on
it, with a proof. So a **paper is itself a source, a "work"**, and marking a work
retracted is the same operation as retracting a source. Every claim sourced
only from that work goes inactive, every conclusion and synthesis resting on those
claims goes inactive, and `explain` names the retraction as the cause. The
research-integrity feature falls out of machinery that already exists and is
already property-tested.

## Data model

- **Work**: a bibliographic record. Fields: internal id, external ids (DOI, arXiv
  id, Semantic Scholar id, OpenAlex id), title, authors, year, venue, abstract,
  open-access PDF url when known, and a **status** of `active`, `retracted`,
  `corrected`, `concern`, or `withdrawn` with the notice reference and date.
  Durable, with MeTTa facts, scoped like any other record.
- **Claim**: an ordinary proposition whose source is a work. `MemorySourceInput`
  gains a `workId` and a `locator` (a section id and a verbatim quote), so a claim
  points at exactly where in the paper it came from. Marking a work retracted
  retracts every source that references it, and the existing reverse-invalidation
  then deactivates those claims and any conclusions resting on them, with no new
  lifecycle code. The mechanism is exactly source-retraction applied to a work's
  sources.
- **Citation edge**: a directed `cites` relation between two works, stored durably
  and as MeTTa facts, seeded from GROBID's parsed references and enriched from
  Semantic Scholar or OpenAlex.

## Components

### Research worker

A resident Python subprocess driven over line-framed JSON on stdio, mirroring
`assets/hb_worker.py` exactly. New asset `assets/research_worker.py`, TS side
`src/research.ts` with `createResearchWorker()` and a `ResearchWorkerError` raised,
like the parser, only when a command runs without configuration. Commands:

- `search {query, limit, sources}` returns candidate works.
- `resolve {id}` returns one work's metadata.
- `fetch_and_parse {id}` returns `{work, sections, references, pdfUrl}` via GROBID.
- `citations {id, direction, limit}` returns citation edges.
- `retraction_status {dois}` returns per-DOI status from Crossref.

Configuration by environment, following the parser: `OH_MY_GOALS_RESEARCH_PYTHON`
(an interpreter with the deps), `OH_MY_GOALS_GROBID_URL` (a running GROBID
service), `OH_MY_GOALS_OPENALEX_EMAIL` and `OH_MY_GOALS_CROSSREF_EMAIL` (the polite
pool), and an optional `OH_MY_GOALS_S2_API_KEY`. When GROBID is absent, the worker
still returns metadata, abstract, and references from Crossref and Semantic
Scholar, so ingestion degrades to metadata rather than failing. Not configured at
all defers a clear error to call time, as the parser does.

### Claim extractor

An interface `ClaimExtractor` with one method that reads a parsed work and returns
`{claims: [{text, locator, confidence}]}`. The one shipped implementation posts to
an OpenAI-compatible `/chat/completions` endpoint and asks the model to write each
material finding as a controlled-English sentence that follows oh-my-goals's
controlled-English contract, each with the section and quote it came from,
returned as structured JSON. Configuration by environment, mirroring
`resolveEmbeddingProvider`: `OH_MY_GOALS_LLM_BASE_URL`, `OH_MY_GOALS_LLM_MODEL`,
and an optional `OH_MY_GOALS_LLM_API_KEY`. The active model is reported in the
ingest receipt, so a caller always knows which model proposed a claim.

The extractor only proposes. Each proposed claim runs through the existing
HyperBase parser to a validated tree; a claim that will not parse gets the
existing rewrite-feedback loop, and the extractor retries a bounded number of
times or drops it. Only parsed, validated claims are stored, each sourced from the
work with its locator. If no extractor is configured, ingestion returns the parsed
structure and the caller supplies claims through `add_claim`, which is also
model-driven, just the caller's model.

### Symbolic storage and reasoning

Almost all reuse. Ingesting a work writes the work record and its facts, stores its
references as citation edges, and records its retraction status. Extracted or
supplied claims become validated propositions sourced from the work. The abstract
and the claims are indexed with `semmatch`. Contradiction and anchored
corroboration already exist and now run across works. Retraction invalidation is
source-retraction. `review(topic, scope)` retrieves the relevant claims, groups
them by corroboration and contradiction, attaches citations and retracted-source
warnings, and returns structured evidence for the caller to write up.

## MCP surface

Added alongside the existing six tools:

- `find_papers {query, limit, scope}` returns candidate works.
- `ingest_paper {id, scope, extractClaims?}` fetches, parses, and stores the work,
  its references, and its retraction status; auto-extracts claims when an extractor
  is configured and `extractClaims` is set; returns the work and its structure.
- `add_claim {statement, workId, locator, scope, source}` stores one validated
  claim sourced from a work; this is `remember` with a paper source and a locator.
- `citations {workId, direction}` returns citation edges.
- `check_retractions {scope}` re-polls Crossref for every work in the scope, flags
  and invalidates the newly retracted, and reports what changed.
- `review {question, scope}` returns structured evidence: grouped claims,
  agreements, contradictions, citations, and retracted-source warnings.

The existing `query`, `solve`, `explain`, `forget`, and `revise` work over the
literature knowledge base unchanged. A "literature workflow" prompt and a "works
and citations" resource are added.

## Error handling and trust

- The worker and the extractor not being configured produce clear deferred errors
  and graceful degradation: metadata-only ingestion without GROBID, caller-supplied
  claims without an extractor.
- Papers are data. Their text is never evaluated. A model's proposed claim is
  validated by the symbolic parser before it is stored, so model output cannot
  enter the knowledge base unchecked.
- Retraction status from Crossref is authoritative and drives invalidation. A
  correction or an expression of concern is flagged but does not invalidate by
  default; that policy is explicit, not silent.
- API keys come from the environment only. They are never persisted and never
  echoed in a receipt or a log.
- The polite-pool emails, backoff, and caching of metadata and retraction status
  keep the worker within the free APIs' rate limits.

## Testing

- A fake worker and a fake extractor are injected for unit tests, mirroring the
  existing injected fake parser, so the whole surface is tested offline.
- Pinned fixtures: a known arXiv id, a known DOI, and a known retracted DOI.
- A retraction-invalidation differential: ingest a work, add claims, mark it
  retracted, assert the claims and any conclusions resting on them deactivate and
  `explain` cites the retraction.
- The property-based lifecycle test is extended so generated sequences include
  works, claims, and retraction alongside the existing operations.
- Live worker tests are gated on GROBID and network availability, the way the
  parser-dependent tests already gate, and the packed end-to-end test is extended
  to drive an ingest-and-retract loop through the packed artifact.
- The extractor's parse-and-validate loop is tested with a fake model that returns
  a mix of parseable and unparseable claims.

## Slices

Each slice is a vertical that builds, passes, and ships on its own, in order.

1. **Spine.** The work data model and retraction-as-source; `ingest_paper` over the
   worker's Crossref metadata, retraction status, and GROBID parse; `add_claim`;
   `query` and `explain` over works and claims; and mark-retracted invalidation.
   Fake worker for unit tests, one live-gated fixture. This proves the whole spine
   and the retraction differentiator on the smallest surface.
2. **Extractor.** The OpenAI-compatible claim extractor, auto-extraction on ingest,
   and the parse-and-validate loop.
3. **Search.** `find_papers` over Semantic Scholar and OpenAlex, with candidate
   ranking.
4. **Citations.** The citation graph, citation edges from references, and forward
   and backward traversal.
5. **Synthesis.** Contradiction and corroboration surfacing across works, and
   `review` returning structured evidence.
6. **Retraction sweep.** `check_retractions` polling and the correction and
   expression-of-concern policy.
7. **Release.** README, architecture, and skill updates; the packed end-to-end
   extension; and the full release-gate run.

## Decisions

- Corrections and expressions of concern are flagged, not invalidating; retraction
  invalidates. This default is configurable.
- Claims are sentence-level with a section-and-quote locator.
- Works are deduplicated by external id; claims by the existing canonical
  structural fingerprint.
- oh-my-goals returns structured evidence and never writes the final prose review.
