// Command line interface. Ports the goalchainer CLI commands to @metta-ts.

import { runValidation } from "./validate.js";
import { solveIncident } from "./pipeline.js";
import { deriveIncident } from "./snars.js";
import { runDirective } from "./directive.js";
import { runMotivation, runDecision } from "./cli_support.js";
import { DEFAULT_INCIDENT_REQUEST } from "./scenarios.js";

// Stable, sorted JSON to mirror Python's json.dumps(indent=2, sort_keys=True).
function sortedJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function parseArgs(argv: string[]): { command: string; json: boolean; request: string } {
  const command = argv[0] ?? "";
  let json = false;
  let request = DEFAULT_INCIDENT_REQUEST;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--request") request = argv[++i] ?? request;
  }
  return { command, json, request };
}

export function main(argv: string[]): number {
  const { command, request } = parseArgs(argv);
  switch (command) {
    case "validate": {
      const report = runValidation();
      console.log(sortedJson(report));
      return report.passed ? 0 : 1;
    }
    case "solve":
      console.log(sortedJson(solveIncident(request)));
      return 0;
    case "snars":
      console.log(sortedJson(deriveIncident(request)));
      return 0;
    case "motivation":
      console.log(sortedJson(runMotivation(request)));
      return 0;
    case "directive":
      console.log(sortedJson(runDirective(request)));
      return 0;
    case "decision":
    case "demo":
      console.log(sortedJson(runDecision(request)));
      return 0;
    default:
      console.error(
        "usage: goalchainer-ts <validate|solve|snars|motivation|directive|decision> [--request <text>] [--json]",
      );
      return 2;
  }
}

main(process.argv.slice(2));
