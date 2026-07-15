import { fileURLToPath } from "node:url";

import {
  type ParsedPaper,
  type ParsedReference,
  type ParsedSection,
  type ResearchWorker,
  ResearchWorkerError,
  type RetractionRecord,
  type WorkMetadata,
} from "./research.js";
import { assertDenseArray, assertPlainRecord } from "./records.js";
import { ResidentJsonTransport, type SpawnSpec } from "./subprocess_worker.js";

const DEFAULT_WORKER_SCRIPT = fileURLToPath(
  new URL("../assets/research_worker.py", import.meta.url),
);
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

export interface ResearchWorkerConfig {
  readonly pythonPath?: string;
  readonly workerScript?: string;
  readonly grobidUrl?: string;
  readonly crossrefEmail?: string;
  readonly s2ApiKey?: string;
}

interface ResolvedConfig {
  readonly pythonPath: string;
  readonly workerScript: string;
  readonly grobidUrl?: string;
  readonly crossrefEmail?: string;
  readonly s2ApiKey?: string;
}

interface PendingRequest {
  readonly id: number;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  readonly timer: NodeJS.Timeout;
}

function resolveConfig(config: ResearchWorkerConfig): ResolvedConfig | { error: string } {
  const pythonPath = config.pythonPath ?? process.env.OH_MY_GOALS_RESEARCH_PYTHON;
  if (pythonPath === undefined || pythonPath.trim() === "") {
    return {
      error:
        "research worker is not configured: set a Python interpreter (pythonPath or OH_MY_GOALS_RESEARCH_PYTHON).",
    };
  }
  return {
    pythonPath,
    workerScript: config.workerScript ?? DEFAULT_WORKER_SCRIPT,
    grobidUrl: config.grobidUrl ?? process.env.OH_MY_GOALS_GROBID_URL,
    crossrefEmail: config.crossrefEmail ?? process.env.OH_MY_GOALS_CROSSREF_EMAIL,
    s2ApiKey: config.s2ApiKey ?? process.env.OH_MY_GOALS_S2_API_KEY,
  };
}

function childEnv(config: ResolvedConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.grobidUrl !== undefined) env.OH_MY_GOALS_GROBID_URL = config.grobidUrl;
  if (config.crossrefEmail !== undefined) {
    env.OH_MY_GOALS_CROSSREF_EMAIL = config.crossrefEmail;
  }
  if (config.s2ApiKey !== undefined) env.OH_MY_GOALS_S2_API_KEY = config.s2ApiKey;
  return env;
}

function requireString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new ResearchWorkerError(`worker payload field ${key} must be a string`);
  }
  return value;
}

function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ResearchWorkerError(`worker payload field ${key} must be a string`);
  }
  return value;
}

function optionalNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ResearchWorkerError(`worker payload field ${key} must be a finite number`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  assertDenseArray(value, field);
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new ResearchWorkerError(`${field}[${index}] must be a string`);
    }
    return entry;
  });
}

function normalizeMetadata(value: unknown): WorkMetadata {
  assertPlainRecord(value, "worker metadata");
  const title = requireString(value, "title");
  return {
    title,
    ...(optionalString(value, "doi") !== undefined ? { doi: optionalString(value, "doi") } : {}),
    ...(optionalString(value, "arxivId") !== undefined
      ? { arxivId: optionalString(value, "arxivId") }
      : {}),
    ...(optionalString(value, "openAlexId") !== undefined
      ? { openAlexId: optionalString(value, "openAlexId") }
      : {}),
    ...(optionalString(value, "semanticScholarId") !== undefined
      ? { semanticScholarId: optionalString(value, "semanticScholarId") }
      : {}),
    ...(optionalStringArray(value.authors, "worker metadata authors") !== undefined
      ? { authors: optionalStringArray(value.authors, "worker metadata authors") }
      : {}),
    ...(optionalNumber(value, "year") !== undefined ? { year: optionalNumber(value, "year") } : {}),
    ...(optionalString(value, "venue") !== undefined
      ? { venue: optionalString(value, "venue") }
      : {}),
    ...(optionalString(value, "abstract") !== undefined
      ? { abstract: optionalString(value, "abstract") }
      : {}),
    ...(optionalString(value, "pdfUrl") !== undefined
      ? { pdfUrl: optionalString(value, "pdfUrl") }
      : {}),
  };
}

function normalizeSection(value: unknown): ParsedSection {
  assertPlainRecord(value, "worker section");
  return {
    heading: requireString(value, "heading"),
    text: requireString(value, "text"),
  };
}

function normalizeReference(value: unknown): ParsedReference {
  assertPlainRecord(value, "worker reference");
  const title = optionalString(value, "title");
  const doi = optionalString(value, "doi");
  return {
    raw: requireString(value, "raw"),
    ...(title !== undefined ? { title } : {}),
    ...(doi !== undefined ? { doi } : {}),
  };
}

function normalizePaper(value: unknown): ParsedPaper {
  assertPlainRecord(value, "worker parsed paper");
  assertDenseArray(value.sections, "worker sections");
  assertDenseArray(value.references, "worker references");
  return {
    metadata: normalizeMetadata(value.metadata),
    sections: value.sections.map((section) => normalizeSection(section)),
    references: value.references.map((reference) => normalizeReference(reference)),
  };
}

