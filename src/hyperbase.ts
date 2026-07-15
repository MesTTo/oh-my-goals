// HyperBase ingestion: parse English statements into typed Semantic-Hypergraph
// trees with the real local AlphaBeta parser, then judge each parse.
//
// The parser is a Python process built on spaCy en_core_web_trf and a DistilBERT
// atomizer. Loading those costs several seconds and a few GB of RSS, so the
// adapter drives a resident worker (assets/hb_worker.py) over line-framed JSON
// and keeps it warm. The worker emits raw parse facts; this module recovers
// speech-act mood and polarity, decides source coverage over content tokens, and
// runs the quality gate. Every atom the worker returns is validated here before
// it can reach MeTTa.
//
// The parser is an optional local integration, not a bundled dependency: the
// shipped package carries only the worker script. Point the adapter at a
// mettabase checkout and its Python interpreter through config or the
// OH_MY_GOALS_METTABASE_DIR / OH_MY_GOALS_HYPERBASE_PYTHON environment
// variables. When it is not configured or the model is missing, the adapter
// fails closed with a clear installation error rather than falling back to a
// shallow renderer.

import { delimiter as pathDelimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertDenseArray, assertPlainRecord } from "./records.js";
import { ResidentJsonTransport, type SpawnSpec } from "./subprocess_worker.js";

// The nine controlled-English rules the instruction layer asks agents to follow.
// A rejected parse is returned to the agent with these as rewrite guidance.
export const CONTROLLED_ENGLISH_CONTRACT: readonly string[] = [
  "Write one asserted proposition per sentence.",
  "Use explicit entity names and stable identifiers.",
  "Avoid pronouns and vague references.",
  "Preserve code symbols, file names, tests, and commands exactly.",
  'Nested complements introduced by "that" are allowed.',
  "Separate observations, goals, norms, hypotheses, and conclusions.",
  "Do not state an agent hypothesis as an observed fact.",
  "Do not combine several independent claims with coordination.",
  "Attach source and scope through the MCP fields, not invented prose.",
];

// Atom main types the classifier emits (C P M B T J) plus the two types inferred
// on a non-atom edge from its connector (R relation, S specifier). A node whose
// main type is outside this set is malformed worker output.
const MAIN_TYPES: ReadonlySet<string> = new Set(["C", "P", "M", "B", "T", "J", "R", "S"]);

const DEFAULT_LANG = "en";
const DEFAULT_MAX_PARSE_TIME_SECONDS = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_TREE_DEPTH = 64;

const DEFAULT_WORKER_SCRIPT = fileURLToPath(
  new URL("../assets/hb_worker.py", import.meta.url),
);

export type SpeechActMood = "declarative" | "interrogative" | "imperative";
export type Polarity = "affirmative" | "negated";

/** One slash-typed atom, e.g. `requires/Pv.so` or `index%2ejs/Cc`. */
export interface ShAtom {
  readonly atom: true;
  /** Canonical serialization, e.g. `requires/Pv.so`. */
  readonly atomStr: string;
  /** Lemma or text, lowercased and possibly percent-encoded (`index%2ejs`). */
  readonly root: string;
  /** Decoded display form of the root (`index.js`), casing still lost. */
  readonly label: string;
  /** First role character: C P M B T J. */
  readonly mainType: string;
  /** Full atom type, e.g. `Pv`, `Cc`, `Mn`. */
  readonly type: string;
  /** Role string, e.g. `Pv.so`. */
  readonly role: string;
}

/** A non-atom edge: a connector applied to one or more argument nodes. */
export interface ShEdge {
  readonly atom: false;
  /** Canonical serialization of the whole subtree. */
  readonly edgeStr: string;
  /** Inferred main type: R S C M B J (from the connector). */
  readonly mainType: string;
  /** Inferred full type, e.g. `Rv`, `Sx`, `Cc`, or bare `C`. */
  readonly type: string;
  /** Connector argument roles, e.g. `so`, or empty. */
  readonly argroles: string;
  readonly connector: ShNode;
  readonly children: readonly ShNode[];
}

export type ShNode = ShAtom | ShEdge;

/** Which input tokens the parse tree accounts for. */
export interface SourceCoverage {
  readonly nTokens: number;
  readonly coveredPositions: readonly number[];
  readonly uncoveredPositions: readonly number[];
  readonly uncoveredTokens: readonly string[];
  /** Every token carrying a letter or digit is covered; punctuation may not be. */
  readonly contentComplete: boolean;
}

