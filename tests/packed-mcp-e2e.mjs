// Phase 8 release verification: drive the packed MCP artifact through the full
// exit-criterion loop. This packs the tarball, installs it into an isolated
// consumer, spawns the consumer's `oh-my-goals mcp` binary over stdio, and runs
// installation, natural-language query, problem solving, retraction, purge, and
// restart persistence against the real HyperBase parser and the real SQLite store.
//
// It needs the local parser, so it is gated: without OH_MY_GOALS_METTABASE_DIR and
// OH_MY_GOALS_HYPERBASE_PYTHON it prints a skip and exits 0. CI runs the parser-free
// gates; this is the deep local proof that the shipped artifact works end to end.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const CANARY = "ZZQCANARY7788XK";

if (!process.env.OH_MY_GOALS_METTABASE_DIR || !process.env.OH_MY_GOALS_HYPERBASE_PYTHON) {
  console.log(
    "packed-mcp-e2e SKIPPED: set OH_MY_GOALS_METTABASE_DIR and OH_MY_GOALS_HYPERBASE_PYTHON to run the packed-artifact loop.",
  );
  process.exit(0);
}

const CALL_TIMEOUT_MS = 90_000;

function structured(result) {
  assert.equal(result.isError ?? false, false, `tool error: ${result.content?.[0]?.text ?? "unknown"}`);
  return result.structuredContent ?? {};
}

