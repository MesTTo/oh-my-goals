// The Oh My Goals memory MCP server. It exposes the memory and reasoning loop to a
// coding agent through the official Model Context Protocol SDK: remember stores
// controlled-English propositions, query answers questions over them, solve ranks a
// decision from the stored state, revise supersedes a proposition, forget retracts
// or purges, and explain reads a proposition back to its premises and sources.
//
// The server owns only transport, schemas, and lifecycle. Every reasoning decision
// stays in the modules it wraps: ingestion through the real HyperBase parser, exact
// and semantic query, the native decision engine, and the durable lifecycle. A tool
// never invents an answer, and a recommendation is never authority to act. The
// server does not read the coding agent's authentication state.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { EmbeddingProvider } from "./embedding.js";
import {
  CONTROLLED_ENGLISH_CONTRACT,
  createHyperbaseParser,
  type HyperbaseParser,
} from "./hyperbase.js";
import { ingestStatements, prepareProposition, type IngestResult } from "./ingest.js";
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryKind,
  type MemoryScope,
  type StoredProposition,
  type StoredWork,
  type WorkStatus,
} from "./memory.js";
import type { DurableStore } from "./durable_store.js";
import { SqliteDurableStore } from "./durable_store.js";
import { queryMemory } from "./query.js";
import type { ResearchWorker } from "./research.js";
import { createResearchWorker } from "./research_worker.js";
import { SemanticBackend } from "./semantic.js";
import { SemanticMemory } from "./semantic_memory.js";
import { solveFromMemory, type SolveReceipt } from "./solve.js";
import { resolveEmbeddingProvider } from "./transformers_embedding.js";
import { InMemoryVectorIndex } from "./vector_index.js";

const SERVER_NAME = "oh-my-goals";
const SERVER_VERSION = "0.1.0";

const scopeEnum = z.enum([...MEMORY_SCOPES] as [string, ...string[]]);
const kindEnum = z.enum([...MEMORY_KINDS] as [string, ...string[]]);
const sourceSchema = z.object({
  type: z.string().min(1).describe("source category, e.g. user, repository, tool, agent"),
  reference: z.string().min(1).describe("what the claim is attributed to, e.g. a request or a command"),
  strength: z.number().min(0).max(1).optional().describe("support for the claim, [0,1]"),
  confidence: z.number().min(0).max(1).optional().describe("reliability of that estimate, [0,1]"),
});

// --- runtime lifecycle ---

export interface MemoryRuntime {
  readonly memory: SemanticMemory;
  readonly parser: HyperbaseParser;
  /** The acquisition backend. Like the parser, it is always present and defers a
   * "not configured" error to the first call that needs it. */
  readonly researchWorker: ResearchWorker;
  readonly repository: string | undefined;
  readonly session: string | undefined;
  close(): Promise<void>;
}

export interface MemoryRuntimeOptions {
  readonly repository?: string;
  readonly session?: string;
  /** Durable store. Defaults to SQLite at storePath, or non-persistent when neither is set. */
  readonly store?: DurableStore;
  readonly storePath?: string;
  /** Parser. Defaults to the env-configured AlphaBeta parser; inject a stub for tests. */
  readonly parser?: HyperbaseParser;
  /** Research worker for paper acquisition. Defaults to the env-configured
   * subprocess worker, which defers a "not configured" error to call time; inject
   * a stub for tests. */
  readonly researchWorker?: ResearchWorker;
  /** Embedding provider. Defaults to the token-hash provider, or BGE via env. */
  readonly embedding?: EmbeddingProvider;
  readonly now?: () => string;
}

/** Open the live memory and parser a server session runs on. */
export async function createMemoryRuntime(options: MemoryRuntimeOptions = {}): Promise<MemoryRuntime> {
  const embedding =
    options.embedding ??
    (await resolveEmbeddingProvider(process.env.OH_MY_GOALS_EMBEDDING === "BGE" ? "BGE" : "Local"));
  const backend = new SemanticBackend(embedding, new InMemoryVectorIndex());
  const store =
    options.store ?? (options.storePath !== undefined ? new SqliteDurableStore(options.storePath) : undefined);
  const memory = await SemanticMemory.open({
    ...(store !== undefined ? { store } : {}),
    ...(options.repository !== undefined ? { repository: options.repository } : {}),
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    backend,
  });
  const parser = options.parser ?? createHyperbaseParser();
  const researchWorker = options.researchWorker ?? createResearchWorker();
  return {
    memory,
    parser,
    researchWorker,
    repository: options.repository,
    session: options.session,
    async close() {
      memory.close();
      await parser.close();
      await researchWorker?.close();
    },
  };
}