/** One parse of one sentence, with the adapter's interpretation attached. */
export interface HyperbaseParse {
  /** The sentence text the parser worked on. */
  readonly text: string;
  /** spaCy tokens, verbatim, casing preserved (unlike the lowercased atoms). */
  readonly tokens: readonly string[];
  /** Graphbrain SH notation string. */
  readonly sh: string;
  /** Typed MeTTa projection, `(sh (tag ...) ...)`, stored as the memory tree. */
  readonly typedMetta: string;
  /** Untyped MeTTa mirror, atoms kept as `requires/Pv.so`. */
  readonly rawMetta: string;
  readonly tree: ShNode;
  readonly rootType: string;
  readonly rootMainType: string;
  readonly rootArgroles: string;
  /** Recovered here from punctuation and argument roles; the parser drops it. */
  readonly mood: SpeechActMood;
  /** Negated when an `Mn` modifier appears anywhere in the tree. */
  readonly polarity: Polarity;
  /** Roots of any `Ci` interrogative-concept atoms, e.g. `["which"]`. */
  readonly interrogativeConcepts: readonly string[];
  readonly coverage: SourceCoverage;
  /** Correctness diagnostics from the parser; empty object when clean. */
  readonly diagnostics: Readonly<Record<string, unknown>>;
  readonly failed: boolean;
  readonly errors: readonly string[];
}

/** Whether a statement parsed into a single faithful proposition. */
export interface QualityReceipt {
  readonly accepted: boolean;
  /** Machine-readable rejection codes, most specific first. */
  readonly reasons: readonly string[];
  /** Guidance returned to the agent on rejection, else null. */
  readonly rewriteFeedback: string | null;
}

/** The parse result for one input statement. */
export interface HyperbaseParseItem {
  readonly input: string;
  readonly nParses: number;
  readonly parses: readonly HyperbaseParse[];
  readonly quality: QualityReceipt;
  /** Set when the parser threw for this sentence. */
  readonly error: string | null;
}

export interface HyperbaseParseBatch {
  readonly parser: string;
  readonly spacyModel: string;
  readonly items: readonly HyperbaseParseItem[];
}

export interface AvailabilityReport {
  readonly available: boolean;
  readonly parser?: string;
  readonly spacyModel?: string;
  readonly error?: string;
}

/** An English-to-SH parser the memory layer can ingest through. */
export interface HyperbaseParser {
  parse(statements: readonly string[]): Promise<HyperbaseParseBatch>;
  probe(): Promise<AvailabilityReport>;
  close(): Promise<void>;
}

export interface AlphaBetaConfig {
  /** Python interpreter with spaCy, torch, transformers, and the models. */
  readonly pythonPath?: string;
  /** mettabase checkout; sets PYTHONPATH `<dir>/src:<dir>/lib` and the cwd. */
  readonly mettabaseDir?: string;
  /** Worker script path; defaults to the packaged assets/hb_worker.py. */
  readonly workerScript?: string;
  readonly lang?: string;
  /** Per-sub-sentence parse budget in seconds; 0 disables it. */
  readonly maxParseTimeSeconds?: number;
  /** Wall-clock budget for one request, covering the cold model load. */
  readonly requestTimeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

/** Raised when the parser is not configured or its model is unavailable. */
export class HyperbaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HyperbaseUnavailableError";
  }
}

/** Raised when the worker crashes, times out, or returns a failure. */
export class HyperbaseWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HyperbaseWorkerError";
  }
}

interface ResolvedConfig {
  readonly pythonPath: string;
  readonly mettabaseDir: string;
  readonly workerScript: string;
  readonly lang: string;
  readonly maxParseTimeSeconds: number;
  readonly requestTimeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
}

function resolveConfig(config: AlphaBetaConfig): ResolvedConfig | { error: string } {
  const pythonPath = config.pythonPath ?? process.env.OH_MY_GOALS_HYPERBASE_PYTHON;
  const mettabaseDir = config.mettabaseDir ?? process.env.OH_MY_GOALS_METTABASE_DIR;
  const missing: string[] = [];
  if (pythonPath === undefined || pythonPath.trim() === "") {
    missing.push("a Python interpreter (pythonPath or OH_MY_GOALS_HYPERBASE_PYTHON)");
  }
  if (mettabaseDir === undefined || mettabaseDir.trim() === "") {
    missing.push("a mettabase directory (mettabaseDir or OH_MY_GOALS_METTABASE_DIR)");
  }
  if (missing.length > 0) {
    return {
      error: `HyperBase parser is not configured: set ${missing.join(" and ")}.`,
    };
  }
  return {
    pythonPath: pythonPath!,
    mettabaseDir: mettabaseDir!,
    workerScript:
      config.workerScript ?? process.env.OH_MY_GOALS_HYPERBASE_WORKER ?? DEFAULT_WORKER_SCRIPT,
    lang: config.lang ?? DEFAULT_LANG,
    maxParseTimeSeconds: config.maxParseTimeSeconds ?? DEFAULT_MAX_PARSE_TIME_SECONDS,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    env: config.env ?? {},
  };
}

