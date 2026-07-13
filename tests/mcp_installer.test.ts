import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerMcpServer, resolveLaunchEnv } from "../src/mcp_installer.js";

const LAUNCH = {
  command: "/usr/bin/node",
  args: ["/opt/oh-my-goals/dist/cli.js", "mcp"],
  env: { OH_MY_GOALS_METTABASE_DIR: "/m", OH_MY_GOALS_HYPERBASE_PYTHON: "/p" },
} as const;

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omg-mcp-inst-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("registerMcpServer for the Claude Code .mcp.json", () => {
  it("creates the project file with a stdio entry", async () => {
    const root = tempRoot();
    const result = await registerMcpServer({
      agent: "claude",
      scope: "project",
      launch: LAUNCH,
      projectRoot: root,
    });

    const path = join(root, ".mcp.json");
    expect(result).toEqual({ registered: [path], unchanged: [], removed: [] });
    const entry = (readJson(path).mcpServers as Record<string, unknown>)["oh-my-goals"];
    expect(entry).toEqual({
      type: "stdio",
      command: "/usr/bin/node",
      args: ["/opt/oh-my-goals/dist/cli.js", "mcp"],
      env: { OH_MY_GOALS_METTABASE_DIR: "/m", OH_MY_GOALS_HYPERBASE_PYTHON: "/p" },
    });
  });

  it("merges into an existing config without disturbing other servers", async () => {
    const root = tempRoot();
    const path = join(root, ".mcp.json");
    writeFileSync(
      path,
      `${JSON.stringify({ mcpServers: { other: { type: "stdio", command: "other" } } }, null, 2)}\n`,
    );

    await registerMcpServer({ agent: "claude", scope: "project", launch: LAUNCH, projectRoot: root });

    const servers = readJson(path).mcpServers as Record<string, unknown>;
    expect(servers.other).toEqual({ type: "stdio", command: "other" });
    expect(servers["oh-my-goals"]).toBeDefined();
  });

  it("is idempotent: a matching entry is left untouched", async () => {
    const root = tempRoot();
    const options = { agent: "claude", scope: "project", launch: LAUNCH, projectRoot: root } as const;
    await registerMcpServer(options);
    const path = join(root, ".mcp.json");
    const before = readFileSync(path, "utf8");

    const again = await registerMcpServer(options);

    expect(again).toEqual({ registered: [], unchanged: [path], removed: [] });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("updates a changed entry and preserves the others", async () => {
    const root = tempRoot();
    const path = join(root, ".mcp.json");
    writeFileSync(
      path,
      `${JSON.stringify({ mcpServers: { other: { command: "keep" }, "oh-my-goals": { command: "stale" } } }, null, 2)}\n`,
    );

    const result = await registerMcpServer({
      agent: "claude",
      scope: "project",
      launch: LAUNCH,
      projectRoot: root,
    });

    expect(result.registered).toEqual([path]);
    const servers = readJson(path).mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.other).toEqual({ command: "keep" });
    expect(servers["oh-my-goals"].command).toBe("/usr/bin/node");
  });

  it("removes only our entry", async () => {
    const root = tempRoot();
    const path = join(root, ".mcp.json");
    writeFileSync(
      path,
      `${JSON.stringify({ mcpServers: { other: { command: "keep" } } }, null, 2)}\n`,
    );
    await registerMcpServer({ agent: "claude", scope: "project", launch: LAUNCH, projectRoot: root });

    const result = await registerMcpServer({
      agent: "claude",
      scope: "project",
      launch: LAUNCH,
      projectRoot: root,
      remove: true,
    });

    expect(result).toEqual({ registered: [], unchanged: [], removed: [path] });
    const servers = readJson(path).mcpServers as Record<string, unknown>;
    expect(servers.other).toEqual({ command: "keep" });
    expect(servers["oh-my-goals"]).toBeUndefined();
  });

  it("reports unchanged when removing an entry that is absent", async () => {
    const root = tempRoot();
    const result = await registerMcpServer({
      agent: "claude",
      scope: "project",
      launch: LAUNCH,
      projectRoot: root,
      remove: true,
    });
    expect(result).toEqual({ registered: [], unchanged: [join(root, ".mcp.json")], removed: [] });
  });

  it("targets ~/.claude.json for user scope", async () => {
    const home = tempRoot();
    const result = await registerMcpServer({
      agent: "claude",
      scope: "user",
      launch: LAUNCH,
      homeDir: home,
    });
    expect(result.registered).toEqual([join(home, ".claude.json")]);
  });
});

describe("registerMcpServer for the Codex config.toml", () => {
  it("appends a table, preserving comments and other tables", async () => {
    const home = tempRoot();
    mkdirSync(join(home, ".codex"));
    const path = join(home, ".codex", "config.toml");
    writeFileSync(path, `# my config\nmodel = "gpt-5.5"\n\n[mcp_servers.keep_me]\ncommand = "keep"\n`);

    const result = await registerMcpServer({ agent: "codex", scope: "user", launch: LAUNCH, homeDir: home });

    expect(result.registered).toEqual([path]);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# my config");
    expect(text).toContain("[mcp_servers.keep_me]");
    expect(text).toContain("[mcp_servers.oh-my-goals]");
    expect(text).toContain('command = "/usr/bin/node"');
    expect(text).toContain('args = ["/opt/oh-my-goals/dist/cli.js", "mcp"]');
    expect(text).toContain('env = { OH_MY_GOALS_METTABASE_DIR = "/m", OH_MY_GOALS_HYPERBASE_PYTHON = "/p" }');
  });

  it("is idempotent for an already-registered table", async () => {
    const home = tempRoot();
    const options = { agent: "codex", scope: "user", launch: LAUNCH, homeDir: home } as const;
    await registerMcpServer(options);
    const path = join(home, ".codex", "config.toml");
    const before = readFileSync(path, "utf8");

    const again = await registerMcpServer(options);

    expect(again.unchanged).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("replaces a changed table in place, keeping the tables around it", async () => {
    const home = tempRoot();
    mkdirSync(join(home, ".codex"));
    const path = join(home, ".codex", "config.toml");
    writeFileSync(
      path,
      `[a]\nx = 1\n\n[mcp_servers.oh-my-goals]\ncommand = "stale"\nargs = ["old"]\n\n[b]\ny = 2\n`,
    );

    const result = await registerMcpServer({ agent: "codex", scope: "user", launch: LAUNCH, homeDir: home });

    expect(result.registered).toEqual([path]);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("[a]");
    expect(text).toContain("[b]");
    expect(text).not.toContain('command = "stale"');
    expect(text).toContain('command = "/usr/bin/node"');
    // our table keeps its position between [a] and [b]
    expect(text.indexOf("[a]")).toBeLessThan(text.indexOf("[mcp_servers.oh-my-goals]"));
    expect(text.indexOf("[mcp_servers.oh-my-goals]")).toBeLessThan(text.indexOf("[b]"));
  });

  it("removes our table, keeping a table that follows it", async () => {
    const home = tempRoot();
    mkdirSync(join(home, ".codex"));
    const path = join(home, ".codex", "config.toml");
    await registerMcpServer({ agent: "codex", scope: "user", launch: LAUNCH, homeDir: home });
    const withTrailer = `${readFileSync(path, "utf8")}\n[b]\ny = 2\n`;
    writeFileSync(path, withTrailer);

    const result = await registerMcpServer({
      agent: "codex",
      scope: "user",
      launch: LAUNCH,
      homeDir: home,
      remove: true,
    });

    expect(result.removed).toEqual([path]);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("[mcp_servers.oh-my-goals]");
    expect(text).toContain("[b]");
    expect(text).toContain("y = 2");
  });

  it("uses .codex/config.toml under the project root for project scope", async () => {
    const root = tempRoot();
    const result = await registerMcpServer({ agent: "codex", scope: "project", launch: LAUNCH, projectRoot: root });
    expect(result.registered).toEqual([join(root, ".codex", "config.toml")]);
  });
});

describe("registerMcpServer for the OpenCode opencode.json", () => {
  it("creates the file with $schema and a local entry", async () => {
    const root = tempRoot();
    const result = await registerMcpServer({ agent: "opencode", scope: "project", launch: LAUNCH, projectRoot: root });

    const path = join(root, "opencode.json");
    expect(result.registered).toEqual([path]);
    const config = readJson(path);
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect((config.mcp as Record<string, unknown>)["oh-my-goals"]).toEqual({
      type: "local",
      command: ["/usr/bin/node", "/opt/oh-my-goals/dist/cli.js", "mcp"],
      enabled: true,
      environment: { OH_MY_GOALS_METTABASE_DIR: "/m", OH_MY_GOALS_HYPERBASE_PYTHON: "/p" },
    });
  });

  it("does not add $schema to an existing file that lacks it", async () => {
    const root = tempRoot();
    const path = join(root, "opencode.json");
    writeFileSync(path, `${JSON.stringify({ mcp: { keep: { type: "local", command: ["k"] } } }, null, 2)}\n`);

    await registerMcpServer({ agent: "opencode", scope: "project", launch: LAUNCH, projectRoot: root });

    const config = readJson(path);
    expect(config.$schema).toBeUndefined();
    expect((config.mcp as Record<string, unknown>).keep).toBeDefined();
    expect((config.mcp as Record<string, unknown>)["oh-my-goals"]).toBeDefined();
  });

  it("targets ~/.config/opencode/opencode.json for user scope", async () => {
    const home = tempRoot();
    const result = await registerMcpServer({ agent: "opencode", scope: "user", launch: LAUNCH, homeDir: home });
    expect(result.registered).toEqual([join(home, ".config", "opencode", "opencode.json")]);
  });
});

describe("registerMcpServer agent selection and env", () => {
  it("registers codex and claude for agent 'all', leaving opencode alone", async () => {
    const root = tempRoot();
    const result = await registerMcpServer({ agent: "all", scope: "project", launch: LAUNCH, projectRoot: root });

    expect([...result.registered].sort()).toEqual(
      [join(root, ".codex", "config.toml"), join(root, ".mcp.json")].sort(),
    );
    expect(existsSync(join(root, "opencode.json"))).toBe(false);
  });

  it("omits env keys when the launch carries none", async () => {
    const root = tempRoot();
    await registerMcpServer({
      agent: "claude",
      scope: "project",
      launch: { command: "/usr/bin/node", args: ["mcp"], env: {} },
      projectRoot: root,
    });
    const entry = (readJson(join(root, ".mcp.json")).mcpServers as Record<string, Record<string, unknown>>)[
      "oh-my-goals"
    ];
    expect(entry.env).toBeUndefined();
  });

  it("resolveLaunchEnv propagates only the recognized non-empty keys", () => {
    expect(
      resolveLaunchEnv({
        OH_MY_GOALS_METTABASE_DIR: "/m",
        OH_MY_GOALS_HYPERBASE_PYTHON: "",
        OH_MY_GOALS_EMBEDDING: "BGE",
        UNRELATED: "x",
      } as NodeJS.ProcessEnv),
    ).toEqual({ OH_MY_GOALS_METTABASE_DIR: "/m", OH_MY_GOALS_EMBEDDING: "BGE" });
  });
});

describe("registerMcpServer safety", () => {
  it("rejects a config path that is a symbolic link", async () => {
    const root = tempRoot();
    symlinkSync(join(root, "elsewhere.json"), join(root, ".mcp.json"));
    await expect(
      registerMcpServer({ agent: "claude", scope: "project", launch: LAUNCH, projectRoot: root }),
    ).rejects.toThrow(/symbolic link/);
  });

  it("rejects an existing config that is not valid JSON", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".mcp.json"), "{ not json");
    await expect(
      registerMcpServer({ agent: "claude", scope: "project", launch: LAUNCH, projectRoot: root }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("rejects an existing config that is a JSON array", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".mcp.json"), "[]");
    await expect(
      registerMcpServer({ agent: "claude", scope: "project", launch: LAUNCH, projectRoot: root }),
    ).rejects.toThrow(/not a JSON object/);
  });

  it("preserves an existing config file's permission mode", async () => {
    const root = tempRoot();
    const path = join(root, ".mcp.json");
    writeFileSync(path, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, { mode: 0o640 });
    await registerMcpServer({ agent: "claude", scope: "project", launch: LAUNCH, projectRoot: root });
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it("rejects an unknown agent and an unknown scope", async () => {
    const root = tempRoot();
    await expect(
      registerMcpServer({ agent: "vim" as never, scope: "project", launch: LAUNCH, projectRoot: root }),
    ).rejects.toThrow(/Unsupported agent/);
    await expect(
      registerMcpServer({ agent: "claude", scope: "global" as never, launch: LAUNCH, projectRoot: root }),
    ).rejects.toThrow(/Unsupported mcp installation scope/);
  });

  it("rejects a malformed launch", async () => {
    const root = tempRoot();
    await expect(
      registerMcpServer({ agent: "claude", scope: "project", launch: { command: "", args: [], env: {} }, projectRoot: root }),
    ).rejects.toThrow(/command must be a nonblank string/);
  });
});
