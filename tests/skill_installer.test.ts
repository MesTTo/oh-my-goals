import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  installAgentSkill,
  type AgentTarget,
  type SkillInstallScope,
} from "../src/skill_installer.js";

const REPOSITORY_ROOT = resolve(process.cwd());
const CANONICAL_SKILL_ROOT = join(REPOSITORY_ROOT, "skills", "goalchainer");
const TEST_TEMP_PARENT = join(REPOSITORY_ROOT, "ai-tmp");

type ConcreteAgent = Exclude<AgentTarget, "all">;

const EXPECTED_RELATIVE_PATHS = {
  "project:codex": join(".agents", "skills", "goalchainer"),
  "project:claude": join(".claude", "skills", "goalchainer"),
  "project:opencode": join(".opencode", "skills", "goalchainer"),
  "user:codex": join(".agents", "skills", "goalchainer"),
  "user:claude": join(".claude", "skills", "goalchainer"),
  "user:opencode": join(".config", "opencode", "skills", "goalchainer"),
} as const satisfies Record<`${SkillInstallScope}:${ConcreteAgent}`, string>;

interface TestRoots {
  projectRoot: string;
  homeDir: string;
}

interface TreeEntry {
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  contents?: string;
}

let suiteRoot: string;
let testRoot: string;

beforeAll(() => {
  mkdirSync(TEST_TEMP_PARENT, { recursive: true });
  suiteRoot = mkdtempSync(join(TEST_TEMP_PARENT, "skill-installer-suite-"));
});

beforeEach(() => {
  testRoot = mkdtempSync(join(suiteRoot, "case-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
});

function createRoots(): TestRoots {
  const projectRoot = join(testRoot, "project");
  const homeDir = join(testRoot, "home");
  mkdirSync(projectRoot);
  mkdirSync(homeDir);
  return { projectRoot, homeDir };
}

function targetPath(
  roots: TestRoots,
  scope: SkillInstallScope,
  agent: ConcreteAgent,
): string {
  const base = scope === "project" ? roots.projectRoot : roots.homeDir;
  return join(base, EXPECTED_RELATIVE_PATHS[`${scope}:${agent}`]);
}

function readTree(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];

  function walk(directory: string): void {
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = relative(root, path);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink" });
      } else if (stats.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        walk(path);
      } else if (stats.isFile()) {
        entries.push({
          path: relativePath,
          type: "file",
          contents: readFileSync(path).toString("base64"),
        });
      } else {
        entries.push({ path: relativePath, type: "other" });
      }
    }
  }

  walk(root);
  return entries;
}

function expectCanonicalTree(destination: string): void {
  expect(lstatSync(destination).isDirectory()).toBe(true);
  expect(lstatSync(destination).isSymbolicLink()).toBe(false);
  expect(readTree(destination)).toEqual(readTree(CANONICAL_SKILL_ROOT));
}

function installerOptions(
  roots: TestRoots,
  agent: AgentTarget,
  scope: SkillInstallScope,
  force = false,
) {
  return {
    agent,
    scope,
    projectRoot: roots.projectRoot,
    homeDir: roots.homeDir,
    force,
  } as const;
}

async function installProjectCodexSkill(): Promise<{
  roots: TestRoots;
  destination: string;
}> {
  const roots = createRoots();
  const destination = targetPath(roots, "project", "codex");
  await installAgentSkill(installerOptions(roots, "codex", "project"));
  return { roots, destination };
}

const LAYOUTS = [
  ["project", "codex"],
  ["project", "claude"],
  ["project", "opencode"],
  ["user", "codex"],
  ["user", "claude"],
  ["user", "opencode"],
] as const satisfies readonly (readonly [SkillInstallScope, ConcreteAgent])[];

const SNAPSHOT_LIMIT_CASES: readonly (readonly [
  string,
  (destination: string) => void,
  RegExp,
])[] = [
  [
    "file count",
    (destination) => {
      mkdirSync(destination, { recursive: true });
      for (let index = 0; index < 129; index += 1) {
        writeFileSync(join(destination, `file-${index}`), "x");
      }
    },
    /maximum of 128 files/,
  ],
  [
    "directory count",
    (destination) => {
      mkdirSync(destination, { recursive: true });
      for (let index = 0; index < 65; index += 1) {
        mkdirSync(join(destination, `directory-${index}`));
      }
    },
    /maximum of 64 directories/,
  ],
  [
    "directory depth",
    (destination) => {
      mkdirSync(destination, { recursive: true });
      let current = destination;
      for (let index = 0; index < 17; index += 1) {
        current = join(current, `level-${index}`);
        mkdirSync(current);
      }
    },
    /maximum directory depth of 16/,
  ],
  [
    "total bytes",
    (destination) => {
      mkdirSync(destination, { recursive: true });
      const block = Buffer.alloc(900 * 1024, 0x61);
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(join(destination, `block-${index}`), block);
      }
    },
    /exceeds 4194304 total file bytes/,
  ],
];