function childEnv(config: ResolvedConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...config.env,
    PYTHONPATH: [join(config.mettabaseDir, "src"), join(config.mettabaseDir, "lib")].join(
      pathDelimiter,
    ),
    TOKENIZERS_PARALLELISM: "false",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };
}

function requireString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new HyperbaseWorkerError(`worker payload field ${key} must be a string`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  assertDenseArray(value, field);
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new HyperbaseWorkerError(`${field}[${index}] must be a string`);
    }
    return entry;
  });
}

function normalizeTree(value: unknown, depth: number): ShNode {
  if (depth > MAX_TREE_DEPTH) {
    throw new HyperbaseWorkerError("worker tree exceeds the maximum depth");
  }
  assertPlainRecord(value, "worker tree node");
  const mainType = requireString(value, "main_type");
  if (!MAIN_TYPES.has(mainType)) {
    throw new HyperbaseWorkerError(`worker tree node has unknown main type ${mainType}`);
  }
  if (value.atom === true) {
    return {
      atom: true,
      atomStr: requireString(value, "atom_str"),
      root: requireString(value, "root"),
      label: requireString(value, "label"),
      mainType,
      type: requireString(value, "type"),
      role: requireString(value, "role"),
    };
  }
  if (value.atom !== false) {
    throw new HyperbaseWorkerError("worker tree node is missing the atom flag");
  }
  assertDenseArray(value.children, "worker tree node children");
  if (value.children.length === 0) {
    throw new HyperbaseWorkerError("worker edge node has no children");
  }
  return {
    atom: false,
    edgeStr: requireString(value, "edge_str"),
    mainType,
    type: requireString(value, "type"),
    argroles: requireString(value, "argroles"),
    connector: normalizeTree(value.connector, depth + 1),
    children: value.children.map((child) => normalizeTree(child, depth + 1)),
  };
}

/** A token with no letter or digit is punctuation and need not be covered. */
function isPunctuationToken(token: string): boolean {
  return !/[\p{L}\p{N}]/u.test(token);
}

function normalizeCoverage(
  value: unknown,
  tokens: readonly string[],
): SourceCoverage {
  assertPlainRecord(value, "worker coverage");
  const covered = value.covered_positions;
  const uncovered = value.uncovered_positions;
  assertDenseArray(covered, "coverage.covered_positions");
  assertDenseArray(uncovered, "coverage.uncovered_positions");
  const uncoveredPositions = uncovered.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isInteger(entry)) {
      throw new HyperbaseWorkerError(`coverage.uncovered_positions[${index}] must be an integer`);
    }
    return entry;
  });
  const uncoveredTokens = uncoveredPositions.map((position) => tokens[position] ?? "");
  return {
    nTokens: tokens.length,
    coveredPositions: covered.map((entry, index) => {
      if (typeof entry !== "number" || !Number.isInteger(entry)) {
        throw new HyperbaseWorkerError(`coverage.covered_positions[${index}] must be an integer`);
      }
      return entry;
    }),
    uncoveredPositions,
    uncoveredTokens,
    contentComplete: uncoveredTokens.every(isPunctuationToken),
  };
}

/** Trailing `?` marks a question; a subjectless object-taking relation is an
 * imperative; everything else is a declarative assertion. The parser tags every
 * root predicate `Pv`, so mood cannot be read off the predicate subtype. */
function deriveMood(text: string, rootMainType: string, rootArgroles: string): SpeechActMood {
  if (text.trimEnd().endsWith("?")) return "interrogative";
  if (rootMainType === "R" && rootArgroles.includes("o") && !rootArgroles.includes("s")) {
    return "imperative";
  }
  return "declarative";
}

function walkAtoms(node: ShNode, visit: (atom: ShAtom) => void): void {
  if (node.atom) {
    visit(node);
    return;
  }
  walkAtoms(node.connector, visit);
  for (const child of node.children) walkAtoms(child, visit);
}

