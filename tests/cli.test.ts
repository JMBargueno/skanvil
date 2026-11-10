/**
 * End-to-end tests of the real CLI: argument parsing, exit codes, text and JSON output.
 * The CLI is bundled by tests/setup/build-cli.ts and run as a child process without a TTY.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { CLI_BUILD_DIR } from "./setup/build-cli.js";

const CLI = path.join(CLI_BUILD_DIR, "cli.js");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function skanvil(args: string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function json<T = unknown>(run: Run): T {
  return JSON.parse(run.stdout) as T;
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skanvil-cli-"));
}

/** Creates a library with one front skill and returns its root. */
function library(): string {
  const dir = tmp();
  expect(skanvil(["init", "lib", "--no-git", "--no-agent-skill"], dir).code).toBe(0);
  const root = path.join(dir, "lib");
  expect(skanvil(["add", "--type", "front", "--name", "a", "--description", "A"], root).code).toBe(0);
  return root;
}

describe("program", () => {
  test("no arguments prints help and exits 1", () => {
    const run = skanvil([], tmp());
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/Usage: skanvil/);
  });

  test("--version prints the package version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    expect(skanvil(["--version"], tmp()).stdout.trim()).toBe(pkg.version);
  });

  test("unknown options and commands fail with exit 1", () => {
    expect(skanvil(["add", "--bogus"], tmp())).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/unknown option/)
    });
    expect(skanvil(["nope"], tmp()).code).toBe(1);
  });

  test("errors are reported as 'skanvil: <message>'", () => {
    const run = skanvil(["list"], tmp());
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^skanvil: No skills\/ folder found/);
  });
});

describe("library workflow", () => {
  test("init, add, edit, list and validate", () => {
    const dir = tmp();
    const init = skanvil(["init", "lib", "--no-git", "--json"], dir);
    expect(init.code).toBe(0);
    expect(json<{ name: string; agentSkill: { status: string }[] }>(init)).toMatchObject({
      name: "lib",
      agentSkill: [{ status: "installed" }]
    });
    const root = path.join(dir, "lib");

    const add = skanvil(
      ["add", "--type", "back", "--name", "Queue Worker", "--description", "Runs jobs", "--json"],
      root
    );
    expect(json(add)).toMatchObject({ skillName: "back-queue-worker", type: "back" });

    expect(skanvil(["edit", "back-queue-worker", "--rename", "worker"], root).code).toBe(0);
    expect(json(skanvil(["list", "--json"], root))).toEqual([
      { name: "back-worker", type: "back", indexed: true, valid: true, description: "Runs jobs." }
    ]);

    const validate = skanvil(["validate", "--json"], root);
    expect(validate.code).toBe(0);
    expect(json(validate)).toMatchObject({ ok: true, errors: 0, warnings: 1, count: 1 });
  });

  test("validate --strict fails on warnings; --skill filters", () => {
    const root = library();
    expect(skanvil(["validate"], root).code).toBe(0);
    const strict = skanvil(["validate", "--strict"], root);
    expect(strict.code).toBe(1);
    expect(strict.stderr).toMatch(/template-unchanged/);
    expect(json(skanvil(["validate", "--json", "--skill", "nope"], root))).toMatchObject({ diagnostics: [] });
  });

  test("add without a TTY and missing options explains what to pass", () => {
    const run = skanvil(["add", "--type", "front"], library());
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/Provide --type, --name and --description/);
  });

  test("edit --remove refuses without --yes when there is no TTY", () => {
    const root = library();
    const refused = skanvil(["edit", "front-a", "--remove"], root);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/Re-run with --yes/);
    expect(fs.existsSync(path.join(root, "skills", "front-a"))).toBe(true);

    expect(skanvil(["edit", "front-a", "--remove", "--yes"], root).code).toBe(0);
    expect(fs.existsSync(path.join(root, "skills", "front-a"))).toBe(false);
  });

  test("index --check detects drift and index repairs it", () => {
    const root = library();
    expect(skanvil(["index", "--check"], root).code).toBe(0);
    const readme = path.join(root, "README.md");
    fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace(/- A\n[\s\S]*?front-a`\n/, ""));
    expect(skanvil(["index", "--check"], root).code).toBe(1);
    expect(skanvil(["index"], root).code).toBe(0);
    expect(skanvil(["index", "--check", "--json"], root)).toMatchObject({ code: 0 });
  });

  test("doctor exits 1 while errors remain and 0 after --fix", () => {
    const root = library();
    const file = path.join(root, "skills", "front-a", "SKILL.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("name: front-a", "name: wrong"));
    expect(skanvil(["doctor"], root)).toMatchObject({ code: 1 });
    const fixed = skanvil(["doctor", "--fix", "--json"], root);
    expect(fixed.code).toBe(0);
    expect(json<{ fixes: string[] }>(fixed).fixes).toEqual(["front-a: set frontmatter name to the folder name"]);
  });
});

describe("sync and install-skill", () => {
  test("sync --dry-run --json reports the plan without writing", () => {
    const root = library();
    const project = tmp();
    const run = skanvil(["sync", project, "--target", "claude,copilot", "--dry-run", "--json"], root);
    expect(run.code).toBe(0);
    expect(json(run)).toMatchObject({
      dryRun: true,
      mode: "copy",
      results: [
        { target: "claude", added: ["front-a"] },
        { target: "copilot", added: ["front-a"] }
      ]
    });
    expect(fs.existsSync(path.join(project, ".claude"))).toBe(false);
  });

  test("sync rejects targets outside the destination and --global with a destination", () => {
    const root = library();
    const project = tmp();
    expect(skanvil(["sync", project, "--target", "../outside"], root).stderr).toMatch(/must be a folder inside/);
    expect(skanvil(["sync", project, "--global"], root).stderr).toMatch(/together with --global/);
  });

  test("install-skill exits 1 when a foreign skanvil folder blocks a target", () => {
    const project = tmp();
    expect(skanvil(["install-skill", "--target", "claude"], project).code).toBe(0);
    fs.mkdirSync(path.join(project, ".agents", "skills", "skanvil"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agents", "skills", "skanvil", "SKILL.md"), "---\nname: skanvil\n---\n");

    const run = skanvil(["install-skill", "--target", "claude,agents", "--json"], project);
    expect(run.code).toBe(1);
    expect(json<{ status: string }[]>(run).map((result) => result.status)).toEqual(["unchanged", "skipped"]);
  });

  test("install-skill --global writes into the home folder", () => {
    const home = tmp();
    const result = spawnSync(process.execPath, [CLI, "install-skill", "--global", "--target", "claude"], {
      cwd: tmp(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" }
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "skanvil", "SKILL.md"))).toBe(true);
  });
});