// --- tool result helpers ---

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(summary: string, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(structured, null, 2)}` }],
    structuredContent: structured,
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// --- serialization ---

function serializeIngest(result: IngestResult): Record<string, unknown> {
  if (result.stored) {
    return {
      stored: true,
      id: result.proposition.id,
      normalizedEnglish: result.proposition.content,
      kind: result.proposition.kind,
      scope: result.proposition.scope,
      mood: result.mood,
      polarity: result.polarity,
      revision: result.proposition.revision,
    };
  }
  return { stored: false, reasons: result.reasons, feedback: result.feedback };
}

function serializeSolve(receipt: SolveReceipt): Record<string, unknown> {
  return {
    scope: receipt.scope,
    recommended: receipt.recommended,
    automaticExecutionAllowed: receipt.automaticExecutionAllowed,
    tiedActionIds: receipt.tiedActionIds,
    blockedActionIds: receipt.blockedActionIds,
    decisions: receipt.ranking.decisions.map((decision) => ({
      actionId: decision.actionId,
      label: decision.label,
      status: decision.status,
      score: decision.score,
      normStatus: decision.normStatus,
      satisfiedGoals: decision.satisfiedGoals,
      missingRequiredGoals: decision.missingRequiredGoals,
      warnings: decision.warnings,
    })),
    evidence: receipt.evidence,
    diagnostics: receipt.diagnostics,
    provenance: receipt.provenance,
  };
}

function serializeWork(work: StoredWork): Record<string, unknown> {
  return {
    id: work.id,
    title: work.title,
    doi: work.doi ?? null,
    arxivId: work.arxivId ?? null,
    authors: work.authors,
    year: work.year ?? null,
    venue: work.venue ?? null,
    status: work.status,
    statusNotice: work.statusNotice ?? null,
    statusDate: work.statusDate ?? null,
    revision: work.revision,
  };
}

function serializeProposition(proposition: StoredProposition, active: boolean): Record<string, unknown> {
  return {
    id: proposition.id,
    content: proposition.content,
    kind: proposition.kind,
    scope: proposition.scope,
    state: proposition.state,
    active,
    revision: proposition.revision,
    supersededBy: proposition.supersededBy ?? null,
    supersedes: proposition.supersedes ?? null,
  };
}

/** Read a proposition back to its premises, sources, and current active state. */
function explainProposition(memory: SemanticMemory, id: string): Record<string, unknown> | null {
  const proposition = memory.get(id);
  if (proposition === undefined) return null;
  return {
    ...serializeProposition(proposition, memory.isActive(id)),
    recordedAt: proposition.recordedAt,
    sources: proposition.sources.map((source) => ({
      assertionId: source.assertionId,
      type: source.type,
      reference: source.reference,
      strength: source.strength,
      confidence: source.confidence,
      state: source.state,
    })),
    derivations: proposition.derivations.map((derivation) => ({
      rule: derivation.rule,
      premises: derivation.premises,
      premisesActive: derivation.premises.map((premise) => memory.isActive(premise)),
    })),
  };
}

// Propositions whose proof cites the target, so a forget preview can show what a
// removal would invalidate before it happens.
function dependentsOf(memory: SemanticMemory, id: string): string[] {
  const dependents: string[] = [];
  for (const candidateId of memory.activePropositions()) {
    const candidate = memory.get(candidateId);
    if (candidate === undefined) continue;
    if (candidate.derivations.some((derivation) => derivation.premises.includes(id))) {
      dependents.push(candidateId);
    }
  }
  return dependents;
}

function assertScope(scope: string): MemoryScope {
  if (!MEMORY_SCOPES.includes(scope as MemoryScope)) {
    throw new RangeError(`scope must be one of: ${MEMORY_SCOPES.join(", ")}`);
  }
  return scope as MemoryScope;
}

// --- server assembly ---

/** Build the memory MCP server over a live runtime, registering every tool,
 * prompt, and resource. The caller owns connecting a transport. */
export function createMemoryMcpServer(runtime: MemoryRuntime): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const { memory, parser } = runtime;

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Store one or more controlled-English propositions in memory, parsed into Semantic-Hypergraph trees. A question is never stored as an assertion; an imperative is stored only with kind \"goal\". A rejected statement returns controlled-English rewrite feedback and stores nothing. Pass premises to record a derived conclusion that follows from them: it stays active only while its premises do, so retracting the evidence recomputes it.",
      inputSchema: {
        statements: z.array(z.string().min(1)).min(1).describe("one asserted proposition per string"),
        scope: scopeEnum,
        kind: kindEnum,
        source: sourceSchema,
        premises: z
          .array(z.string().min(1))
          .optional()
          .describe('proposition ids this conclusion follows from; requires kind "derived-conclusion" and a single statement'),
      },
    },
    async ({ statements, scope, kind, source, premises }) => {
      try {
        if (premises !== undefined) {
          if (kind !== "derived-conclusion") return fail('premises require kind "derived-conclusion"');
          if (statements.length !== 1) return fail("a derived conclusion is a single statement");
          const prepared = await prepareProposition(parser, statements[0]!, scope as MemoryScope, kind as MemoryKind);
          if ("stored" in prepared) return fail(prepared.feedback);
          const conclusion = await memory.derive({
            content: prepared.content,
            rule: source.reference,
            premises,
            scope: scope as MemoryScope,
            kind: kind as MemoryKind,
            tree: prepared.tree,
            shTree: prepared.shTree,
            polarity: prepared.polarity,
          });
          return ok(`Derived ${conclusion.id} from ${premises.length} premise(s).`, {
            results: [serializeProposition(conclusion, memory.isActive(conclusion.id))],
          });
        }
        const results = await ingestStatements(
          parser,
          memory,
          statements.map((content) => ({ content, scope: scope as MemoryScope, kind: kind as MemoryKind, sources: [source] })),
        );
        const stored = results.filter((result) => result.stored).length;
        return ok(
          `Stored ${stored} of ${results.length} statement(s) in ${scope} memory.`,
          { results: results.map(serializeIngest) },
        );
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  server.registerTool(
    "query",
    {
      title: "Query",
      description:
        "Answer an English question over memory. Returns exact and reasoned answers (entailed), semantically related matches (never a proof), and a precise limitation for unsupported question forms.",
      inputSchema: {
        question: z.string().min(1),
        scope: scopeEnum.optional().describe("restrict to one scope; default searches all active memory"),
        includeRelated: z.boolean().optional().describe("also list semantic neighbours alongside exact answers"),
      },
    },
    async ({ question, scope, includeRelated }) => {
      try {
        const receipt = await queryMemory(parser, memory, question, {
          ...(scope !== undefined ? { scope: scope as MemoryScope } : {}),
          ...(includeRelated !== undefined ? { includeRelated } : {}),
        });
        const summary =
          receipt.answers.length > 0
            ? `${receipt.answers.length} answer(s); ${receipt.related.length} related.`
            : receipt.unsupported.length > 0
              ? `No exact answer: ${receipt.unsupported.join(", ")}.`
              : `No answer; ${receipt.related.length} related.`;
        return ok(summary, receipt as unknown as Record<string, unknown>);
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  server.registerTool(
    "solve",
    {
      title: "Solve",
      description:
        "Rank the candidate actions in memory against its goals, norms, and evidence through the native decision engine. Advice is separate from authority: a recommendation is reported only for a clear, unblocked winner, never on a tie, and automatic-execution eligibility travels beside it.",
      inputSchema: {
        scope: scopeEnum,
        title: z.string().optional(),
        motivationScores: z.record(z.string(), z.number()).optional().describe("per-action motivation, keyed by action id"),
      },
    },
    async ({ scope, title, motivationScores }) => {
      try {
        const receipt = solveFromMemory(memory.space, {
          scope: scope as MemoryScope,
          ...(title !== undefined ? { title } : {}),
          ...(motivationScores !== undefined ? { motivationScores } : {}),
        });
        const summary = receipt.recommended
          ? `Recommended ${receipt.recommended} (automatic execution ${receipt.automaticExecutionAllowed ? "allowed" : "not allowed"}).`
          : receipt.tiedActionIds.length > 1
            ? `Tie between ${receipt.tiedActionIds.join(", ")}; no automatic execution.`
            : `No clear recommendation; gather more evidence.`;
        return ok(summary, serializeSolve(receipt));
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  server.registerTool(
    "revise",
    {
      title: "Revise",
      description:
        "Supersede a proposition with a corrected controlled-English statement. The earlier proposition becomes historical and inactive; the replacement becomes active; conclusions that depended on the old one are recomputed. A stale expected revision is rejected so two agents cannot silently overwrite each other.",
      inputSchema: {
        id: z.string().min(1).describe("the proposition to correct"),
        statement: z.string().min(1).describe("the corrected controlled-English proposition"),
        source: sourceSchema,
        kind: kindEnum.optional().describe("defaults to the superseded proposition's kind"),
        scope: scopeEnum.optional().describe("defaults to the superseded proposition's scope"),
        expectedRevision: z.number().int().nonnegative().optional(),
      },
    },
    async ({ id, statement, source, kind, scope, expectedRevision }) => {
      try {
        const previous = memory.get(id);
        if (previous === undefined) return fail(`not_found: no proposition ${id}`);
        const resolvedScope = (scope as MemoryScope | undefined) ?? previous.scope;
        const resolvedKind = (kind as MemoryKind | undefined) ?? previous.kind;
        const prepared = await prepareProposition(parser, statement, resolvedScope, resolvedKind);
        if ("stored" in prepared) return fail(prepared.feedback);
        const result = await memory.supersede(
          id,
          {
            content: prepared.content,
            scope: resolvedScope,
            kind: resolvedKind,
            sources: [source],
            tree: prepared.tree,
            shTree: prepared.shTree,
            polarity: prepared.polarity,
          },
          expectedRevision,
        );
        if (!result.ok) return fail(JSON.stringify(result));
        return ok(
          `Superseded ${id} with ${result.replacement.id}; ${result.invalidated.length} dependent conclusion(s) recomputed.`,
          {
            superseded: serializeProposition(result.superseded, false),
            replacement: serializeProposition(result.replacement, true),
            invalidated: result.invalidated,
          },
        );
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  server.registerTool(
    "forget",
    {
      title: "Forget",
      description:
        "Retract or permanently purge exact propositions. Retraction makes a proposition inactive while keeping its history; purge removes it and scrubs its text irrecoverably. A preview lists the targets and the conclusions a removal would invalidate without changing anything.",
      inputSchema: {
        propositionIds: z.array(z.string().min(1)).min(1),
        mode: z.enum(["retract", "purge"]),
        expectedRevision: z.number().int().nonnegative().optional().describe("applied to each target; a stale revision is rejected"),
        reason: z.string().optional(),
        preview: z.boolean().optional().describe("list what would change without mutating state"),
      },
    },
    async ({ propositionIds, mode, expectedRevision, preview }) => {
      try {
        if (preview === true) {
          const targets = propositionIds.map((id) => {
            const proposition = memory.get(id);
            return {
              id,
              exists: proposition !== undefined,
              ...(proposition !== undefined
                ? {
                    active: memory.isActive(id),
                    kind: proposition.kind,
                    scope: proposition.scope,
                    dependents: dependentsOf(memory, id),
                  }
                : {}),
            };
          });
          return ok(`Preview of ${mode} for ${propositionIds.length} proposition(s); no state changed.`, {
            mode,
            preview: true,
            targets,
          });
        }
        const results = [];
        for (const id of propositionIds) {
          const result = mode === "purge"
            ? await memory.purge(id, expectedRevision)
            : await memory.retract(id, expectedRevision);
          results.push(
            result.ok
              ? { id, ok: true, mode, invalidated: result.invalidated, ...("revision" in result ? { revision: result.revision } : {}) }
              : { ...result },
          );
        }
        const failed = results.filter((result) => result.ok === false).length;
        return ok(
          `${mode === "purge" ? "Purged" : "Retracted"} ${results.length - failed} of ${results.length}; ${failed} failed.`,
          { mode, results },
        );
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  server.registerTool(
    "explain",
    {
      title: "Explain",
      description:
        "Explain a stored proposition through its active premises, rules, sources, and lifecycle state. Returns externalized reasons and proof artifacts, not model reasoning.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      try {
        const explanation = explainProposition(memory, id);
        if (explanation === null) return fail(`not_found: no proposition ${id}`);
        return ok(`Explanation of ${id}.`, explanation);
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  server.registerTool(
    "ingest_paper",
    {
      title: "Ingest paper",
      description:
        "Fetch a paper by DOI or arXiv id, parse it, and store it as a work with its retraction status. Returns the work and its parsed sections and references so you can add claims from them. A retracted paper is stored retracted, so any claim added from it is inactive.",
      inputSchema: {
        id: z.string().min(1).describe("a DOI or an arXiv id"),
        scope: scopeEnum,
      },
    },
    async ({ id, scope }) => {
      try {
        const parsed = await runtime.researchWorker.fetchAndParse(id);
        const meta = parsed.metadata;
        let status: WorkStatus = "active";
        let notice: string | undefined;
        let date: string | undefined;
        if (meta.doi !== undefined) {
          const [record] = await runtime.researchWorker.retractionStatus([meta.doi]);
          if (record !== undefined) {
            status = record.status;
            notice = record.notice;
            date = record.date;
          }
        }
        const work = await memory.ingestWork({
          title: meta.title,
          scope: scope as MemoryScope,
          doi: meta.doi,
          arxivId: meta.arxivId,
          openAlexId: meta.openAlexId,
          semanticScholarId: meta.semanticScholarId,
          authors: meta.authors,
          year: meta.year,
          venue: meta.venue,
          abstract: meta.abstract,
          pdfUrl: meta.pdfUrl,
          status,
          statusNotice: notice,
          statusDate: date,
        });
        return ok(`Ingested ${work.id}${status === "active" ? "" : ` (${status})`}.`, {
          work: serializeWork(work),
          sections: parsed.sections,
          references: parsed.references,
        });
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  server.registerTool(
    "add_claim",
    {
      title: "Add claim",
      description:
        "Store one claim drawn from an ingested work. The statement is a single controlled-English sentence, workId is the work it comes from, and locator is the section and quote it rests on. The claim stays active only while the work is not retracted. A rejected statement returns rewrite feedback and stores nothing.",
      inputSchema: {
        statement: z.string().min(1).describe("one asserted proposition"),
        workId: z.string().min(1).describe("the id of an ingested work"),
        locator: z.string().min(1).describe("where in the work the claim is, e.g. a section and a quote"),
        scope: scopeEnum,
        kind: kindEnum.optional().describe('defaults to "observation"'),
      },
    },
    async ({ statement, workId, locator, scope, kind }) => {
      const work = memory.getWork(workId);
      if (work === undefined) return fail(`no such work: ${workId}`);
      try {
        const [result] = await ingestStatements(parser, memory, [
          {
            content: statement,
            scope: scope as MemoryScope,
            kind: (kind ?? "observation") as MemoryKind,
            sources: [{ type: "paper", reference: work.doi ?? work.arxivId ?? work.id, workId, locator }],
          },
        ]);
        return ok(
          result!.stored ? `Stored claim ${result!.proposition.id} from ${workId}.` : "The statement was not stored.",
          serializeIngest(result!),
        );
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  server.registerTool(
    "check_retractions",
    {
      title: "Check retractions",
      description:
        "Re-check every ingested work in a scope against Crossref and invalidate the claims of any newly retracted work. Reports the works whose status changed and the claims that were invalidated.",
      inputSchema: { scope: scopeEnum },
    },
    async ({ scope }) => {
      try {
        const works = memory.worksInScope(scope as MemoryScope).filter((work) => work.doi !== undefined);
        if (works.length === 0) return ok("No works with a DOI to check.", { changed: [] });
        const records = await runtime.researchWorker.retractionStatus(works.map((work) => work.doi!));
        const byDoi = new Map(records.map((record) => [record.doi, record]));
        const changed: Record<string, unknown>[] = [];
        for (const work of works) {
          const record = byDoi.get(work.doi!);
          if (record === undefined || record.status === work.status) continue;
          const result = await memory.setWorkStatus(work.id, record.status, record.notice, record.date);
          if (result.ok) {
            changed.push({ workId: work.id, doi: work.doi, from: work.status, to: record.status, invalidated: result.invalidated });
          }
        }
        return ok(`Checked ${works.length} work(s); ${changed.length} changed.`, { changed });
      } catch (error) {
        return fail(errorText(error));
      }
    },
  );

  registerPromptsAndResources(server, runtime);
  return server;
}

const PROBLEM_SOLVING_PROMPT = `Use Oh My Goals to keep a nontrivial coding decision traceable across turns.