function treeHasNegation(tree: ShNode): boolean {
  let negated = false;
  walkAtoms(tree, (atom) => {
    if (atom.type === "Mn") negated = true;
  });
  return negated;
}

function interrogativeConcepts(tree: ShNode): readonly string[] {
  const roots: string[] = [];
  walkAtoms(tree, (atom) => {
    if (atom.type === "Ci") roots.push(atom.root);
  });
  return roots;
}

function normalizeParse(value: unknown): HyperbaseParse {
  assertPlainRecord(value, "worker parse");
  const text = requireString(value, "text");
  const tokens = optionalStringArray(value.tokens, "worker parse tokens");
  const tree = normalizeTree(value.tree, 0);
  const rootMainType = requireString(value, "root_main_type");
  const rootArgroles = requireString(value, "root_argroles");
  const diagnosticsValue = value.diagnostics;
  let diagnostics: Readonly<Record<string, unknown>> = {};
  if (diagnosticsValue !== null && diagnosticsValue !== undefined) {
    assertPlainRecord(diagnosticsValue, "worker parse diagnostics");
    diagnostics = diagnosticsValue;
  }
  return {
    text,
    tokens,
    sh: requireString(value, "sh"),
    typedMetta: requireString(value, "typed_metta"),
    rawMetta: requireString(value, "raw_metta"),
    tree,
    rootType: requireString(value, "root_type"),
    rootMainType,
    rootArgroles,
    mood: deriveMood(text, rootMainType, rootArgroles),
    polarity: treeHasNegation(tree) ? "negated" : "affirmative",
    interrogativeConcepts: interrogativeConcepts(tree),
    coverage: normalizeCoverage(value.coverage, tokens),
    diagnostics,
    failed: value.failed === true,
    errors: optionalStringArray(value.errors, "worker parse errors"),
  };
}

const REJECTION_MESSAGES: Readonly<Record<string, string>> = {
  "parser-error": "the parser raised an error on this statement",
  "empty-parse": "the statement produced no parse",
  "multiple-clauses": "the statement split into more than one clause",
  "parse-failed": "the parser reported a failed parse",
  "structural-diagnostics": "the parse has structural or token-matching errors",
  "no-root-relation": "the statement is not a single asserted proposition",
  "incomplete-coverage": "part of the statement was not accounted for by the parse",
};

/** Append the controlled-English contract to a rejection message as guidance. */
export function appendContract(message: string): string {
  return [
    message,
    "Rewrite it more simply without changing its meaning, following the controlled-English contract:",
    ...CONTROLLED_ENGLISH_CONTRACT.map((rule) => `  - ${rule}`),
  ].join("\n");
}

function buildRewriteFeedback(input: string, reasons: readonly string[]): string {
  const explained = reasons.map((code) => REJECTION_MESSAGES[code] ?? code).join("; ");
  return appendContract(
    `The statement "${input}" was not a faithful single proposition (${explained}).`,
  );
}

function evaluateQuality(
  input: string,
  error: string | null,
  nParses: number,
  parses: readonly HyperbaseParse[],
): QualityReceipt {
  const reasons: string[] = [];
  if (error !== null) {
    reasons.push("parser-error");
  } else if (nParses === 0) {
    reasons.push("empty-parse");
  } else if (nParses > 1) {
    reasons.push("multiple-clauses");
  } else {
    const parse = parses[0]!;
    if (parse.failed || parse.errors.length > 0) reasons.push("parse-failed");
    if (Object.keys(parse.diagnostics).length > 0) reasons.push("structural-diagnostics");
    if (parse.tree.atom || parse.tree.mainType !== "R") reasons.push("no-root-relation");
    if (!parse.coverage.contentComplete) reasons.push("incomplete-coverage");
  }
  const accepted = reasons.length === 0;
  return {
    accepted,
    reasons,
    rewriteFeedback: accepted ? null : buildRewriteFeedback(input, reasons),
  };
}