function normalizeRetractionRecord(value: unknown): RetractionRecord {
  assertPlainRecord(value, "worker retraction record");
  const status = requireString(value, "status");
  if (
    status !== "active" &&
    status !== "retracted" &&
    status !== "corrected" &&
    status !== "concern" &&
    status !== "withdrawn"
  ) {
    throw new ResearchWorkerError(`worker returned an unknown retraction status: ${status}`);
  }
  const notice = optionalString(value, "notice");
  const date = optionalString(value, "date");
  return {
    doi: requireString(value, "doi"),
    status,
    ...(notice !== undefined ? { notice } : {}),
    ...(date !== undefined ? { date } : {}),
  };
}

function workerFailure(response: Record<string, unknown>): string {
  const error = typeof response.error === "string" ? response.error : "unknown worker failure";
  return `research worker failed: ${error}`;
}

/** Drives the resident paper acquisition worker over line-framed JSON. */
export class PythonResearchWorker implements ResearchWorker {
  readonly #resolution: ResolvedConfig | { error: string };
  readonly #transport: ResidentJsonTransport;
  #pending = new Map<number, PendingRequest>();
  #nextId = 1;

  constructor(config: ResearchWorkerConfig = {}) {
    assertPlainRecord(config, "research worker config");
    this.#resolution = resolveConfig(config);
    this.#transport = new ResidentJsonTransport(
      () => this.#spawnSpec(),
      () => new ResearchWorkerError("research worker is closed"),
      this.#onLine.bind(this),
      this.#onWorkerError.bind(this),
    );
  }

  async fetchAndParse(id: string): Promise<ParsedPaper> {
    if (typeof id !== "string" || id.trim() === "") {
      throw new TypeError("paper id must be a nonblank string");
    }
    const response = await this.#request({ command: "fetch_and_parse", ref: id });
    if (response.ok !== true) {
      throw new ResearchWorkerError(workerFailure(response));
    }
    return normalizePaper(response.result);
  }

  async retractionStatus(dois: readonly string[]): Promise<readonly RetractionRecord[]> {
    assertDenseArray(dois, "dois");
    for (const [index, doi] of dois.entries()) {
      if (typeof doi !== "string" || doi.trim() === "") {
        throw new TypeError(`dois[${index}] must be a nonblank string`);
      }
    }
    const response = await this.#request({
      command: "retraction_status",
      dois: [...dois],
    });
    if (response.ok !== true) {
      throw new ResearchWorkerError(workerFailure(response));
    }
    assertDenseArray(response.result, "worker retraction result");
    return response.result.map((record) => normalizeRetractionRecord(record));
  }

  async close(): Promise<void> {
    const closing = this.#transport.close();
    const pending = this.#pending;
    this.#pending = new Map();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new ResearchWorkerError("research worker is closed"));
    }
    await closing;
  }

  #requireConfig(): ResolvedConfig {
    if ("error" in this.#resolution) {
      throw new ResearchWorkerError(this.#resolution.error);
    }
    return this.#resolution;
  }

  #spawnSpec(): SpawnSpec {
    const config = this.#requireConfig();
    return { command: config.pythonPath, args: [config.workerScript], env: childEnv(config) };
  }

  #request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId;
      this.#nextId += 1;
      const request: PendingRequest = {
        id,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#drop(id);
          this.#transport.kill();
          reject(
            new ResearchWorkerError(
              `research worker timed out after ${DEFAULT_REQUEST_TIMEOUT_MS} ms`,
            ),
          );
        }, DEFAULT_REQUEST_TIMEOUT_MS),
      };
      this.#pending.set(id, request);
      try {
        this.#transport.writeJson({ id, ...payload });
      } catch (error) {
        this.#drop(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #onLine(line: string): void {
    if (line.trim() === "") return;
    try {
      const parsed = JSON.parse(line) as unknown;
      assertPlainRecord(parsed, "worker response");
      const id = parsed.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw new ResearchWorkerError("worker response is missing an integer id");
      }
      const request = this.#pending.get(id);
      if (request === undefined) return;
      this.#pending.delete(id);
      clearTimeout(request.timer);
      request.resolve(parsed);
    } catch (error) {
      this.#rejectFirstPending(
        new ResearchWorkerError(
          `worker produced non-JSON output: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  #onWorkerError(reason: string): void {
    const pending = this.#pending;
    this.#pending = new Map();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new ResearchWorkerError(`research ${reason}`));
    }
  }

  #rejectFirstPending(error: ResearchWorkerError): void {
    const first = this.#pending.values().next();
    if (first.done === true) return;
    const request = first.value;
    this.#pending.delete(request.id);
    clearTimeout(request.timer);
    request.reject(error);
  }

  #drop(id: number): void {
    const request = this.#pending.get(id);
    if (request !== undefined) clearTimeout(request.timer);
    this.#pending.delete(id);
  }
}

export function createResearchWorker(config: ResearchWorkerConfig = {}): ResearchWorker {
  return new PythonResearchWorker(config);
}
