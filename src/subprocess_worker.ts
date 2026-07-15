// Shared lifecycle for a resident child process that exchanges line-framed JSON
// over stdio. The HyperBase parser and the research worker both spawn a Python
// worker this way and differ only in how they correlate responses to requests
// (the parser by order, the research worker by id), so the process lifecycle
// lives here and each worker keeps its own correlation.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

/** How to launch the worker process. */
export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
}

/** The callbacks a worker wires onto its child: one per stdout line, one per
 * stderr chunk, and one for a spawn error or exit, with a human-readable reason. */
export interface WorkerHandlers {
  onLine(line: string): void;
  onStderr(chunk: string): void;
  onExit(child: ChildProcessWithoutNullStreams, reason: string): void;
}

const DEFAULT_STDERR_TAIL_LINES = 40;

/** Spawn the worker and wire its stdout reader, stderr capture, and exit paths.
 * Returns the child and the readline interface so the caller can track both. */
export function spawnWorker(
  spec: SpawnSpec,
  handlers: WorkerHandlers,
): { child: ChildProcessWithoutNullStreams; reader: ReadlineInterface } {
  const child = spawn(spec.command, [...spec.args], {
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => handlers.onStderr(chunk));
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => handlers.onLine(line));
  child.on("error", (error) => handlers.onExit(child, `spawn failed: ${error.message}`));
  child.on("exit", (code, signal) =>
    handlers.onExit(child, `worker exited (code ${code ?? "null"}, signal ${signal ?? "null"})`),
  );
  return { child, reader };
}

/** End the worker gracefully, escalating to SIGKILL if it does not exit. A child
 * that is already gone is a no-op. */
export async function terminateWorker(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.stdin.end();
    child.kill("SIGTERM");
  });
}

/** A bounded, most-recent-lines view of a worker's stderr, so an exit can report
 * the last diagnostics the worker printed. */
export class StderrTail {
  #lines: string[] = [];
  constructor(private readonly maxLines: number) {}

  push(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      this.#lines.push(line);
    }
    if (this.#lines.length > this.maxLines) {
      this.#lines = this.#lines.slice(-this.maxLines);
    }
  }

  reset(): void {
    this.#lines = [];
  }

  /** The tail as a leading-newline block, or an empty string when nothing was seen. */
  context(): string {
    return this.#lines.length > 0 ? `\n${this.#lines.join("\n")}` : "";
  }
}

/** Owns a resident line-framed JSON subprocess and reports worker failures to
 * the caller's request-correlation layer. */
export class ResidentJsonTransport {
  #child: ChildProcessWithoutNullStreams | null = null;
  #reader: ReadlineInterface | null = null;
  #stderr: StderrTail;
  #closed = false;

  constructor(
    private readonly spawnSpec: () => SpawnSpec,
    private readonly closedError: () => Error,
    private readonly onLine: (line: string) => void,
    private readonly onError: (reason: string) => void,
    stderrTailLines = DEFAULT_STDERR_TAIL_LINES,
  ) {
    this.#stderr = new StderrTail(stderrTailLines);
  }

  ensure(): ChildProcessWithoutNullStreams {
    if (this.#closed) {
      throw this.closedError();
    }
    if (this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null) {
      return this.#child;
    }
    this.#stderr.reset();
    const { child, reader } = spawnWorker(this.spawnSpec(), {
      onLine: (line) => this.onLine(line),
      onStderr: (chunk) => this.#stderr.push(chunk),
      onExit: (exited, reason) => this.#onExit(exited, reason),
    });
    this.#child = child;
    this.#reader = reader;
    return child;
  }

  writeJson(payload: Readonly<Record<string, unknown>>): void {
    this.ensure().stdin.write(`${JSON.stringify(payload)}\n`);
  }

  detach(): ChildProcessWithoutNullStreams | null {
    const child = this.#child;
    this.#child = null;
    this.#reader?.close();
    this.#reader = null;
    return child;
  }

  kill(): void {
    this.detach()?.kill("SIGKILL");
  }

  async close(): Promise<void> {
    this.#closed = true;
    await terminateWorker(this.detach());
  }

  #onExit(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.#child === child) {
      this.detach();
    }
    this.onError(`${reason}${this.#stderr.context()}`);
  }
}
