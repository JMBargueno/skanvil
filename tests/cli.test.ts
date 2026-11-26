/**
 * End-to-end tests of the real CLI: argument parsing, exit codes, text and JSON output.
 * The CLI is bundled by tests/setup/build-cli.ts and run as a child process without a TTY.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

  test("the wizard refuses to run without a terminal", () => {
    const run = skanvil(["wizard"], tmp());
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/needs an interactive terminal/);
  });

  test("init --target sets the sync targets and where the agent skill goes", () => {
    const dir = tmp();
    expect(skanvil(["init", "lib", "--no-git", "--target", "copilot,agents"], dir).code).toBe(0);
    const rc = JSON.parse(fs.readFileSync(path.join(dir, "lib", ".skanvilrc.json"), "utf8"));
    expect(rc.sync.targets).toEqual(["copilot", "agents"]);
    expect(fs.existsSync(path.join(dir, "lib", ".github", "skills", "skanvil"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "lib", ".agents", "skills", "skanvil"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "lib", ".claude"))).toBe(false);
    expect(skanvil(["init", "other", "--target", "../escape"], dir).stderr).toMatch(/must be a folder inside/);
    expect(fs.existsSync(path.join(dir, "other"))).toBe(false);
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
    expect(json<{ name: string; agentSkill: { skill: string; status: string }[] }>(init)).toMatchObject({
      name: "lib",
      agentSkill: [
        { skill: "skanvil", status: "installed" },
        { skill: "skanvil-feedback", status: "installed" }
      ]
    });
    const root = path.join(dir, "lib");

    const add = skanvil(
      [
        "add",
        "--type",
        "back",
        "--name",
        "Queue Worker",
        "--description",
        "Runs background queue workers safely. Use when modifying async jobs.",
        "--json"
      ],
      root
    );
    expect(json(add)).toMatchObject({ skillName: "back-queue-worker", type: "back" });

    expect(
      skanvil(["edit", "back-queue-worker", "--rename", "worker", "--owner", "@infra", "--status", "active"], root).code
    ).toBe(0);
    expect(json(skanvil(["list", "--status", "active", "--owner", "@infra", "--json"], root))).toEqual([
      {
        name: "back-worker",
        type: "back",
        indexed: true,
        valid: true,
        status: "active",
        owner: "@infra",
        description: "Runs background queue workers safely. Use when modifying async jobs."
      }
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

describe("parametrized skills and build (bundled CLI)", () => {
  function parametrized(): string {
    const root = library();
    const dir = path.join(root, "skills", "front-a");
    fs.writeFileSync(
      path.join(dir, "params.json"),
      JSON.stringify({ tracker: { type: "enum", values: ["github", "jira"], default: "github" } })
    );
    const file = path.join(dir, "SKILL.md");
    const section = [
      "Track work in {{tracker}}.",
      '{{#if tracker == "jira"}}',
      "Use keys.",
      "{{/if}}",
      "",
      "## Output Format"
    ];
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("## Output Format", section.join("\n")));
    return root;
  }

  test("build generates importable exports from the bundled CLI", async () => {
    const root = parametrized();
    const run = skanvil(["build", "--json"], root);
    expect(run.code).toBe(0);
    expect(json<{ skills: { exportName: string; params: string[] }[] }>(run).skills).toEqual([
      expect.objectContaining({ exportName: "a", params: ["tracker"] })
    ]);
    const mod = await import(pathToFileURL(path.join(root, "dist", "index.mjs")).href);
    expect(mod.a({ tracker: "jira" })).toContain("Track work in jira.\nUse keys.\n");
    expect(mod.a()).toContain("Track work in github.\n\n## Output Format");
  });

  test("sync --param renders installed skills and rejects unknown names", () => {
    const root = parametrized();
    const project = tmp();
    expect(skanvil(["sync", project, "--param", "tracker=jira"], root).code).toBe(0);
    const installed = fs.readFileSync(path.join(project, ".claude", "skills", "front-a", "SKILL.md"), "utf8");
    expect(installed).toContain("Track work in jira.\nUse keys.\n");
    const bad = skanvil(["sync", project, "--param", "nope=1"], root);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Unknown parameter(s) nope");
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
    expect(json<{ skill: string; status: string }[]>(run).map((result) => `${result.skill}:${result.status}`)).toEqual([
      "skanvil:unchanged",
      "skanvil-feedback:unchanged",
      "skanvil:skipped",
      "skanvil-feedback:installed"
    ]);
  });

  test("init and install-skill support --no-feedback", () => {
    const dir = tmp();
    expect(skanvil(["init", "lib", "--no-git", "--no-feedback"], dir).code).toBe(0);
    expect(fs.existsSync(path.join(dir, "lib", ".claude", "skills", "skanvil", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "lib", ".claude", "skills", "skanvil-feedback"))).toBe(false);

    const project = tmp();
    expect(skanvil(["install-skill", "--no-feedback", "--target", "claude"], project).code).toBe(0);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "skanvil", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "skanvil-feedback"))).toBe(false);
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
    expect(fs.existsSync(path.join(home, ".claude", "skills", "skanvil-feedback", "SKILL.md"))).toBe(true);
  });
});

describe("stats, eval and deprecation CLI", () => {
  test("stats, eval triggers, eval export and sync --include-deprecated work end-to-end", () => {
    const dir = tmp();
    expect(skanvil(["init", "lib", "--no-git", "--no-agent-skill"], dir).code).toBe(0);
    const root = path.join(dir, "lib");

    expect(
      skanvil(
        [
          "add",
          "--type",
          "front",
          "--name",
          "a11y",
          "--description",
          "Audits React components for WCAG ARIA labels. Use when reviewing UI modals."
        ],
        root
      ).code
    ).toBe(0);
    expect(
      skanvil(
        [
          "add",
          "--type",
          "back",
          "--name",
          "sql",
          "--description",
          "Audits Postgres SQL migrations for index lock risks. Use when adding migrations."
        ],
        root
      ).code
    ).toBe(0);

    fs.writeFileSync(
      path.join(root, "skills", "front-a11y", "evals.json"),
      JSON.stringify({
        triggers: {
          shouldTrigger: [{ prompt: "Check React WCAG ARIA labels", split: "eval" }],
          shouldNotTrigger: [{ prompt: "Audit Postgres SQL migrations", split: "eval" }]
        },
        cases: [
          {
            id: "a11y-case",
            split: "eval",
            prompt: "Audit Modal.tsx",
            expected: ["Identifies keyboard trap"]
          }
        ]
      })
    );

    const statsRun = skanvil(["stats", "--sort", "tokens", "--json"], root);
    expect(statsRun.code).toBe(0);
    expect(json<{ count: number; totals: { alwaysLoadedTokens: number } }>(statsRun)).toMatchObject({
      count: 2,
      totals: { alwaysLoadedTokens: expect.any(Number) }
    });

    const evalRun = skanvil(["eval", "triggers", "--split", "eval", "--strict", "--json"], root);
    expect(evalRun.code).toBe(0);
    expect(json<{ ok: boolean; passed: number; failed: number }>(evalRun)).toMatchObject({
      ok: true,
      passed: 2,
      failed: 0
    });

    const outPath = path.join(tmp(), "promptfoo.json");
    const exportRun = skanvil(["eval", "export", "--format", "promptfoo", "--ablation", "--out", outPath], root);
    expect(exportRun.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(outPath, "utf8")).prompts).toHaveLength(2);

    expect(skanvil(["edit", "back-sql", "--status", "deprecated", "--replaced-by", "front-a11y"], root).code).toBe(0);
    const project = tmp();
    const sync1 = skanvil(["sync", project, "--json"], root);
    expect(sync1.code).toBe(0);
    expect(
      json<{ results: { added: string[]; skipped: { skill: string }[]; alwaysLoadedTokens: number }[] }>(sync1)
        .results[0]
    ).toMatchObject({
      added: ["front-a11y"],
      skipped: [{ skill: "back-sql" }],
      alwaysLoadedTokens: expect.any(Number)
    });

    const sync2 = skanvil(["sync", project, "--include-deprecated", "--json"], root);
    expect(sync2.code).toBe(0);
    expect(json<{ results: { added: string[] }[] }>(sync2).results[0].added).toEqual(["back-sql"]);

    // Restore back-sql active status and verify eval route + feedback CLI commands.
    expect(skanvil(["edit", "back-sql", "--status", "active"], root).code).toBe(0);
    const routeRun = skanvil(["eval", "route", "Audit Postgres SQL migrations", "--top", "2", "--json"], root);
    expect(routeRun.code).toBe(0);
    expect(json<{ candidates: { skill: string; rank: number }[] }>(routeRun).candidates[0]).toMatchObject({
      skill: "back-sql",
      rank: 1
    });

    const feedbackLog = path.join(root, ".skanvil-feedback.jsonl");
    fs.writeFileSync(
      feedbackLog,
      `${JSON.stringify({
        skill: "back-sql",
        step: "Step 1",
        symptom: "Missed CONCURRENTLY index warning",
        proposedFix: "Check CREATE INDEX CONCURRENTLY",
        suggestedEvalCase: {
          id: "concurrent-index",
          prompt: "Review migration adding index on orders",
          expected: ["Flags missing CONCURRENTLY"]
        }
      })}\n`
    );

    const fbList = skanvil(["feedback", "list", "--json"], root);
    expect(fbList.code).toBe(0);
    expect(json<{ totalEntries: number; groups: { skill: string }[] }>(fbList)).toMatchObject({
      totalEntries: 1,
      groups: [{ skill: "back-sql" }]
    });

    const fbPromote = skanvil(["feedback", "promote", "--prune", "--json"], root);
    expect(fbPromote.code).toBe(0);
    expect(json<{ promoted: { skill: string; id: string }[]; prunedLines: number }>(fbPromote)).toMatchObject({
      promoted: [{ skill: "back-sql", id: "concurrent-index" }],
      prunedLines: 1
    });
    expect(fs.existsSync(path.join(root, "skills", "back-sql", "evals.json"))).toBe(true);
  });

  test("validate --format github|sarif and doctor --fix --scaffold-sections work end-to-end", () => {
    const dir = tmp();
    expect(skanvil(["init", "lib", "--no-git", "--no-agent-skill"], dir).code).toBe(0);
    const root = path.join(dir, "lib");
    expect(
      skanvil(
        [
          "add",
          "--type",
          "front",
          "--name",
          "ci",
          "--description",
          "Checks frontend CI pipelines cleanly. Use when configuring CI workflows."
        ],
        root
      ).code
    ).toBe(0);

    const skillFile = path.join(root, "skills", "front-ci", "SKILL.md");
    const bodyWithoutRecovery = fs
      .readFileSync(skillFile, "utf8")
      .replace(/## Error Recovery[\s\S]*?(?=## Output Format)/, "");
    fs.writeFileSync(skillFile, bodyWithoutRecovery);

    const gh = skanvil(["validate", "--format", "github"], root);
    expect(gh.code).toBe(1);
    expect(gh.stdout).toContain("::error file=skills/front-ci/SKILL.md,line=1,title=required-sections::");

    const sarif = skanvil(["validate", "--format", "sarif"], root);
    expect(sarif.code).toBe(1);
    expect(JSON.parse(sarif.stdout).version).toBe("2.1.0");

    expect(skanvil(["validate", "--format", "bogus"], root).code).toBe(1);

    const docRun = skanvil(["doctor", "--fix", "--scaffold-sections", "--json"], root);
    expect(docRun.code).toBe(0);
    expect(json<{ ok: boolean; fixes: string[] }>(docRun).fixes).toContain(
      "front-ci: scaffolded missing section '## Error Recovery'"
    );
  });

  test("sync supports cursor, opencode, windsurf, gemini presets and git+file --from", () => {
    const dir = tmp();
    expect(skanvil(["init", "lib", "--no-git", "--no-agent-skill"], dir).code).toBe(0);
    const repo = path.join(dir, "lib");
    expect(
      skanvil(
        [
          "add",
          "--type",
          "front",
          "--name",
          "preset-check",
          "--description",
          "Checks presets cleanly across agents. Use when syncing across multiple tools."
        ],
        repo
      ).code
    ).toBe(0);

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Skanvil Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Skanvil Test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    };
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, env: gitEnv });

    const project = tmp();
    const spec = `git+${pathToFileURL(repo).href}`;
    const res = skanvil(
      ["sync", project, "--from", spec, "--target", "cursor,opencode,windsurf,gemini", "--link", "--json"],
      tmp()
    );
    expect(res.code).toBe(0);
    const payload = json<{ mode: string; results: { target: string; warnings: string[] }[] }>(res);
    expect(payload.mode).toBe("copy");
    expect(payload.results.map((r) => r.target)).toEqual(["cursor", "opencode", "windsurf", "gemini"]);
    expect(payload.results[0].warnings).toContain("temporary Git source cannot be linked; copied instead");
    expect(fs.existsSync(path.join(project, ".cursor", "skills", "front-preset-check", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".opencode", "skills", "front-preset-check", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".windsurf", "skills", "front-preset-check", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".gemini", "skills", "front-preset-check", "SKILL.md"))).toBe(true);
  });

  test("import and diff CLI commands work end-to-end", () => {
    const dir = tmp();
    expect(skanvil(["init", "lib", "--no-git", "--no-agent-skill"], dir).code).toBe(0);
    const root = path.join(dir, "lib");

    const ext = path.join(tmp(), "external-skill");
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(
      path.join(ext, "SKILL.md"),
      [
        "---",
        "name: custom-a11y",
        "description: Audits accessible button labels. Use when reviewing UI controls.",
        "---",
        "",
        "## Objective",
        "",
        "Audit UI controls.",
        "",
        "## When to Activate This Skill",
        "",
        "- Use when reviewing buttons.",
        "",
        "## Instructions",
        "",
        "1. Check button text and ARIA roles.",
        "",
        "## Error Recovery",
        "",
        "| Failure | Cause | Recovery Action |",
        "| --- | --- | --- |",
        "| Missing label | Icon-only button | Add aria-label attribute. |",
        "",
        "## Output Format",
        "",
        "- Accessibility report.",
        "",
        "## Quality Criteria",
        "",
        "- Every interactive control has a name.",
        ""
      ].join("\n")
    );

    const impRun = skanvil(["import", ext, "--type", "front", "--json"], root);
    expect(impRun.code).toBe(0);
    expect(json<{ imported: { target: string }[] }>(impRun).imported[0].target).toBe("front-custom-a11y");

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Skanvil Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Skanvil Test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    };
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root, env: gitEnv });

    expect(
      skanvil(
        [
          "add",
          "--type",
          "back",
          "--name",
          "events",
          "--description",
          "Audits event schemas. Use when changing message queues."
        ],
        root
      ).code
    ).toBe(0);

    const diffJson = skanvil(["diff", "HEAD", "--json"], root);
    expect(diffJson.code).toBe(0);
    expect(json<{ added: { skill: string }[] }>(diffJson).added.map((e) => e.skill)).toEqual(["back-events"]);

    const diffMd = skanvil(["diff", "HEAD", "--format", "markdown"], root);
    expect(diffMd.code).toBe(0);
    expect(diffMd.stdout).toContain("## skanvil diff (HEAD)");
    expect(diffMd.stdout).toContain("`back-events`");
  });

  test("telemetry snapshot, emit, hook, install-hooks and feedback push CLI commands work end-to-end", () => {
    const dir = tmp();
    expect(skanvil(["init", "lib", "--no-git", "--no-agent-skill"], dir).code).toBe(0);
    const root = path.join(dir, "lib");
    expect(
      skanvil(
        [
          "add",
          "--type",
          "front",
          "--name",
          "telemetry-check",
          "--description",
          "Audits UI metrics cleanly. Use when checking frontend components."
        ],
        root
      ).code
    ).toBe(0);

    const snapDry = skanvil(["telemetry", "snapshot", "--dry-run", "--json"], root);
    expect(snapDry.code).toBe(0);
    expect(json<{ dryRun: boolean; events: { type: string; totals: { skills: number } }[] }>(snapDry)).toMatchObject({
      dryRun: true,
      events: [{ type: "library.snapshot", totals: { skills: 1 } }]
    });

    const emitDry = skanvil(
      ["telemetry", "emit", "--skill", "front-telemetry-check", "--agent", "claude", "--dry-run", "--json"],
      root
    );
    expect(emitDry.code).toBe(0);
    expect(json<{ dryRun: boolean; events: { skill: string; agent: string }[] }>(emitDry)).toMatchObject({
      dryRun: true,
      events: [{ skill: "front-telemetry-check", agent: "claude" }]
    });

    const project = tmp();
    const hooksRun = skanvil(
      ["telemetry", "install-hooks", project, "--target", "claude,cursor,gemini", "--json"],
      root
    );
    expect(hooksRun.code).toBe(0);
    expect(
      json<{ results: { agent: string; status: string }[] }>(hooksRun).results.map((r) => `${r.agent}:${r.status}`)
    ).toEqual(["claude:installed", "cursor:installed", "gemini:installed"]);

    fs.writeFileSync(
      path.join(root, ".skanvil-feedback.jsonl"),
      `${JSON.stringify({ skill: "front-telemetry-check", step: "Step 1", symptom: "Needs extra flag" })}\n`
    );
    const fbPushDry = skanvil(["feedback", "push", "--dry-run", "--json"], root);
    expect(fbPushDry.code).toBe(0);
    expect(json<{ dryRun: boolean; events: { skill: string }[] }>(fbPushDry)).toMatchObject({
      dryRun: true,
      events: [{ skill: "front-telemetry-check" }]
    });

    const queuePath = path.join(tmp(), "cli-hook-queue.jsonl");
    const hookRun = spawnSync(process.execPath, [CLI, "telemetry", "hook", "--agent", "claude"], {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({
        tool_name: "Skill",
        tool_input: { skill: "front-telemetry-check" },
        cwd: root
      }),
      env: { ...process.env, SKANVIL_TELEMETRY_QUEUE: queuePath, SKANVIL_TELEMETRY_URL: "", NO_COLOR: "1" }
    });
    expect(hookRun.status).toBe(0);
    expect(fs.existsSync(queuePath)).toBe(true);
    expect(fs.readFileSync(queuePath, "utf8")).toContain("front-telemetry-check");

    // Native eval run (--provider mock --ablation --strict), outdated check, frozen sync, 7-agent hooks, and transcript dry run.
    fs.writeFileSync(
      path.join(root, "skills", "front-telemetry-check", "SKILL.md"),
      [
        "---",
        "name: front-telemetry-check",
        "description: Audits UI metrics cleanly. Use when checking frontend components.",
        "---",
        "",
        "## Objective\nCheck metrics.",
        "## When to Activate This Skill\nWhen checking metrics.",
        "## Instructions\n1. Emit CLI_MOCK_MARKER cleanly.",
        "## Error Recovery\n| Failure | Cause | Recovery Action |\n| --- | --- | --- |\n| Empty | Missing file | Provide file path. |",
        "## Output Format\nSummary.",
        "## Quality Criteria\nPass."
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, "skills", "front-telemetry-check", "evals.json"),
      JSON.stringify({
        cases: [
          {
            id: "cli-mock-case",
            prompt: "Run UI telemetry audit",
            expected: ["Produces CLI_MOCK_MARKER"],
            mustContain: ["CLI_MOCK_MARKER"]
          }
        ]
      }),
      "utf8"
    );

    const evalRun = skanvil(["eval", "run", "--provider", "mock", "--ablation", "--strict", "--json"], root);
    expect(evalRun.code).toBe(0);
    expect(json<{ ok: boolean; passed: number; ablationSummary: { netLift: number } }>(evalRun)).toMatchObject({
      ok: true,
      passed: 1,
      ablationSummary: { netLift: 1 }
    });

    const syncTarget = tmp();
    expect(skanvil(["sync", syncTarget, "-C", root, "--target", "claude"], root).code).toBe(0);
    expect(skanvil(["sync", syncTarget, "-C", root, "--target", "claude", "--frozen"], root).code).toBe(0);
    const outdatedRun = skanvil(["outdated", syncTarget, "--strict", "--json"], root);
    expect(outdatedRun.code).toBe(0);
    expect(json<{ outdatedCount: number }>(outdatedRun).outdatedCount).toBe(0);

    const trFile = path.join(tmp(), "sess.jsonl");
    fs.writeFileSync(
      trFile,
      `${JSON.stringify({ timestamp: "2026-11-26T09:00:00Z", tool_name: "Skill", tool_input: { skill: "front-telemetry-check" } })}\n`,
      "utf8"
    );
    const ingestDry = skanvil(["telemetry", "ingest-transcripts", trFile, "--dry-run", "--json"], root);
    expect(ingestDry.code).toBe(0);
    expect(json<{ filesScanned: number; dryRun: boolean; events: unknown[] }>(ingestDry)).toMatchObject({
      filesScanned: 1,
      dryRun: true
    });
  });
});