function normalizeItem(value: unknown): HyperbaseParseItem {
  assertPlainRecord(value, "worker result");
  const input = requireString(value, "input");
  if (typeof value.error === "string") {
    return {
      input,
      nParses: 0,
      parses: [],
      quality: evaluateQuality(input, value.error, 0, []),
      error: value.error,
    };
  }
  const rawParses = value.parses;
  assertDenseArray(rawParses, "worker result parses");
  const parses = rawParses.map((parse) => normalizeParse(parse));
  const nParses = typeof value.n_parses === "number" ? value.n_parses : parses.length;
  return {
    input,
    nParses,
    parses,
    quality: evaluateQuality(input, null, nParses, parses),
    error: null,
  };
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Drives the resident AlphaBeta worker over a serialized line-framed protocol. */
export class AlphaBetaHyperbaseParser implements HyperbaseParser {
  readonly #resolution: ResolvedConfig | { error: string };
  readonly #transport: ResidentJsonTransport;
  #pending: PendingRequest[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(config: AlphaBetaConfig = {}) {
    assertPlainRecord(config, "hyperbase config");
    this.#resolution = resolveConfig(config);
    this.#transport = new ResidentJsonTransport(
      () => this.#spawnSpec(),
      () => new HyperbaseUnavailableError("HyperBase parser is closed"),
      this.#onLine.bind(this),
      this.#onWorkerError.bind(this),
    );
  }

  async parse(statements: readonly string[]): Promise<HyperbaseParseBatch> {
    assertDenseArray(statements, "statements");
    for (const [index, statement] of statements.entries()) {
      if (typeof statement !== "string") {
        throw new TypeError(`statements[${index}] must be a string`);
      }
    }
    const config = this.#requireConfig();
    const response = await this.#request({
      op: "parse",
      sentences: [...statements],
      lang: config.lang,
      max_parse_time: config.maxParseTimeSeconds,
    });
    if (response.ok !== true) {
      throw new HyperbaseWorkerError(workerFailure(response));
    }
    const rawResults = response.results;
    assertDenseArray(rawResults, "worker results");
    return {
      parser: typeof response.parser === "string" ? response.parser : "alphabeta",
      spacyModel: typeof response.spacy_model === "string" ? response.spacy_model : "",
      items: rawResults.map((result) => normalizeItem(result)),
    };
  }

  async probe(): Promise<AvailabilityReport> {
    if ("error" in this.#resolution) {
      return { available: false, error: this.#resolution.error };
    }
    try {
      const response = await this.#request({ op: "probe", lang: this.#resolution.lang });
      if (response.ok !== true) {
        return { available: false, error: workerFailure(response) };
      }
      const spacyModel = typeof response.spacy_model === "string" ? response.spacy_model : "";
      if (spacyModel === "") {
        return { available: false, error: "worker reported no spaCy model" };
      }
      return {
        available: true,
        parser: typeof response.parser === "string" ? response.parser : "alphabeta",
        spacyModel,
      };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    await this.#transport.close();
  }

  #requireConfig(): ResolvedConfig {
    if ("error" in this.#resolution) {
      throw new HyperbaseUnavailableError(this.#resolution.error);
    }
    return this.#resolution;
  }

  #spawnSpec(): SpawnSpec {
    const config = this.#requireConfig();
    return {
      command: config.pythonPath,
      args: [config.workerScript],
      cwd: config.mettabaseDir,
      env: childEnv(config),
    };
  }

  #request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = this.#queue.then(
      () => this.#sendOne(payload),
      () => this.#sendOne(payload),
    );
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #sendOne(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const config = this.#requireConfig();
      const request: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#drop(request);
          this.#transport.kill();
          reject(
            new HyperbaseWorkerError(
              `HyperBase worker timed out after ${config.requestTimeoutMs} ms`,
            ),
          );
        }, config.requestTimeoutMs),
      };
      this.#pending.push(request);
      try {
        this.#transport.writeJson(payload);
      } catch (error) {
        this.#drop(request);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #onLine(line: string): void {
    if (line.trim() === "") return;
    const request = this.#pending.shift();
    if (request === undefined) return;
    clearTimeout(request.timer);
    try {
      const parsed = JSON.parse(line) as unknown;
      assertPlainRecord(parsed, "worker response");
      request.resolve(parsed);
    } catch (error) {
      request.reject(
        new HyperbaseWorkerError(
          `worker produced non-JSON output: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  #onWorkerError(reason: string): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(new HyperbaseWorkerError(`HyperBase ${reason}`));
    }
  }

  #drop(target: PendingRequest): void {
    this.#pending = this.#pending.filter((request) => request !== target);
    clearTimeout(target.timer);
  }
}

function workerFailure(response: Record<string, unknown>): string {
  const error = typeof response.error === "string" ? response.error : "unknown worker failure";
  return `HyperBase worker failed: ${error}`;
}

/** Create the default AlphaBeta-backed parser. */
export function createHyperbaseParser(config: AlphaBetaConfig = {}): HyperbaseParser {
  return new AlphaBetaHyperbaseParser(config);
}
