// Call-time executable resolution shared by live SWI-Prolog entry points.

import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

/** Resolve a command before an async boundary can change cwd or PATH. */
export function resolvePrologExecutable(command = "swipl"): string {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const candidates = isAbsolute(command) || hasPathSeparator
    ? [resolve(command)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter((entry) => entry !== "")
        .flatMap((entry) => extensions.map((extension) => resolve(entry, command + extension)));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  throw new Error(`Prolog executable was not found or is not executable: ${command}`);
}
