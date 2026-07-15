// Claim extraction: read a parsed paper into controlled-English claims through a
// pluggable language model, then keep only the claims the HyperBase parser
// accepts. The model is a side component. It proposes; the symbolic parser
// decides. A proposed claim that will not parse is fed the parser's own
// rewrite guidance and retried a bounded number of times, then dropped. So a
// model can never put an unchecked sentence into the knowledge base.
//
// The one shipped model adapter speaks the OpenAI-compatible /chat/completions
// API, which local runtimes (Ollama, LM Studio, llama.cpp) and hosted providers
// (OpenAI, OpenRouter, Groq) all expose, so a single adapter configured by base
// URL, model, and an optional key covers both. It mirrors the embedding provider:
// optional, swappable, and resolved from the environment.

import { CONTROLLED_ENGLISH_CONTRACT } from "./hyperbase.js";
import { assertDenseArray, assertPlainRecord, finiteProbability } from "./records.js";
import type { ParsedPaper, ParsedSection } from "./research.js";

/** Where in a work a claim came from: a section heading and a verbatim quote. */
export interface ClaimLocator {
  readonly section: string;
  readonly quote: string;
}

/** One claim a model proposes from a paper, before the parser has judged it. */
export interface ProposedClaim {
  readonly text: string;
  readonly locator: ClaimLocator;
  readonly confidence: number;
}

/** The claims a model proposed for one paper, with the model that proposed them. */
export interface ExtractionResult {
  readonly model: string;
  readonly claims: readonly ProposedClaim[];
}

/** A language-model claim source. It proposes claims and revises one on request;
 * it never stores anything and never sees the knowledge base. */
export interface ClaimExtractor {
  /** The model reported in ingest receipts, so a caller knows what proposed a claim. */
  readonly model: string;
  extract(paper: ParsedPaper): Promise<ExtractionResult>;
  /** Rewrite one claim to satisfy the parser, given its controlled-English feedback. */
  rewrite(claim: string, feedback: string): Promise<string>;
  close?(): Promise<void>;
}

/** Thrown when the model endpoint errors or returns output that is not usable. */
export class ClaimExtractorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClaimExtractorError";
  }
}

// --- the parse-and-validate loop ---

/** The result of trying to store one proposed claim: an id, or the parser's
 * rejection with rewrite feedback so the loop can revise and retry. */
export type StoreOutcome =
  | { readonly stored: true; readonly id: string }
  | { readonly stored: false; readonly feedback: string; readonly reasons: readonly string[] };

export interface StoredClaim {
  readonly id: string;
  readonly text: string;
  readonly locator: ClaimLocator;
  readonly confidence: number;
  /** How many model turns it took: 1 if accepted as proposed, more after rewrites. */
  readonly attempts: number;
}

export interface DroppedClaim {
  readonly text: string;
  readonly locator: ClaimLocator;
  readonly reasons: readonly string[];
  readonly attempts: number;
}

export interface ClaimExtractionOutcome {
  readonly model: string;
  readonly proposed: number;
  readonly stored: readonly StoredClaim[];
  readonly dropped: readonly DroppedClaim[];
}

export interface StoreExtractedClaimsOptions {
  /** Rewrite attempts allowed per claim after the first rejection. Default 2. */
  readonly maxRewrites?: number;
}

/** How the store step reports back for one attempted claim. */
export type StoreClaim = (text: string, locator: ClaimLocator) => Promise<StoreOutcome>;

/** Extract claims from a paper and store the ones the parser accepts.
 *
 * Storage is a callback so this loop never imports the memory layer: the caller
 * wires `storeClaim` to the same ingest path `add_claim` uses, sourced from the
 * work. Each proposed claim is stored on the first try when it parses; on
 * rejection the parser's feedback drives a rewrite and a retry, up to
 * `maxRewrites` times, after which the claim is dropped with its last reasons. */
