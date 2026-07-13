// Memory ingestion: turn English statements into stored propositions through the
// real HyperBase parser. This is the ingestion path that replaces the shallow
// tree builder. A statement is stored only when it parses into a single faithful
// proposition whose speech-act mood is admissible for its declared kind. A
// question is never stored as an assertion; an imperative is stored only as a
// goal. On rejection the caller gets controlled-English rewrite feedback and
// nothing is written. The composition keeps MemorySpace pure and synchronous:
// this module is the only place the async parser meets the store.

import { semanticCandidatesForEdge } from "./candidates.js";
import {
  appendContract,
  type HyperbaseParse,
  type HyperbaseParseItem,
  type HyperbaseParser,
  type Polarity,
  type SpeechActMood,
} from "./hyperbase.js";
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryKind,
  type MemoryScope,
  type MemorySourceInput,
  type MemorySpace,
  type StoredProposition,
} from "./memory.js";
import { assertDenseArray, assertKnownKeys, assertPlainRecord } from "./records.js";
import { scopeSpaceId, type SemanticBackend } from "./semantic.js";

export interface IngestInput {
  readonly content: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly sources: readonly MemorySourceInput[];
  readonly id?: string;
}

export interface IngestAccepted {
  readonly stored: true;
  readonly proposition: StoredProposition;
  readonly mood: SpeechActMood;
  readonly polarity: Polarity;
  readonly tree: string;
}

export interface IngestRejected {
  readonly stored: false;
  readonly reasons: readonly string[];
  readonly feedback: string;
}

export type IngestResult = IngestAccepted | IngestRejected;

/** Optional semantic indexing: decompose each stored proposition and upsert its
 * candidates into a backend under the space id for its scope. */
export interface IngestSemanticOptions {
  readonly backend: SemanticBackend;
  readonly identity?: { readonly repositoryId?: string; readonly sessionId?: string };
}

const ADMISSIBILITY_MESSAGES: Readonly<Record<string, string>> = {
  "interrogative-not-assertion":
    "the statement is a question; store facts as declaratives and use the query tool for questions",
  "imperative-requires-goal-kind":
    'the statement is an imperative; ingest it with kind "goal" or restate it as a declarative observation',
};

interface ValidatedInput {
  readonly content: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly sources: readonly MemorySourceInput[];
  readonly id?: string;
}

function validateInput(value: unknown): ValidatedInput {
  assertPlainRecord(value, "ingest input");
  assertKnownKeys(value, "ingest input", ["content", "scope", "kind", "sources", "id"]);
  const content = value.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new RangeError("ingest content must not be empty");
  }
  if (!MEMORY_SCOPES.includes(value.scope as MemoryScope)) {
    throw new RangeError(`scope must be one of: ${MEMORY_SCOPES.join(", ")}`);
  }
  if (!MEMORY_KINDS.includes(value.kind as MemoryKind)) {
    throw new RangeError(`kind must be one of: ${MEMORY_KINDS.join(", ")}`);
  }
  if (value.id !== undefined && typeof value.id !== "string") {
    throw new TypeError("ingest id must be a string");
  }
  assertDenseArray(value.sources, "ingest sources");
  return {
    content,
    scope: value.scope as MemoryScope,
    kind: value.kind as MemoryKind,
    sources: value.sources as readonly MemorySourceInput[],
    id: value.id as string | undefined,
  };
}

/** A question is never an assertion; an imperative only expresses a goal. */
function admissibleForKind(
  mood: SpeechActMood,
  kind: MemoryKind,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (mood === "interrogative") return { ok: false, reason: "interrogative-not-assertion" };
  if (mood === "imperative" && kind !== "goal") {
    return { ok: false, reason: "imperative-requires-goal-kind" };
  }
  return { ok: true };
}

function storeItem(
  memory: MemorySpace,
  input: ValidatedInput,
  item: HyperbaseParseItem,
): IngestResult {
  if (!item.quality.accepted) {
    return {
      stored: false,
      reasons: item.quality.reasons,
      feedback: item.quality.rewriteFeedback ?? appendContract("The statement was not accepted."),
    };
  }
  const parse = item.parses[0]!;
  const admit = admissibleForKind(parse.mood, input.kind);
  if (!admit.ok) {
    const detail = ADMISSIBILITY_MESSAGES[admit.reason] ?? admit.reason;
    return {
      stored: false,
      reasons: [admit.reason],
      feedback: appendContract(
        `The statement "${input.content}" parsed as ${parse.mood} and cannot be stored as kind "${input.kind}" (${detail}).`,
      ),
    };
  }
  const proposition = memory.remember({
    content: input.content,
    scope: input.scope,
    kind: input.kind,
    sources: input.sources,
    tree: parse.typedMetta,
    ...(input.id !== undefined ? { id: input.id } : {}),
  });
  return {
    stored: true,
    proposition,
    mood: parse.mood,
    polarity: parse.polarity,
    tree: parse.typedMetta,
  };
}

async function indexStored(
  semantic: IngestSemanticOptions,
  propositionId: string,
  input: ValidatedInput,
  parse: HyperbaseParse,
): Promise<void> {
  const candidates = semanticCandidatesForEdge({
    tree: parse.tree,
    edgeId: propositionId,
    spaceId: scopeSpaceId(input.scope, semantic.identity ?? {}),
    sourceText: input.content,
    polarity: parse.polarity,
    epistemicKind: input.kind,
  });
  await semantic.backend.indexProposition(candidates);
}

/** Parse a batch of statements once, store each admissible proposition, and, when
 * a semantic backend is given, index the stored propositions' candidates. */
export async function ingestStatements(
  parser: HyperbaseParser,
  memory: MemorySpace,
  inputs: readonly IngestInput[],
  semantic?: IngestSemanticOptions,
): Promise<IngestResult[]> {
  assertDenseArray(inputs, "ingest inputs");
  const validated = inputs.map((input) => validateInput(input));
  const batch = await parser.parse(validated.map((input) => input.content));
  if (batch.items.length !== validated.length) {
    throw new Error(
      `HyperBase returned ${batch.items.length} results for ${validated.length} statements`,
    );
  }
  const results = validated.map((input, index) => storeItem(memory, input, batch.items[index]!));
  if (semantic !== undefined) {
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      if (result.stored) {
        await indexStored(semantic, result.proposition.id, validated[index]!, batch.items[index]!.parses[0]!);
      }
    }
  }
  return results;
}

/** Parse and store one statement. */
export async function ingestStatement(
  parser: HyperbaseParser,
  memory: MemorySpace,
  input: IngestInput,
  semantic?: IngestSemanticOptions,
): Promise<IngestResult> {
  const [result] = await ingestStatements(parser, memory, [input], semantic);
  return result!;
}