describe("installAgentSkill", () => {
  it.each(LAYOUTS)("installs the %s %s layout as a real directory", async (scope, agent) => {
    const roots = createRoots();
    const destination = targetPath(roots, scope, agent);

    const result = await installAgentSkill(installerOptions(roots, agent, scope));

    expect(result).toEqual({ installed: [destination], unchanged: [] });
    expectCanonicalTree(destination);
  });

  it.each(["project", "user"] as const)(
    "installs the shared and Claude %s layouts in deterministic order",
    async (scope) => {
      const roots = createRoots();
      const destinations = (["codex", "claude"] as const).map((agent) =>
        targetPath(roots, scope, agent),
      );

      const result = await installAgentSkill(installerOptions(roots, "all", scope));

      expect(result).toEqual({ installed: destinations, unchanged: [] });
      for (const destination of destinations) expectCanonicalTree(destination);
    },
  );

  it("copies supporting metadata and references from the canonical tree", async () => {
    const roots = createRoots();
    const destination = targetPath(roots, "project", "codex");

    await installAgentSkill(installerOptions(roots, "codex", "project"));

    expect(readFileSync(join(destination, "agents", "openai.yaml"))).toEqual(
      readFileSync(join(CANONICAL_SKILL_ROOT, "agents", "openai.yaml")),
    );
    expect(readFileSync(join(destination, "references", "input-schema.md"))).toEqual(
      readFileSync(join(CANONICAL_SKILL_ROOT, "references", "input-schema.md")),
    );
    const instructions = readFileSync(join(destination, "SKILL.md"), "utf8");
    expect(instructions).toContain("confidence `0`");
    expect(instructions).toContain(
      "`automatic_execution_allowed` is true, `selection_tied` is false",
    );
    expectCanonicalTree(destination);
  });

  it("reports a complete byte-identical installation as unchanged", async () => {
    const roots = createRoots();
    const destination = targetPath(roots, "project", "codex");
    await installAgentSkill(installerOptions(roots, "codex", "project"));

    const result = await installAgentSkill(installerOptions(roots, "codex", "project"));

    expect(result).toEqual({ installed: [], unchanged: [destination] });
    expectCanonicalTree(destination);
  });

  it("keeps one canonical tree under concurrent installation attempts", async () => {
    const roots = createRoots();
    const destination = targetPath(roots, "project", "codex");

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        installAgentSkill(installerOptions(roots, "codex", "project")),
      ),
    );

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expectCanonicalTree(destination);
    expect(
      readdirSync(dirname(destination)).filter(
        (name) =>
          name.startsWith(".goalchainer-stage-") ||
          name.startsWith(".goalchainer-backup-"),
      ),
    ).toEqual([]);
  });

  it("refuses a conflicting destination and leaves its contents intact", async () => {
    const roots = createRoots();
    const destination = targetPath(roots, "project", "codex");
    await installAgentSkill(installerOptions(roots, "codex", "project"));
    const changedSkill = "conflicting local skill\n";
    writeFileSync(join(destination, "SKILL.md"), changedSkill);

    await expect(
      installAgentSkill(installerOptions(roots, "codex", "project")),
    ).rejects.toThrow(/already exists with different contents/);

    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toBe(changedSkill);
    expect(
      readdirSync(dirname(destination)).filter((name) =>
        name.startsWith(".goalchainer-stage-"),
      ),
    ).toEqual([]);
  });

  it("force replaces a conflicting tree and removes extra entries", async () => {
    const { roots, destination } = await installProjectCodexSkill();
    writeFileSync(join(destination, "SKILL.md"), "outdated\n");
    writeFileSync(join(destination, "obsolete.txt"), "remove me\n");

    const result = await installAgentSkill(
      installerOptions(roots, "codex", "project", true),
    );

    expect(result).toEqual({ installed: [destination], unchanged: [] });
    expectCanonicalTree(destination);
    expect(existsSync(join(destination, "obsolete.txt"))).toBe(false);
    expect(
      readdirSync(dirname(destination)).filter((name) =>
        name.startsWith(".goalchainer-stage-") ||
        name.startsWith(".goalchainer-backup-"),
      ),
    ).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "treats file modes as part of the canonical installation",
    async () => {
      const roots = createRoots();
      const destination = targetPath(roots, "project", "codex");
      const installedSkill = join(destination, "SKILL.md");
      await installAgentSkill(installerOptions(roots, "codex", "project"));
      chmodSync(installedSkill, 0o600);

      await expect(
        installAgentSkill(installerOptions(roots, "codex", "project")),
      ).rejects.toThrow(/already exists with different contents/);
      await installAgentSkill(installerOptions(roots, "codex", "project", true));

      expect(lstatSync(installedSkill).mode & 0o777).toBe(
        lstatSync(join(CANONICAL_SKILL_ROOT, "SKILL.md")).mode & 0o777,
      );
    },
  );

  it("force replaces a regular file at the destination", async () => {
    const roots = createRoots();
    const destination = targetPath(roots, "project", "codex");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "not a skill tree\n");

    const result = await installAgentSkill(
      installerOptions(roots, "codex", "project", true),
    );

    expect(result).toEqual({ installed: [destination], unchanged: [] });
    expectCanonicalTree(destination);
  });

  it("rejects a non-boolean force value before touching the destination", async () => {
    const roots = createRoots();
    const destination = targetPath(roots, "project", "codex");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "prior skill file\n");

    await expect(
      installAgentSkill({
        ...installerOptions(roots, "codex", "project"),
        force: "false" as unknown as boolean,
      }),
    ).rejects.toThrow("force must be a boolean");

    expect(readFileSync(destination, "utf8")).toBe("prior skill file\n");
  });

  it("snapshots validated options before the first asynchronous filesystem read", async () => {
    const roots = createRoots();
    const redirected = join(testRoot, "redirected");
    mkdirSync(redirected);
    const options = installerOptions(roots, "codex", "project") as any;
    const pending = installAgentSkill(options);
    options.agent = "all";
    options.scope = "user";
    options.projectRoot = redirected;
    options.homeDir = redirected;
    options.force = true;

    await expect(pending).resolves.toEqual({
      installed: [targetPath(roots, "project", "codex")],
      unchanged: [],
    });
    expectCanonicalTree(targetPath(roots, "project", "codex"));
    expect(readTree(redirected)).toEqual([]);
  });

  it("rejects null or blank optional installation roots", async () => {
    const roots = createRoots();
    await expect(
      installAgentSkill({
        ...installerOptions(roots, "codex", "project"),
        projectRoot: null as any,
      }),
    ).rejects.toThrow("projectRoot must be a nonblank string");
    await expect(
      installAgentSkill({
        ...installerOptions(roots, "codex", "user"),
        homeDir: "",
      }),
    ).rejects.toThrow("homeDir must be a nonblank string");
    await expect(
      installAgentSkill({
        ...installerOptions(roots, "codex", "project"),
        projectroot: roots.projectRoot,
      } as any),
    ).rejects.toThrow("Skill installation options contains unknown fields: projectroot");
  });

  it("bounds snapshots of a conflicting destination file", async () => {
    const roots = createRoots();
    const destination = targetPath(roots, "project", "codex");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.alloc(1024 * 1024 + 1, 0x61));

    await expect(
      installAgentSkill(installerOptions(roots, "codex", "project", true)),
    ).rejects.toThrow(/exceeds 1048576 bytes/);

    expect(lstatSync(destination).size).toBe(1024 * 1024 + 1);
  });

  it.each(SNAPSHOT_LIMIT_CASES)(
    "bounds a destination tree by %s",
    async (_label, prepare, expected) => {
      const roots = createRoots();
      const destination = targetPath(roots, "project", "codex");
      prepare(destination);

      await expect(
        installAgentSkill(installerOptions(roots, "codex", "project", true)),
      ).rejects.toThrow(expected);

      expect(lstatSync(destination).isDirectory()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "cleans a forced-replacement backup that contains a read-only directory",
    async () => {
      const { roots, destination } = await installProjectCodexSkill();
      writeFileSync(join(destination, "SKILL.md"), "outdated\n");
      const readOnlyDirectory = join(destination, "references");
      chmodSync(readOnlyDirectory, 0o555);

      try {
        const result = await installAgentSkill(
          installerOptions(roots, "codex", "project", true),
        );
        expect(result).toEqual({ installed: [destination], unchanged: [] });
        expectCanonicalTree(destination);
        expect(
          readdirSync(dirname(destination)).filter((name) =>
            name.startsWith(".goalchainer-backup-"),
          ),
        ).toEqual([]);
      } finally {
        for (const name of readdirSync(dirname(destination))) {
          if (!name.startsWith(".goalchainer-backup-")) continue;
          const retainedReference = join(dirname(destination), name, "goalchainer", "references");
          if (existsSync(retainedReference)) chmodSync(retainedReference, 0o700);
        }
      }
    },
  );

  it("preflights all layouts before exposing any copied tree", async () => {
    const roots = createRoots();
    const conflict = targetPath(roots, "project", "claude");
    mkdirSync(conflict, { recursive: true });
    writeFileSync(join(conflict, "SKILL.md"), "conflict\n");

    await expect(
      installAgentSkill(installerOptions(roots, "all", "project")),
    ).rejects.toThrow(/already exists with different contents/);

    expect(existsSync(targetPath(roots, "project", "codex"))).toBe(false);
    expect(existsSync(targetPath(roots, "project", "opencode"))).toBe(false);
    expect(readFileSync(join(conflict, "SKILL.md"), "utf8")).toBe("conflict\n");
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "rolls back earlier layouts when a later commit fails",
    async () => {
      const roots = createRoots();
      const priorDestination = targetPath(roots, "project", "codex");
      mkdirSync(dirname(priorDestination), { recursive: true });
      writeFileSync(priorDestination, "prior skill file\n");
      chmodSync(priorDestination, 0o666);
      const unwritable = join(roots.projectRoot, ".claude", "skills");
      mkdirSync(unwritable, { recursive: true });
      chmodSync(unwritable, 0o500);
      try {
        await expect(
          installAgentSkill(installerOptions(roots, "all", "project", true)),
        ).rejects.toThrow();
      } finally {
        chmodSync(unwritable, 0o700);
      }

      expect(readFileSync(priorDestination, "utf8")).toBe("prior skill file\n");
      expect(lstatSync(priorDestination).mode & 0o777).toBe(0o666);
      expect(existsSync(targetPath(roots, "project", "claude"))).toBe(false);
      expect(existsSync(targetPath(roots, "project", "opencode"))).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "removes parents created for a fresh target when a later commit fails",
    async () => {
      const roots = createRoots();
      const unwritable = join(roots.projectRoot, ".claude", "skills");
      mkdirSync(unwritable, { recursive: true });
      chmodSync(unwritable, 0o500);
      try {
        await expect(
          installAgentSkill(installerOptions(roots, "all", "project")),
        ).rejects.toThrow();
      } finally {
        chmodSync(unwritable, 0o700);
      }

      expect(existsSync(join(roots.projectRoot, ".agents"))).toBe(false);
      expect(existsSync(targetPath(roots, "project", "claude"))).toBe(false);
    },
  );

  it("rejects a destination symlink even when force is enabled", async () => {
    const roots = createRoots();
    const destination = targetPath(roots, "project", "codex");
    const external = join(testRoot, "external-destination");
    mkdirSync(dirname(destination), { recursive: true });
    mkdirSync(external);
    writeFileSync(join(external, "sentinel.txt"), "unchanged\n");
    symlinkSync(external, destination, "dir");

    await expect(
      installAgentSkill(installerOptions(roots, "codex", "project")),
    ).rejects.toThrow(/destination is a symbolic link/);
    await expect(
      installAgentSkill(installerOptions(roots, "codex", "project", true)),
    ).rejects.toThrow(/destination is a symbolic link/);

    expect(readFileSync(join(external, "sentinel.txt"), "utf8")).toBe("unchanged\n");
    expect(existsSync(join(external, "SKILL.md"))).toBe(false);
  });

  it("rejects a symlinked destination parent instead of traversing it", async () => {
    const roots = createRoots();
    const external = join(testRoot, "external-parent");
    mkdirSync(external);
    symlinkSync(external, join(roots.projectRoot, ".agents"), "dir");

    await expect(
      installAgentSkill(installerOptions(roots, "codex", "project", true)),
    ).rejects.toThrow(/destination parent is a symbolic link/);

    expect(existsSync(join(external, "skills", "goalchainer"))).toBe(false);
  });

  it("rejects symlinks nested inside an existing destination", async () => {
    const roots = createRoots();
    const destination = targetPath(roots, "project", "codex");
    const externalReference = join(testRoot, "external-reference.md");
    await installAgentSkill(installerOptions(roots, "codex", "project"));
    writeFileSync(externalReference, "external\n");
    const installedReference = join(destination, "references", "input-schema.md");
    rmSync(installedReference);
    symlinkSync(externalReference, installedReference, "file");

    await expect(
      installAgentSkill(installerOptions(roots, "codex", "project", true)),
    ).rejects.toThrow(/contains a symbolic link/);

    expect(readFileSync(externalReference, "utf8")).toBe("external\n");
  });
});