export async function storeExtractedClaims(
  extractor: ClaimExtractor,
  paper: ParsedPaper,
  storeClaim: StoreClaim,
  options: StoreExtractedClaimsOptions = {},
): Promise<ClaimExtractionOutcome> {
  const maxRewrites = options.maxRewrites ?? 2;
  if (!Number.isInteger(maxRewrites) || maxRewrites < 0) {
    throw new RangeError("maxRewrites must be a non-negative integer");
  }
  const proposal = await extractor.extract(paper);
  const stored: StoredClaim[] = [];
  const dropped: DroppedClaim[] = [];
  for (const claim of proposal.claims) {
    let text = claim.text;
    let attempts = 0;
    let lastReasons: readonly string[] = [];
    for (;;) {
      attempts += 1;
      const outcome = await storeClaim(text, claim.locator);
      if (outcome.stored) {
        stored.push({ id: outcome.id, text, locator: claim.locator, confidence: claim.confidence, attempts });
        break;
      }
      lastReasons = outcome.reasons;
      if (attempts > maxRewrites) {
        dropped.push({ text, locator: claim.locator, reasons: lastReasons, attempts });
        break;
      }
      // Revise the sentence that was just rejected using the parser's own guidance.
      text = await extractor.rewrite(text, outcome.feedback);
    }
  }
  return { model: proposal.model, proposed: proposal.claims.length, stored, dropped };
}

// --- the OpenAI-compatible model adapter ---

/** The response formats an OpenAI-compatible endpoint may support. `json_object`
 * is the widely supported one; `json_schema` is stricter but newer; `none` sends
 * no format and leans on the prompt and tolerant parsing for endpoints with neither. */
export type ResponseFormat = "json_object" | "json_schema" | "none";

export interface OpenAiCompatibleExtractorConfig {
  /** Base URL of the OpenAI-compatible API, e.g. http://localhost:11434/v1. */
  readonly baseUrl: string;
  readonly model: string;
  /** Bearer token, from OH_MY_GOALS_LLM_API_KEY. Never persisted or echoed. */
  readonly apiKey?: string;
  /** Sampling temperature. Default 0 for stable, repeatable extraction. */
  readonly temperature?: number;
  /** Request deadline in ms. Default 120000. */
  readonly timeoutMs?: number;
  /** Upper bound on prompt characters of paper text. Default 12000. */
  readonly maxPromptChars?: number;
  /** Upper bound on claims requested from one paper. Default 12. */
  readonly maxClaims?: number;
  /** Structured-output mode. Default `json_object`. */
  readonly responseFormat?: ResponseFormat;
  /** Injected fetch for tests. Default the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PROMPT_CHARS = 12_000;
const DEFAULT_MAX_CLAIMS = 12;
const QUOTE_LIMIT = 240;

const EXTRACTION_RULES: readonly string[] = [
  ...CONTROLLED_ENGLISH_CONTRACT,
  "Write each claim as one short sentence: a subject, a verb, and what it acts on.",
  "Do not include citation markers such as [12] or (Smith, 2017).",
  "Do not use subordinate clauses beyond a single 'that' complement.",
  "State only findings the paper asserts; do not add outside knowledge.",
];

// Real accepted controlled-English, so the model has the target shape to imitate.
const EXTRACTION_EXAMPLES: readonly string[] = [
  "The method improves recall.",
  "The drug reduces risk.",
  "The Transformer achieves 28.4 BLEU on the WMT 2014 English-to-German translation task.",
];

const CLAIM_JSON_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          section: { type: "string" },
          quote: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["text", "section", "quote", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
} as const;

interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

/** Reads papers into claims through an OpenAI-compatible chat-completions endpoint. */
export class OpenAiCompatibleExtractor implements ClaimExtractor {
  readonly model: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #temperature: number;
  readonly #timeoutMs: number;
  readonly #maxPromptChars: number;
  readonly #maxClaims: number;
  readonly #responseFormat: ResponseFormat;
  readonly #fetch: typeof fetch;