// Call a tool with a hard deadline and a progress line, so a stalled parser or
// transport fails the run with a precise location instead of hanging forever.
async function call(client, name, args, label) {
  const started = Date.now();
  const result = await Promise.race([
    client.callTool({ name, arguments: args }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${CALL_TIMEOUT_MS}ms at "${label}"`)), CALL_TIMEOUT_MS);
      timer.unref();
    }),
  ]);
  console.log(`  ${label} (${Date.now() - started}ms)`);
  return result;
}

async function main() {
  const work = mkdtempSync(join(ROOT, "ai-tmp", "packed-mcp-e2e-"));
  const dbPath = join(work, "memory.db");
  let client;
  try {
    // Pack the tarball (prepack builds it) and install it into a fresh consumer.
    const packs = join(work, "packs");
    const consumer = join(work, "consumer");
    mkdirSync(packs);
    mkdirSync(consumer);
    const packed = JSON.parse(
      spawnSync(NPM, ["pack", "--json", "--pack-destination", packs], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      }).stdout,
    )[0];
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "packed-mcp-e2e-consumer", version: "1.0.0", private: true }),
    );
    const install = spawnSync(
      NPM,
      ["install", join(packs, packed.filename), "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: consumer, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    assert.equal(install.status, 0, `consumer install failed: ${install.stderr}`);
    const bin = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "oh-my-goals.cmd" : "oh-my-goals");

    // Installation: the packed CLI registers a launchable server entry.
    const registered = JSON.parse(
      spawnSync(bin, ["install-mcp", "--agent", "claude", "--project-root", consumer], {
        cwd: consumer,
        encoding: "utf8",
      }).stdout,
    );
    assert.equal(registered.registered.length, 1, "packed install-mcp registered the server");
    const entry = JSON.parse(readFileSync(join(consumer, ".mcp.json"), "utf8")).mcpServers["oh-my-goals"];
    assert.equal(entry.args.at(-1), "mcp");

    const childEnv = {
      ...process.env,
      OH_MY_GOALS_MEMORY_DB: dbPath,
      OH_MY_GOALS_REPOSITORY: "packed-e2e",
    };
    const open = async () => {
      const transport = new StdioClientTransport({ command: bin, args: ["mcp"], env: childEnv, cwd: consumer });
      const client = new Client({ name: "packed-e2e", version: "0.0.0" });
      await client.connect(transport);
      return client;
    };
    const remember = (client, statements, scope, kind, label, extra = {}) =>
      call(client, "remember", { statements, scope, kind, source: { type: "user", reference: "e2e" }, ...extra }, label);

    console.log("connecting to the packed server");
    client = await open();

    // Tool discovery: the packed server exposes the whole surface.
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["explain", "forget", "query", "remember", "revise", "solve"]);

    // Store the goal and two candidate actions through the real parser.
    const goal = structured(
      await remember(client, ["The user requires that the public API remains compatible."], "project", "goal", "remember goal"),
    );
    assert.equal(goal.results[0].stored, true, "goal stored");
    const goalId = goal.results[0].id;
    for (const [sentence, label] of [
      ["Action upgrade_database updates the database package directly.", "remember action upgrade_database"],
      ["Action patch_adapter updates the database package behind an adapter.", "remember action patch_adapter"],
    ]) {
      const stored = structured(await remember(client, [sentence], "project", "action", label));
      assert.equal(stored.results[0].stored, true, `action stored: ${sentence}`);
    }

    // Natural-language query runs and returns a structured receipt.
    const query = structured(
      await call(client, "query", { question: "Which action updates the database package?", scope: "project" }, "query"),
    );
    assert(Array.isArray(query.answers), "query returns an answers array");

    // Problem solving: rank the actions, then derive a conflict and re-solve.
    const before = structured(await call(client, "solve", { scope: "project" }, "solve (initial)"));
    const ranked = before.decisions.map((d) => d.actionId);
    assert(ranked.includes("upgrade_database"), "upgrade_database is ranked");
    assert(!before.blockedActionIds.includes("upgrade_database"), "upgrade starts unblocked");

    // The tool observation is a transient session fact; the conclusion computed
    // from it goes in the shared "derived" scope. A project solve reads "derived"
    // alongside its own scope, so the conflict blocks the action across scopes.
    const obs = structured(
      await remember(client, ["The test auth_refresh fails after action upgrade_database."], "session", "observation", "remember observation"),
    );
    const obsId = obs.results[0].id;
    const conflict = structured(
      await remember(
        client,
        ["Action upgrade_database conflicts with the authentication constraint."],
        "derived",
        "derived-conclusion",
        "derive conflict",
        { premises: [obsId] },
      ),
    );
    assert.equal(conflict.results[0].active, true, "derived conflict is active");
    const blocked = structured(await call(client, "solve", { scope: "project" }, "solve (with conflict)"));
    assert(blocked.blockedActionIds.includes("upgrade_database"), "the derived conflict blocks upgrade_database");

    // Retraction: dropping the observation invalidates the conflict's proof and
    // restores the earlier decision.
    structured(await call(client, "forget", { propositionIds: [obsId], mode: "retract" }, "forget (retract observation)"));
    const restored = structured(await call(client, "solve", { scope: "project" }, "solve (after retract)"));
    assert(
      !restored.blockedActionIds.includes("upgrade_database"),
      "retracting the observation restores upgrade_database",
    );

    // Purge: a canary proposition is scrubbed from the durable store.
    const canary = structured(
      await remember(client, [`The deployment uses the key ${CANARY}.`], "session", "observation", "remember canary"),
    );
    assert.equal(canary.results[0].stored, true, "canary stored");
    const canaryId = canary.results[0].id;
    structured(await call(client, "forget", { propositionIds: [canaryId], mode: "purge" }, "forget (purge canary)"));
    const gone = await call(client, "explain", { id: canaryId }, "explain (purged canary)");
    assert.equal(gone.isError, true, "purged proposition is no longer explainable");

    console.log("closing the first server");
    await client.close();

    // The canary text is absent from the database and its journals.
    for (const file of readdirSync(work).filter((name) => name.startsWith("memory.db"))) {
      assert(
        !readFileSync(join(work, file)).includes(CANARY),
        `canary text survived in ${file}`,
      );
    }

    // Restart persistence: a fresh server on the same store keeps the memory.
    console.log("restarting on the same store");
    client = await open();
    const afterRestart = structured(await call(client, "solve", { scope: "project" }, "solve (after restart)"));
    assert(
      afterRestart.decisions.map((d) => d.actionId).includes("upgrade_database"),
      "memory survives a server restart",
    );
    const explained = structured(await call(client, "explain", { id: goalId }, "explain (after restart)"));
    assert.equal(explained.active, true, "the goal is still active after restart");
    await client.close();

    console.log("packed-mcp-e2e passed: install, NL query, solving, retraction, purge, and restart from the packed artifact.");
  } finally {
    // Close the transport before deleting the tree. A thrown assertion leaves the
    // server (and its parser child) alive holding our stdio pipe; close reaps them.
    try {
      await client?.close();
    } catch {
      // Already gone or mid-shutdown; nothing to reap.
    }
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