1. Translate the material parts of the request into controlled-English propositions and remember them with their real sources: user statements and repository instructions carry authority, an agent belief is a hypothesis, a tool result is an observation.
2. Query existing memory before proposing a plan, so you do not repeat earlier work or violate a standing constraint.
3. Store each candidate action as "Action <id> ..." and solve to rank them. A recommendation is advice, not authority: never execute a tied, blocked, or under-evidenced action automatically.
4. When a tool result changes the picture, remember it as an observation and, if it settles a conflict, derive the conclusion with a proof, then solve again.
5. Use revise to correct a proposition and forget to retract a disproved hypothesis. Ask the user when a missing policy choice would change the outcome.`;

function registerPromptsAndResources(server: McpServer, runtime: MemoryRuntime): void {
  server.registerPrompt(
    "problem-solving",
    { title: "Problem-solving loop", description: "How to use the memory and reasoning loop for a nontrivial decision." },
    () => ({ messages: [{ role: "user", content: { type: "text", text: PROBLEM_SOLVING_PROMPT } }] }),
  );

  server.registerPrompt(
    "controlled-english",
    { title: "Controlled-English contract", description: "The rules a proposition must follow to parse and store faithfully." },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Write propositions that follow these rules:\n\n${CONTROLLED_ENGLISH_CONTRACT.map((rule) => `- ${rule}`).join("\n")}`,
          },
        },
      ],
    }),
  );

  server.registerResource(
    "memory-scopes",
    "omg://memory/scopes",
    { title: "Memory scopes and project identity", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              scopes: {
                session: "temporary facts and hypotheses for one active task",
                project: "repository-specific facts and decisions",
                user: "stable preferences the user explicitly promoted",
                derived:
                  "conclusions and proof dependencies computed from the visible scopes; a solve reads them alongside the scope it solves, so a conclusion stored here or in the solved scope informs the decision",
              },
              repository: runtime.repository ?? null,
              session: runtime.session ?? null,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "proposition-schema",
    "omg://memory/schema",
    { title: "Proposition schema", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ kinds: MEMORY_KINDS, scopes: MEMORY_SCOPES, sourceFields: ["type", "reference", "strength", "confidence"] }, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "removal-authority",
    "omg://memory/removal-authority",
    { title: "Removal authority", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: `# Removal authority

- The agent may retract its own session hypotheses when they are disproved.
- Removing a user statement or persistent project memory requires authority from the current user request.
- Permanent purge always requires an explicit user instruction.
- When authority is absent, return the preview instead of guessing, and ask the user.
- A recommendation from solve is not authority to act; execution needs the user's approval and an available, unblocked action.`,
        },
      ],
    }),
  );
}

/** Open a runtime and serve the memory MCP over stdio until the transport closes. */
export async function runStdioMemoryServer(options: MemoryRuntimeOptions = {}): Promise<void> {
  const runtime = await createMemoryRuntime(options);
  const server = createMemoryMcpServer(runtime);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void runtime.close();
  };
  await server.connect(transport);
}