  constructor(config: OpenAiCompatibleExtractorConfig) {
    assertPlainRecord(config, "extractor config");
    if (typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") {
      throw new ClaimExtractorError("extractor baseUrl must be a nonblank string");
    }
    if (typeof config.model !== "string" || config.model.trim() === "") {
      throw new ClaimExtractorError("extractor model must be a nonblank string");
    }
    this.model = config.model;
    // Normalize a trailing slash so `${base}/chat/completions` never doubles it.
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#apiKey = config.apiKey;
    this.#temperature = config.temperature ?? 0;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxPromptChars = config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
    this.#maxClaims = config.maxClaims ?? DEFAULT_MAX_CLAIMS;
    this.#responseFormat = config.responseFormat ?? "json_object";
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new ClaimExtractorError("no fetch implementation is available for the extractor");
    }
  }

  async extract(paper: ParsedPaper): Promise<ExtractionResult> {
    assertPlainRecord(paper, "paper");
    const content = await this.#complete(this.#extractionMessages(paper), CLAIM_JSON_SCHEMA);
    const record = parseJsonObject(content);
    assertDenseArray(record.claims, "extractor claims");
    const claims = record.claims.slice(0, this.#maxClaims).map((claim, index) => normalizeClaim(claim, index));
    return { model: this.model, claims };
  }

  async rewrite(claim: string, feedback: string): Promise<string> {
    if (typeof claim !== "string" || claim.trim() === "") {
      throw new ClaimExtractorError("claim to rewrite must be a nonblank string");
    }
    const schema = {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    };
    const content = await this.#complete(this.#rewriteMessages(claim, feedback), schema);
    const record = parseJsonObject(content);
    const text = record.text;
    if (typeof text !== "string" || text.trim() === "") {
      throw new ClaimExtractorError("rewrite returned no replacement text");
    }
    return text.trim();
  }

  #extractionMessages(paper: ParsedPaper): readonly ChatMessage[] {
    const system =
      "You read a scientific paper and extract its material findings as controlled-English claims. " +
      "Every claim must follow this contract:\n" +
      EXTRACTION_RULES.map((rule) => `- ${rule}`).join("\n") +
      "\n\nWrite claims like these:\n" +
      EXTRACTION_EXAMPLES.map((example) => `- ${example}`).join("\n") +
      "\n\nReturn a JSON object {\"claims\": [{\"text\", \"section\", \"quote\", \"confidence\"}]}. " +
      "text is the claim. section is the heading it came from. quote is a short verbatim " +
      "excerpt (at most one sentence) from that section supporting it. confidence is a number in [0,1].";
    const user =
      `Title: ${paper.metadata.title}\n\n` +
      this.#paperBody(paper) +
      `\n\nExtract up to ${this.#maxClaims} controlled-English claims of the paper's main findings.`;
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }

  #rewriteMessages(claim: string, feedback: string): readonly ChatMessage[] {
    const system =
      "You rewrite a single scientific claim so a strict controlled-English parser accepts it, " +
      "without changing its meaning. Keep it to one short subject-verb-object sentence. " +
      'Return a JSON object {"text": "<the rewritten claim>"}.';
    const user = `Claim: ${claim}\n\nParser feedback:\n${feedback}\n\nReturn the corrected claim.`;
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }

  // Abstract first, then section bodies, capped so the prompt stays bounded.
  #paperBody(paper: ParsedPaper): string {
    const blocks: string[] = [];
    const abstract = paper.metadata.abstract;
    if (abstract !== undefined && abstract.trim() !== "") {
      blocks.push(`## Abstract\n${abstract.trim()}`);
    }
    for (const section of paper.sections) {
      blocks.push(sectionBlock(section));
    }
    let body = "";
    for (const block of blocks) {
      if (body.length + block.length + 2 > this.#maxPromptChars) break;
      body += (body === "" ? "" : "\n\n") + block;
    }
    return body === "" ? "(no body text was parsed; use the title only)" : body;
  }

  async #complete(messages: readonly ChatMessage[], schema: Readonly<Record<string, unknown>>): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: this.#temperature,
    };
    const responseFormat = this.#buildResponseFormat(schema);
    if (responseFormat !== undefined) body.response_format = responseFormat;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ClaimExtractorError(`extractor request timed out after ${this.#timeoutMs} ms`);
      }
      throw new ClaimExtractorError(`extractor request failed: ${errorMessage(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const detail = (await safeText(response)).slice(0, 400);
      throw new ClaimExtractorError(`extractor endpoint returned ${response.status}: ${detail}`);
    }
    const payload = (await response.json()) as unknown;
    return extractContent(payload);
  }

  #buildResponseFormat(schema: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
    if (this.#responseFormat === "none") return undefined;
    if (this.#responseFormat === "json_schema") {
      return { type: "json_schema", json_schema: { name: "claims", schema, strict: true } };
    }
    return { type: "json_object" };
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#apiKey !== undefined && this.#apiKey !== "") {
      headers.authorization = `Bearer ${this.#apiKey}`;
    }
    return headers;
  }
}

function sectionBlock(section: ParsedSection): string {
  return `## ${section.heading}\n${section.text}`;
}

/** Format a locator for storage as a source reference: section and a short quote. */
export function formatLocator(locator: ClaimLocator): string {
  const quote = locator.quote.trim();
  const clipped = quote.length > QUOTE_LIMIT ? `${quote.slice(0, QUOTE_LIMIT)}…` : quote;
  const section = locator.section.trim();
  if (section === "" && clipped === "") return "unspecified";
  if (clipped === "") return section;
  if (section === "") return `"${clipped}"`;
  return `§${section}: "${clipped}"`;
}

function normalizeClaim(value: unknown, index: number): ProposedClaim {
  assertPlainRecord(value, `extractor claim ${index}`);
  const text = value.text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new ClaimExtractorError(`extractor claim ${index} has no text`);
  }
  const section = typeof value.section === "string" ? value.section : "";
  const quote = typeof value.quote === "string" ? value.quote : "";
  const confidence =
    value.confidence === undefined ? 0.5 : finiteProbability(value.confidence, `extractor claim ${index} confidence`);
  return { text: text.trim(), locator: { section, quote }, confidence };
}

/** Pull the assistant message text out of an OpenAI-compatible completion. */
function extractContent(payload: unknown): string {
  assertPlainRecord(payload, "completion");
  assertDenseArray(payload.choices, "completion choices");
  const first = payload.choices[0];
  if (first === undefined) throw new ClaimExtractorError("completion returned no choices");
  assertPlainRecord(first, "completion choice");
  assertPlainRecord(first.message, "completion message");
  const content = first.message.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new ClaimExtractorError("completion message had no text content");
  }
  return content;
}

// Tolerant JSON: parse the whole string, else the widest {...} span, so an
// endpoint that ignores response_format and wraps the object in prose still works.
function parseJsonObject(content: string): Readonly<Record<string, unknown>> {
  const candidate = jsonCandidate(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new ClaimExtractorError(`extractor returned non-JSON output: ${errorMessage(error)}`);
  }
  assertPlainRecord(parsed, "extractor JSON");
  return parsed;
}

function jsonCandidate(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new ClaimExtractorError("extractor returned no JSON object");
  }
  return trimmed.slice(start, end + 1);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- resolution from the environment ---

export interface ResolveClaimExtractorOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly maxPromptChars?: number;
  readonly maxClaims?: number;
  readonly responseFormat?: ResponseFormat;
  readonly fetchImpl?: typeof fetch;
}

/** Build the OpenAI-compatible extractor from configuration or the environment,
 * or return undefined when no model is configured. Extraction is optional: with
 * no extractor, ingestion returns the parsed paper and the caller adds claims
 * through their own model via `add_claim`. */
export function resolveClaimExtractor(options: ResolveClaimExtractorOptions = {}): ClaimExtractor | undefined {
  const baseUrl = options.baseUrl ?? process.env.OH_MY_GOALS_LLM_BASE_URL;
  const model = options.model ?? process.env.OH_MY_GOALS_LLM_MODEL;
  if (baseUrl === undefined || baseUrl.trim() === "" || model === undefined || model.trim() === "") {
    return undefined;
  }
  const apiKey = options.apiKey ?? process.env.OH_MY_GOALS_LLM_API_KEY;
  return new OpenAiCompatibleExtractor({
    baseUrl,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxPromptChars !== undefined ? { maxPromptChars: options.maxPromptChars } : {}),
    ...(options.maxClaims !== undefined ? { maxClaims: options.maxClaims } : {}),
    ...(options.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
}
