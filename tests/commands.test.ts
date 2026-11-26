import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

import { collectSkills } from "../src/commands/skills.js";
import {
  AGENT_SKILL_VERSION_KEY,
  FEEDBACK_SKILL_NAME,
  agentSkillSource,
  feedbackSkillSource,
  installAgentSkill
} from "../src/core/agent-skill.js";
import { CONFIG_FILE } from "../src/core/config.js";
import { diffLibrary, formatDiffMarkdown } from "../src/core/diff.js";
import { doctor } from "../src/core/doctor.js";
import { checkTriggerRouting, exportEvalDataset, routePrompt } from "../src/core/evals.js";
import { FEEDBACK_FILE, promoteFeedback, readFeedbackLog, summarizeFeedback } from "../src/core/feedback.js";
import { importSkills } from "../src/core/import.js";
import { createLibrary, parseProfile } from "../src/core/init.js";
import { Library } from "../src/core/library.js";
import { rebuildIndex, reconcileIndex } from "../src/core/reindex.js";
import { editSkill, removeSkill, scaffoldSkill } from "../src/core/skills.js";
import { analyzeLibraryStats } from "../src/core/stats.js";
import { MANIFEST_FILE, resolveSourceHandle, resolveTarget, syncSkills, type ManifestV2 } from "../src/core/sync.js";
import {
  buildFeedbackEvents,
  buildLibrarySnapshotEvent,
  buildSkillInvokedEvent,
  flushTelemetryQueue,
  resolveTelemetrySettings,
  sendTelemetryEvents,
  type TelemetryEvent
} from "../src/core/telemetry.js";
import { installTelemetryHooks, parseAgentHookPayload } from "../src/core/telemetry-hooks.js";
import { ejectSkillTemplate } from "../src/core/templates.js";
import { packageVersion } from "../src/util/paths.js";
import { findBrokenReferences, validateLibrary } from "../src/core/validate.js";
import { formatGitHubAnnotations, formatSarif } from "../src/core/validate-format.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skanvil-"));
}

async function makeLibrary(options: Parameters<typeof createLibrary>[1] = {}): Promise<string> {
  const target = path.join(tmp(), "my-lib");
  await createLibrary(target, { git: false, ...options });
  return target;
}

const readme = (root: string) => fs.readFileSync(path.join(root, "README.md"), "utf8");
const skillMd = (root: string, name: string) => fs.readFileSync(path.join(root, "skills", name, "SKILL.md"), "utf8");
const errors = async (root: string) =>
  (await validateLibrary(await Library.open(root))).diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => `${diagnostic.skill ?? ""}: ${diagnostic.message}`);
const writeRc = (root: string, value: unknown) =>
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(value, null, 2), "utf8");

describe("init", () => {
  test("generates a valid library with scoped package name and a full rc", async () => {
    const root = await makeLibrary({ scope: "@acme", profile: "front,back" });
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const rc = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));

    expect(pkg.name).toBe("@acme/my-lib");
    expect(pkg.devDependencies.skanvil).toBe(`^${packageVersion()}`);
    expect(rc.categories.map((category: { id: string }) => category.id)).toEqual([
      "front",
      "back",
      "transversal",
      "internal"
    ]);
    expect(fs.existsSync(path.join(root, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".github", "copilot-instructions.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".github", "workflows", "skills.yml"))).toBe(true);
    expect(readme(root).split("## Working")[0]).not.toMatch(/Transversal/);
    expect(await validateLibrary(await Library.open(root))).toMatchObject({ diagnostics: [], count: 0 });
    await expect(createLibrary(root, { git: false })).rejects.toThrow(/not empty/);
  });

  test("rejects invalid profiles", () => {
    expect(() => parseProfile("front,mobile")).toThrow(/Invalid profile/);
    expect(parseProfile("frontend,backend")).toEqual(["front", "back"]);
  });
});

describe("add", () => {
  test("creates a valid skill and indexes it", async () => {
    const root = await makeLibrary();
    const result = await scaffoldSkill(root, { type: "front", name: "api review", description: "Reviews API changes" });

    expect(result.skillName).toBe("front-api-review");
    expect(fs.existsSync(path.join(root, "skills", "front-api-review", "references", "REFERENCE.md"))).toBe(true);
    expect(readme(root)).toMatch(/skills\/front-api-review/);
    expect(skillMd(root, "front-api-review")).not.toMatch(/^tools:/m);
    expect(await errors(root)).toEqual([]);
    await expect(scaffoldSkill(root, { type: "front", name: "api review", description: "x" })).rejects.toThrow(
      /already exists/
    );
  });

  test("escapes YAML-sensitive descriptions", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "back", name: "svc", description: "Handles: queues, #retries and 'quotes'" });
    const library = await Library.open(root);
    expect((await library.readSkill("back-svc")).getString("description")).toBe(
      "Handles: queues, #retries and 'quotes'."
    );
    expect(await errors(root)).toEqual([]);
  });

  test("honours resource opt-outs and keeps internal skills out of the README", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, {
      type: "internal",
      name: "tools",
      description: "Internal tools",
      includeAssets: false,
      includeReferences: false,
      includeScripts: false
    });

    expect(fs.readdirSync(path.join(root, "skills", "_tools"))).toEqual(["SKILL.md"]);
    expect(readme(root)).not.toMatch(/_tools/);
    expect(await errors(root)).toEqual([]);
  });

  test("preserves CRLF line endings in the README", async () => {
    const root = await makeLibrary();
    fs.writeFileSync(path.join(root, "README.md"), readme(root).replace(/\n/g, "\r\n"));
    await scaffoldSkill(root, { type: "front", name: "a", description: "A" });
    await editSkill(root, "front-a", { rename: "b" });
    expect(readme(root)).toMatch(/skills\/front-b/);
    expect(readme(root)).not.toMatch(/[^\r]\n/);
  });
});

describe("edit", () => {
  test("renames, retypes and redescribes keeping everything in sync", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "front", name: "demo", description: "Original" });

    const renamed = await editSkill(root, "front-demo", { rename: "demo2", description: "Changed text" });
    expect(renamed.skillName).toBe("front-demo2");
    expect(skillMd(root, "front-demo2")).toMatch(/^description: Changed text\.$/m);

    await editSkill(root, "front-demo2", { type: "back", title: "Nice Title" });
    const content = skillMd(root, "back-demo2");
    expect(content).toMatch(/^name: back-demo2$/m);
    expect(content).toMatch(/domain: backend/);
    expect(content).toMatch(/backend repositories/);
    expect(content).toMatch(/^# Nice Title$/m);
    expect(readme(root)).toMatch(/Backend<\/strong><\/summary>\n\n- Nice Title/);
    expect(await errors(root)).toEqual([]);

    await expect(editSkill(root, "back-demo2", {})).rejects.toThrow(/Nothing to edit/);
    await expect(editSkill(root, "missing", { rename: "x" })).rejects.toThrow(/not found/);
  });

  test("can move a skill to internal and remove it", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "transversal", name: "shared", description: "Shared" });

    await editSkill(root, "shared", { type: "internal" });
    expect(fs.existsSync(path.join(root, "skills", "_shared"))).toBe(true);
    expect(readme(root)).not.toMatch(/_shared|skills\/shared/);

    await removeSkill(root, "_shared");
    expect(fs.readdirSync(path.join(root, "skills")).filter((name) => name !== ".gitkeep")).toEqual([]);
  });

  test("rolls back file changes when the folder rename fails", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "front", name: "demo", description: "Original" });
    const beforeReadme = readme(root);
    const beforeSkill = skillMd(root, "front-demo");

    const library = await Library.open(root);
    const realRename = fs.promises.rename;
    fs.promises.rename = async () => {
      throw new Error("EPERM simulated");
    };
    try {
      await expect(editSkill(library, "front-demo", { rename: "other" })).rejects.toThrow(/rolled back/);
    } finally {
      fs.promises.rename = realRename;
    }
    expect(readme(root)).toBe(beforeReadme);
    expect(skillMd(root, "front-demo")).toBe(beforeSkill);
  });
});

describe("validate", () => {
  test("reports convention errors", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "front", name: "demo", description: "Original" });

    const file = path.join(root, "skills", "front-demo", "SKILL.md");
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\nTODO later\n`, "utf8");
    fs.mkdirSync(path.join(root, "skills", "orphan"));
    fs.writeFileSync(
      path.join(root, "skills", "orphan", "SKILL.md"),
      "---\nname: other\ndescription: x\n---\n",
      "utf8"
    );

    const found = await errors(root);
    expect(found.some((error) => /forbidden placeholder/.test(error))).toBe(true);
    expect(found.some((error) => /orphan: name \(other\) must match/.test(error))).toBe(true);
    expect(found.some((error) => /orphan: not documented in README/.test(error))).toBe(true);
    expect(found.some((error) => /missing required section/.test(error))).toBe(true);
  });

  test("applies Agent Skills spec limits and configurable severities", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "front", name: "demo", description: "Original" });
    const library = await Library.open(root);
    const skill = await library.readSkill("front-demo");
    skill.set(["description"], "x".repeat(1025));
    skill.set(["tools"], ["read_file"]);
    skill.set(["metadata", "version"], 1);
    await library.writeSkill("front-demo", skill);

    const result = await validateLibrary(library);
    const rules = result.diagnostics.map((diagnostic) => `${diagnostic.rule}:${diagnostic.severity}`);
    expect(rules).toContain("description-length:error");
    expect(rules).toContain("tools-field:warn");
    expect(rules).toContain("metadata-format:warn");

    const rc = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
    rc.validation.rules = { "description-length": "off", "tools-field": "error" };
    writeRc(root, rc);
    const after = await validateLibrary(await Library.open(root));
    const afterRules = after.diagnostics.map((diagnostic) => `${diagnostic.rule}:${diagnostic.severity}`);
    expect(afterRules).not.toContain("description-length:error");
    expect(afterRules).toContain("tools-field:error");
  });
});

test("list reports category, index, validity and description", async () => {
  const root = await makeLibrary();
  await scaffoldSkill(root, { type: "back", name: "svc", description: "Service" });
  await scaffoldSkill(root, { type: "internal", name: "tools", description: "Tools" });

  expect(await collectSkills(await Library.open(root))).toEqual([
    { name: "_tools", type: "internal", indexed: null, valid: null, description: "Tools." },
    { name: "back-svc", type: "back", indexed: true, valid: true, description: "Service." }
  ]);
});

test("custom categories drive naming, README sections and validation", async () => {
  const root = await makeLibrary();
  writeRc(root, {
    name: "my-lib",
    categories: [
      { id: "mobile", prefix: "mobile-", metadata: { domain: "mobile", team: "apps" } },
      { id: "data", prefix: "data-", title: "Data" },
      { id: "general", default: true, title: "General" }
    ]
  });

  const result = await scaffoldSkill(root, { type: "mobile", name: "push", description: "Push notifications" });
  expect(result.skillName).toBe("mobile-push");
  expect(readme(root)).toMatch(/<strong>Mobile<\/strong><\/summary>\n\n- Push/);
  expect(skillMd(root, "mobile-push")).toMatch(/team: apps/);
  expect(skillMd(root, "mobile-push")).not.toMatch(/^compatibility:/m);

  await editSkill(root, "mobile-push", { type: "data" });
  expect(readme(root)).toMatch(/<strong>Data<\/strong><\/summary>\n\n- Push/);
  expect(await errors(root)).toEqual([]);
});

describe("index and doctor", () => {
  test("index rebuild is stable after add/edit and repairs drift", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "front", name: "b", description: "B" });
    await scaffoldSkill(root, { type: "front", name: "a", description: "A" });
    await scaffoldSkill(root, { type: "back", name: "c", description: "C" });
    const library = await Library.open(root);
    expect(await rebuildIndex(library, readme(root))).toBe(readme(root));

    fs.rmSync(path.join(root, "skills", "back-c"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "new-one"));
    fs.cpSync(path.join(root, "skills", "front-a", "SKILL.md"), path.join(root, "skills", "new-one", "SKILL.md"));
    const rebuilt = await rebuildIndex(library, readme(root));
    expect(rebuilt).not.toMatch(/back-c/);
    expect(rebuilt).toMatch(
      /Transversal<\/strong><\/summary>\n\n- A\n\t- Description: A\.\n\t- Folder: `skills\/new-one`/
    );
  });

  test("multi-line descriptions produce single-line index entries", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "front", name: "multi", description: "Placeholder" });
    const file = path.join(root, "skills", "front-multi", "SKILL.md");
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace(/^description: .*$/m, "description: |\n  First line.\n\n  Second line."),
      "utf8"
    );
    const library = await Library.open(root);
    const rebuilt = await rebuildIndex(library, readme(root));
    expect(rebuilt).toMatch(/\t- Description: First line\. Second line\.\n\t- Folder: `skills\/front-multi`/);
    fs.writeFileSync(path.join(root, "README.md"), rebuilt, "utf8");
    expect(await rebuildIndex(library, readme(root))).toBe(rebuilt);
    expect(await errors(root)).toEqual([]);
  });

  test("doctor --fix repairs README, names, tabs and the tools field", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, {
      type: "front",
      name: "demo",
      description: "Reviews frontend components for keyboard navigation. Use when changing UI widgets."
    });
    await scaffoldSkill(root, {
      type: "back",
      name: "svc",
      description: "Audits backend database migrations safely. Use when modifying SQL schemas."
    });

    const file = path.join(root, "skills", "front-demo", "SKILL.md");
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace("name: front-demo", 'name: wrong\ntools: ["read_file", "grep"]'),
      "utf8"
    );
    fs.writeFileSync(path.join(root, "README.md"), readme(root).replace(/- Svc[\s\S]*?back-svc`\n/, ""), "utf8");
    fs.cpSync(
      path.join(root, "skills", "front-demo", "references"),
      path.join(root, "skills", "front-x", "references"),
      {
        recursive: true
      }
    );
    fs.writeFileSync(
      path.join(root, "skills", "front-x", "SKILL.md"),
      skillMd(root, "front-demo")
        .replace("compatibility:", "compatibility:\t")
        .replace(
          /description: .*/,
          "description: Formats GraphQL client queries and cache keys. Use when updating Apollo hooks."
        ),
      "utf8"
    );

    const library = await Library.open(root);
    const result = await doctor(library, { fix: true });
    expect(result.before.errors).toBeGreaterThan(0);
    expect(skillMd(root, "front-demo")).toMatch(/^name: front-demo$/m);
    expect(skillMd(root, "front-demo")).toMatch(/^allowed-tools: read_file grep$/m);
    expect(skillMd(root, "front-x")).not.toMatch(/\t/);
    expect(readme(root)).toMatch(/skills\/back-svc/);
    expect(result.after!.diagnostics.filter((d) => d.rule !== "template-unchanged")).toEqual([]);
  });
});

test("custom templates: eject, per-category override and explicit --template", async () => {
  const root = await makeLibrary();
  const library = await Library.open(root);
  const ejected = await ejectSkillTemplate(library, "back");
  fs.writeFileSync(
    path.join(ejected, "SKILL.md"),
    fs
      .readFileSync(path.join(ejected, "SKILL.md"), "utf8")
      .replace("## Objective", "## Objective\n\nBackend flavoured."),
    "utf8"
  );
  await expect(ejectSkillTemplate(library, "back")).rejects.toThrow(/already exists/);

  await scaffoldSkill(library, { type: "back", name: "svc", description: "Service" });
  await scaffoldSkill(library, { type: "front", name: "ui", description: "UI" });
  expect(skillMd(root, "back-svc")).toMatch(/Backend flavoured/);
  expect(skillMd(root, "front-ui")).not.toMatch(/Backend flavoured/);

  fs.cpSync(ejected, path.join(root, ".skanvil", "templates", "minimal"), { recursive: true });
  fs.rmSync(path.join(root, ".skanvil", "templates", "minimal", "scripts"), { recursive: true });
  await scaffoldSkill(library, { type: "front", name: "min", description: "Min", template: "minimal" });
  expect(fs.existsSync(path.join(root, "skills", "front-min", "scripts"))).toBe(false);
  await expect(
    scaffoldSkill(library, { type: "front", name: "z", description: "Z", template: "nope" })
  ).rejects.toThrow(/not found/);
  expect(await errors(root)).toEqual([]);
});

describe("sync", () => {
  test("copies publishable skills, is idempotent, prunes and leaves foreign skills alone", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "front", name: "a", description: "A" });
    await scaffoldSkill(root, { type: "back", name: "b", description: "B" });
    await scaffoldSkill(root, { type: "internal", name: "tools", description: "Tools" });
    const project = tmp();
    fs.mkdirSync(path.join(project, ".claude", "skills", "mine"), { recursive: true });
    fs.mkdirSync(path.join(project, ".claude", "skills", "front-a"));
    fs.writeFileSync(path.join(project, ".claude", "skills", "front-a", "SKILL.md"), "foreign");

    let library = await Library.open(root);
    let [result] = await syncSkills(library, { dest: project, targets: ["claude"], categories: [], skills: [] });
    expect(result.added).toEqual(["back-b"]);
    expect(result.skipped.map((entry) => entry.skill)).toEqual(["front-a"]);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "_tools"))).toBe(false);
    expect(fs.readFileSync(path.join(project, ".claude", "skills", "front-a", "SKILL.md"), "utf8")).toBe("foreign");

    fs.rmSync(path.join(project, ".claude", "skills", "front-a"), { recursive: true });
    [result] = await syncSkills(library, { dest: project, targets: ["claude", "copilot"] });
    expect(result.added).toEqual(["front-a"]);
    expect(result.unchanged).toEqual(["back-b"]);

    fs.appendFileSync(path.join(root, "skills", "back-b", "SKILL.md"), "\nMore.\n");
    await removeSkill(root, "front-a");
    library = await Library.open(root);
    const dry = await syncSkills(library, { dest: project, targets: ["claude"], dryRun: true });
    expect(dry[0]).toMatchObject({ updated: ["back-b"], removed: ["front-a"] });
    expect(fs.existsSync(path.join(project, ".claude", "skills", "front-a"))).toBe(true);

    [result] = await syncSkills(library, { dest: project, targets: ["claude"] });
    expect(result).toMatchObject({ updated: ["back-b"], removed: ["front-a"] });
    expect(fs.existsSync(path.join(project, ".claude", "skills", "front-a"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "mine"))).toBe(true);
    expect(fs.readFileSync(path.join(project, ".claude", "skills", "back-b", "SKILL.md"), "utf8")).toMatch(/More\./);
    expect(fs.existsSync(path.join(project, ".github", "skills", "front-a"))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(project, ".claude", "skills", MANIFEST_FILE), "utf8")
    ) as ManifestV2;
    expect(manifest.manifestVersion).toBe(2);
    expect(Object.values(manifest.sources)[0].skills).toHaveProperty("back-b");
  });

  test("link mode creates symlinks/junctions and skips invalid skills", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "front", name: "a", description: "A" });
    await scaffoldSkill(root, { type: "front", name: "bad", description: "Bad" });
    fs.appendFileSync(path.join(root, "skills", "front-bad", "SKILL.md"), "\nTODO\n");
    const project = tmp();

    const [result] = await syncSkills(await Library.open(root), { dest: project, targets: ["agents"], mode: "link" });
    expect(result.added).toEqual(["front-a"]);
    expect(result.skipped).toEqual([{ skill: "front-bad", reason: "has validation errors (use --force)" }]);
    const linked = path.join(project, ".agents", "skills", "front-a");
    expect(fs.lstatSync(linked).isSymbolicLink() || result.warnings.length > 0).toBe(true);
    expect(fs.existsSync(path.join(linked, "SKILL.md"))).toBe(true);
  });
});

describe("skanvil agent skill", () => {
  test("both bundled skills pass skanvil's own default validation with no warnings", async () => {
    const root = await makeLibrary({ agentSkill: false });
    fs.cpSync(agentSkillSource(), path.join(root, "skills", "skanvil"), { recursive: true });
    fs.cpSync(feedbackSkillSource(), path.join(root, "skills", FEEDBACK_SKILL_NAME), { recursive: true });
    const library = await Library.open(root);
    const { text } = await reconcileIndex(library, readme(root));
    fs.writeFileSync(path.join(root, "README.md"), text, "utf8");

    const result = await validateLibrary(library);
    expect(result.diagnostics).toEqual([]);
    expect(result.count).toBe(2);
  });

  test("init installs skanvil and skanvil-feedback by default and honours opt-outs", async () => {
    const root = await makeLibrary();
    const installed = path.join(root, ".claude", "skills", "skanvil", "SKILL.md");
    const feedbackInstalled = path.join(root, ".claude", "skills", FEEDBACK_SKILL_NAME, "SKILL.md");
    expect(fs.existsSync(installed)).toBe(true);
    expect(fs.existsSync(feedbackInstalled)).toBe(true);
    expect(fs.readFileSync(installed, "utf8")).toMatch(
      new RegExp(`${AGENT_SKILL_VERSION_KEY}: "?${packageVersion().replace(/\./g, "\\.")}`)
    );
    expect(fs.readFileSync(feedbackInstalled, "utf8")).toMatch(
      new RegExp(`${AGENT_SKILL_VERSION_KEY}: "?${packageVersion().replace(/\./g, "\\.")}`)
    );
    expect(fs.existsSync(path.join(root, ".claude", "skills", "skanvil", "references", "REFERENCE.md"))).toBe(true);

    const noFeedback = await makeLibrary({ feedbackSkill: false });
    expect(fs.existsSync(path.join(noFeedback, ".claude", "skills", "skanvil", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(noFeedback, ".claude", "skills", FEEDBACK_SKILL_NAME))).toBe(false);

    const skipped = await makeLibrary({ agentSkill: false });
    expect(fs.existsSync(path.join(skipped, ".claude"))).toBe(false);
  });

  test("install-skill installs, keeps, updates and never overwrites foreign folders", async () => {
    const project = tmp();
    const first = await installAgentSkill({ dest: project, targets: ["claude", "copilot"] });
    expect(first.map((result) => `${result.skill}:${result.status}`)).toEqual([
      "skanvil:installed",
      "skanvil-feedback:installed",
      "skanvil:installed",
      "skanvil-feedback:installed"
    ]);
    expect(fs.existsSync(path.join(project, ".github", "skills", "skanvil", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".github", "skills", FEEDBACK_SKILL_NAME, "SKILL.md"))).toBe(true);

    let claude = await installAgentSkill({ dest: project, targets: ["claude"] });
    expect(claude.map((r) => r.status)).toEqual(["unchanged", "unchanged"]);

    const file = path.join(project, ".claude", "skills", "skanvil", "SKILL.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/skanvil-version: .*/, 'skanvil-version: "0.0.1"'));
    claude = await installAgentSkill({ dest: project, targets: ["claude"] });
    expect(claude.map((r) => r.status)).toEqual(["updated", "unchanged"]);

    const foreign = path.join(project, ".agents", "skills", "skanvil");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: skanvil\ndescription: mine\n---\n");
    let [agents] = await installAgentSkill({ dest: project, targets: ["agents"], includeFeedback: false });
    expect(agents.status).toBe("skipped");
    expect(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8")).toMatch(/description: mine/);

    [agents] = await installAgentSkill({ dest: project, targets: ["agents"], includeFeedback: false, force: true });
    expect(agents.status).toBe("updated");
    expect(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8")).toMatch(/Operate skanvil/);
  });
});

describe("content rules", () => {
  test("template-unchanged warns until the generic scaffold text is replaced", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, {
      type: "front",
      name: "demo",
      description: "Audits React components for accessibility issues. Use when reviewing UI changes."
    });
    const library = await Library.open(root);
    let result = await validateLibrary(library);
    expect(result.errors).toBe(0);
    expect(result.diagnostics.map((d) => `${d.rule}:${d.severity}`)).toEqual(["template-unchanged:warn"]);

    const file = path.join(root, "skills", "front-demo", "SKILL.md");
    const content = fs.readFileSync(file, "utf8");
    const instructions = "## Instructions\n\n1. Read the component.\n2. Check the props.\n\n";
    const recovery =
      "## Error Recovery\n\n| Failure | Cause | Recovery Action |\n| --- | --- | --- |\n| Missing JSX parser | Outdated lockfile | Install workspace dependencies before re-running lint. |\n\n";
    fs.writeFileSync(
      file,
      content
        .replace(
          /## When to Activate This Skill[\s\S]*?(?=## Instructions)/,
          "## When to Activate This Skill\n\nWhen a component changes. Do not activate for backend migrations.\n\n"
        )
        .replace(/## Instructions[\s\S]*?(?=- Use `references)/, instructions)
        .replace(/## Error Recovery[\s\S]*?(?=## Output Format)/, recovery),
      "utf8"
    );
    result = await validateLibrary(library);
    expect(result.diagnostics).toEqual([]);
  });

  test("broken-references reports missing and escaping paths, ignoring code, URLs and patterns", () => {
    const files = new Set(["SKILL.md", "references/REFERENCE.md", "scripts/run.sh"]);
    const body = [
      "See [the reference](references/REFERENCE.md) and [section](references/REFERENCE.md#usage).",
      "Run `scripts/run.sh`, then `scripts/missing.sh`.",
      "Also [gone](assets/template.md), [up](../other/SKILL.md), [web](https://example.com/x.md), [anchor](#top).",
      "Patterns are fine: `scripts/<name>.sh`, `assets/*.png`; folders too: [refs](references/).",
      "```",
      "cat references/not-checked.md and [x](references/in-code.md)",
      "```"
    ].join("\n");

    expect(findBrokenReferences(body, files)).toEqual([
      "reference 'assets/template.md' does not exist in the skill folder",
      "reference '../other/SKILL.md' points outside the skill folder",
      "reference 'scripts/missing.sh' does not exist in the skill folder"
    ]);
  });

  test("add without references/ does not leave a dangling link", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "front", name: "lean", description: "Lean", includeReferences: false });
    const rules = (await validateLibrary(await Library.open(root))).diagnostics.map((d) => d.rule);
    expect(rules).not.toContain("broken-references");
  });
});

describe("sync targets", () => {
  test("custom targets must stay inside the destination", async () => {
    const project = tmp();
    expect(resolveTarget(project, "tools/skills")).toBe(path.join(project, "tools", "skills"));
    expect(() => resolveTarget(project, "../escape")).toThrow(/must be a folder inside/);
    expect(() => resolveTarget(project, ".")).toThrow(/must be a folder inside/);

    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, { type: "front", name: "a", description: "A" });
    await expect(
      syncSkills(await Library.open(root), { dest: project, targets: ["claude", "../../outside"] })
    ).rejects.toThrow(/must be a folder inside/);
    expect(fs.existsSync(path.join(project, ".claude"))).toBe(false);
  });

  test("--global installs into the user's home folders and only accepts presets", async () => {
    const home = tmp();
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, { type: "front", name: "a", description: "A" });

    const [result] = await syncSkills(await Library.open(root), {
      dest: "unused",
      targets: ["copilot"],
      scope: "user",
      homeDir: home
    });
    expect(result.path).toBe(path.join(home, ".copilot", "skills"));
    expect(fs.existsSync(path.join(home, ".copilot", "skills", "front-a", "SKILL.md"))).toBe(true);

    const [skill] = await installAgentSkill({
      dest: "unused",
      targets: ["agents"],
      scope: "user",
      homeDir: home,
      includeFeedback: false
    });
    expect(skill.path).toBe(path.join(home, ".agents", "skills", "skanvil"));
    expect(() => resolveTarget("x", "my/folder", { scope: "user", homeDir: home })).toThrow(/only accept presets/);
  });
});

function writeCleanSkillBody(
  filePath: string,
  opts: {
    instructions?: string;
    recovery?: string;
  } = {}
): void {
  const instructions = opts.instructions ?? "## Instructions\n\n1. Inspect target files.\n2. Verify output.\n\n";
  const recovery =
    opts.recovery ??
    "## Error Recovery\n\n| Failure | Cause | Recovery Action |\n| --- | --- | --- |\n| Check fails | Bad input | Print diagnostics and stop. |\n\n";
  const updated = fs
    .readFileSync(filePath, "utf8")
    .replace(
      /## When to Activate This Skill[\s\S]*?(?=## Instructions)/,
      "## When to Activate This Skill\n\nWhen requested for this domain. Do not activate otherwise.\n\n"
    )
    .replace(/## Instructions[\s\S]*?(?=- Use `references)/, instructions)
    .replace(/## Error Recovery[\s\S]*?(?=## Output Format)/, recovery);
  fs.writeFileSync(filePath, updated, "utf8");
}

describe("quality rules and stats", () => {
  test("reports code-smell and budget diagnostics and respects fenced code", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "one",
      description: `${"Reviews frontend routing components and accessibility forms when users update React views. ".repeat(6)}Use when changing React views.`
    });
    const oneFile = path.join(root, "skills", "front-one", "SKILL.md");
    writeCleanSkillBody(oneFile, {
      instructions: "## Instructions\n\nRead the files carefully and check things without numbers.\n\n",
      recovery: "## Error Recovery\n\nIf something fails, try again after reading logs.\n\n"
    });
    fs.writeFileSync(path.join(root, "skills", "front-one", "references", "extra.md"), "# Unused\n", "utf8");

    await scaffoldSkill(root, {
      type: "back",
      name: "two",
      description: "Handles backend jobs cleanly and writes logs."
    });
    const twoFile = path.join(root, "skills", "back-two", "SKILL.md");
    writeCleanSkillBody(twoFile, {
      instructions: "## Instructions\n\n1. Run check.\n\n```bash\n# inside code fence: try again\n```\n\n",
      recovery:
        "## Error Recovery\n\n| Failure | Cause | Action |\n| --- | --- | --- |\n| Bad SQL | Syntax | Abort |\n\n"
    });

    const result = await validateLibrary(await Library.open(root));
    const oneRules = result.diagnostics.filter((d) => d.skill === "front-one").map((d) => d.rule);
    expect(oneRules).toEqual(
      expect.arrayContaining([
        "description-budget",
        "numbered-steps",
        "vague-fallback",
        "error-recovery-table",
        "unused-resources"
      ])
    );
    const twoRules = result.diagnostics.filter((d) => d.skill === "back-two").map((d) => d.rule);
    expect(twoRules).toContain("description-triggers");
    expect(twoRules).not.toContain("vague-fallback");
  });

  test("reports description-overlap and always-loaded-budget across the library", async () => {
    const root = await makeLibrary({ agentSkill: false });
    const rc = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
    rc.validation.maxAlwaysLoadedTokens = 20;
    writeRc(root, rc);

    await scaffoldSkill(root, {
      type: "front",
      name: "audit-a",
      description:
        "Audits React checkout forms for WCAG accessibility contrast issues. Use when changing checkout forms."
    });
    await scaffoldSkill(root, {
      type: "front",
      name: "audit-b",
      description:
        "Audits React checkout forms for WCAG accessibility contrast issues. Use when changing checkout forms."
    });
    writeCleanSkillBody(path.join(root, "skills", "front-audit-a", "SKILL.md"));
    writeCleanSkillBody(path.join(root, "skills", "front-audit-b", "SKILL.md"));

    const result = await validateLibrary(await Library.open(root));
    expect(result.diagnostics.some((d) => d.rule === "always-loaded-budget" && !d.skill)).toBe(true);
    expect(result.diagnostics.some((d) => d.rule === "description-overlap" && d.skill === "front-audit-b")).toBe(true);
  });

  test("analyzeLibraryStats measures 3 stages, unreferenced files, filtering and sorting", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "alpha",
      description: "Reviews frontend components for keyboard focus. Use when updating UI components."
    });
    await scaffoldSkill(root, {
      type: "back",
      name: "beta",
      description: "Audits SQL migrations for table locking and rollback safety. Use when modifying database schemas."
    });
    fs.writeFileSync(path.join(root, "skills", "front-alpha", "references", "extra.md"), "# Extra\nSome text.\n");

    const lib = await Library.open(root);
    const stats = await analyzeLibraryStats(lib, { sort: "tokens" });
    expect(stats.count).toBe(2);
    expect(stats.totals.alwaysLoadedTokens).toBeGreaterThan(20);
    expect(stats.totals.unreferencedFiles).toBe(1);
    expect(stats.skills.find((s) => s.name === "front-alpha")?.resources.unreferencedFiles).toEqual([
      "references/extra.md"
    ]);

    const onlyBack = await analyzeLibraryStats(lib, { category: "backend" });
    expect(onlyBack.skills.map((s) => s.name)).toEqual(["back-beta"]);
  });
});

describe("evals.json, triggers and dataset export", () => {
  test("validates evals.json, case params, evals-required opt-in and excludes evals.json from sync", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "a11y",
      description: "Audits React components for WCAG keyboard traps and ARIA labels. Use when changing UI modals."
    });
    await scaffoldSkill(root, {
      type: "back",
      name: "sql",
      description: "Reviews Postgres database migrations and index lock risks. Use when adding SQL migrations."
    });
    writeCleanSkillBody(path.join(root, "skills", "front-a11y", "SKILL.md"));
    writeCleanSkillBody(path.join(root, "skills", "back-sql", "SKILL.md"));

    fs.writeFileSync(
      path.join(root, "skills", "front-a11y", "params.json"),
      JSON.stringify({ strict: { type: "boolean", default: false } })
    );
    fs.writeFileSync(
      path.join(root, "skills", "front-a11y", "evals.json"),
      JSON.stringify({
        triggers: {
          shouldTrigger: [{ prompt: "Check ARIA labels in React modal", split: "train" }],
          shouldNotTrigger: [{ prompt: "Fix Postgres index lock migration", split: "eval" }]
        },
        cases: [
          {
            id: "modal-trap",
            split: "eval",
            params: { strict: true },
            prompt: "Audit Modal.tsx",
            expected: ["Reports keyboard focus issue"],
            mustContain: ["aria-"],
            mustNotContain: ["lorem"]
          }
        ]
      })
    );

    let lib = await Library.open(root);
    expect((await validateLibrary(lib)).errors).toBe(0);

    // Enable evals-required: back-sql has no evals.json.
    const rc = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
    rc.validation.rules["evals-required"] = "error";
    writeRc(root, rc);
    lib = await Library.open(root);
    let result = await validateLibrary(lib);
    expect(result.diagnostics.some((d) => d.rule === "evals-required" && d.skill === "back-sql")).toBe(true);
    expect(result.diagnostics.some((d) => d.rule === "evals-required" && d.skill === "front-a11y")).toBe(false);

    // Bad case params should fail evals-file.
    fs.writeFileSync(
      path.join(root, "skills", "front-a11y", "evals.json"),
      JSON.stringify({
        cases: [{ id: "bad", params: { unknownParam: "x" }, prompt: "p", expected: ["e"] }]
      })
    );
    result = await validateLibrary(lib);
    expect(result.diagnostics.some((d) => d.rule === "evals-file" && d.skill === "front-a11y")).toBe(true);

    // Fix evals.json and verify sync excludes it.
    fs.writeFileSync(
      path.join(root, "skills", "front-a11y", "evals.json"),
      JSON.stringify({
        triggers: {
          shouldTrigger: ["Audit React modal ARIA labels"],
          shouldNotTrigger: ["Review Postgres SQL index migration"]
        }
      })
    );
    fs.writeFileSync(
      path.join(root, "skills", "back-sql", "evals.json"),
      JSON.stringify({
        triggers: {
          shouldTrigger: ["Review Postgres migration lock risk"],
          shouldNotTrigger: ["Audit React modal ARIA labels"]
        }
      })
    );
    const project = tmp();
    await syncSkills(lib, { dest: project, targets: ["claude"] });
    expect(fs.existsSync(path.join(project, ".claude", "skills", "front-a11y", "evals.json"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "back-sql", "evals.json"))).toBe(false);
  });

  test("checkTriggerRouting detects passes, collisions and respects splits; exportEvalDataset supports promptfoo ablation", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "a11y",
      description: "Audits React UI components for WCAG ARIA accessibility. Use when reviewing frontend UI."
    });
    await scaffoldSkill(root, {
      type: "back",
      name: "sql",
      description: "Audits Postgres SQL database migrations for index locks. Use when adding migrations."
    });

    fs.writeFileSync(
      path.join(root, "skills", "front-a11y", "evals.json"),
      JSON.stringify({
        triggers: {
          shouldTrigger: [
            { prompt: "Check React ARIA accessibility in UI", split: "train" },
            { prompt: "Review Postgres SQL database migration locks", split: "eval" } // intentional collision
          ],
          shouldNotTrigger: [{ prompt: "Audit Postgres SQL migrations", split: "eval" }]
        },
        cases: [
          {
            id: "ui-check",
            split: "eval",
            prompt: "Audit button focus",
            expected: ["Checks keyboard focus ring"],
            mustContain: ["focus"],
            mustNotContain: ["ignore"]
          }
        ]
      })
    );

    const lib = await Library.open(root);
    const all = await checkTriggerRouting(lib);
    expect(all.total).toBe(3);
    expect(all.passed).toBe(2);
    expect(all.failed).toBe(1);
    expect(all.bySplit.train).toEqual({ total: 1, passed: 1, failed: 0 });
    expect(all.bySplit.eval).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(all.results.find((r) => !r.passed)?.topSkill).toBe("back-sql");

    const trainOnly = await checkTriggerRouting(lib, { split: "train" });
    expect(trainOnly.failed).toBe(0);

    const exported = await exportEvalDataset(lib, { format: "promptfoo", ablation: true, split: "eval" });
    const parsed = JSON.parse(exported.content);
    expect(parsed.prompts.map((p: { id: string }) => p.id)).toEqual(["with-skill", "without-skill"]);
    expect(parsed.tests).toHaveLength(1);
    expect(parsed.tests[0].assert).toEqual([
      { type: "llm-rubric", value: "Checks keyboard focus ring" },
      { type: "icontains", value: "focus" },
      { type: "not-icontains", value: "ignore" }
    ]);
  });
});

describe("governance, ownership and lifecycle", () => {
  test("validates owner-required, status-valid and replaced-by-exists", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "legacy",
      description: "Handles legacy checkout validation forms. Use when editing old forms."
    });
    await scaffoldSkill(root, {
      type: "front",
      name: "modern",
      description: "Validates modern checkout API payloads. Use when building new checkout flows."
    });

    // Test editSkill rejects missing replacement and self-replacement before writing.
    await expect(editSkill(root, "front-legacy", { replacedBy: "front-nope" })).rejects.toThrow(/not found/);
    await expect(editSkill(root, "front-legacy", { replacedBy: "front-legacy" })).rejects.toThrow(
      /cannot replace itself/
    );

    await editSkill(root, "front-legacy", {
      owner: "@web-platform",
      status: "deprecated",
      replacedBy: "front-modern"
    });
    let lib = await Library.open(root);
    expect((await validateLibrary(lib)).errors).toBe(0);

    // Enable owner-required and introduce an invalid status + deprecated replacement target.
    const rc = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
    rc.validation.rules["owner-required"] = "error";
    writeRc(root, rc);
    const modernSkill = await lib.readSkill("front-modern");
    modernSkill.set(["metadata", "status"], "bogus");
    await lib.writeSkill("front-modern", modernSkill);

    lib = await Library.open(root);
    let res = await validateLibrary(lib);
    expect(res.diagnostics.some((d) => d.rule === "owner-required" && d.skill === "front-modern")).toBe(true);
    expect(res.diagnostics.some((d) => d.rule === "status-valid" && d.skill === "front-modern")).toBe(true);

    // Deprecated replacement target triggers replaced-by-exists.
    modernSkill.set(["metadata", "status"], "deprecated");
    await lib.writeSkill("front-modern", modernSkill);
    res = await validateLibrary(lib);
    expect(res.diagnostics.some((d) => d.rule === "replaced-by-exists" && d.skill === "front-legacy")).toBe(true);

    // Un-deprecating clears metadata.replaced-by.
    await editSkill(lib, "front-legacy", { status: "active" });
    expect((await lib.readSkill("front-legacy")).has("metadata", "replaced-by")).toBe(false);
  });

  test("list filters by status/owner and sync skips and prunes deprecated skills", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "old",
      description: "Legacy frontend form helper. Use when maintaining legacy forms."
    });
    await scaffoldSkill(root, {
      type: "front",
      name: "new",
      description: "Modern frontend form validator. Use when building new checkout forms."
    });
    await editSkill(root, "front-old", { owner: "@team-a", status: "active" });
    await editSkill(root, "front-new", { owner: "@team-b", status: "active" });

    const project = tmp();
    const lib = await Library.open(root);
    const [sync1] = await syncSkills(lib, { dest: project, targets: ["claude"] });
    expect(sync1.added).toEqual(["front-new", "front-old"]);
    expect(sync1.alwaysLoadedTokens).toBeGreaterThan(20);

    // Deprecate front-old -> next sync skips and prunes it.
    await editSkill(lib, "front-old", { status: "deprecated", replacedBy: "front-new" });
    expect(await collectSkills(lib, { status: "deprecated" })).toMatchObject([
      { name: "front-old", status: "deprecated", owner: "@team-a", replacedBy: "front-new" }
    ]);
    expect(await collectSkills(lib, { owner: "@team-b" })).toMatchObject([{ name: "front-new" }]);

    const [sync2] = await syncSkills(lib, { dest: project, targets: ["claude"] });
    expect(sync2.removed).toEqual(["front-old"]);
    expect(sync2.skipped).toEqual([
      { skill: "front-old", reason: "deprecated (replaced by front-new; use --include-deprecated)" }
    ]);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "front-old"))).toBe(false);

    // Opt-in includeDeprecated brings it back.
    const [sync3] = await syncSkills(lib, { dest: project, targets: ["claude"], includeDeprecated: true });
    expect(sync3.added).toEqual(["front-old"]);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "front-old"))).toBe(true);
  });
});

describe("feedback loop and eval route", () => {
  test("summarizeFeedback groups duplicate symptoms and tolerates invalid lines", async () => {
    const root = await makeLibrary({ agentSkill: false });
    const logPath = path.join(root, FEEDBACK_FILE);
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          timestamp: "2026-10-01T10:00:00Z",
          skill: "front-ui",
          step: "Step 2",
          symptom: "Wrong CLI flag",
          proposedFix: "Use --dry-run first",
          suggestedEvalCase: {
            id: "flag-check",
            prompt: "Run preview",
            expected: "Uses --dry-run"
          }
        }),
        "{not valid json",
        JSON.stringify({
          timestamp: "2026-10-02T12:00:00Z",
          skill: "front-ui",
          step: "step 2",
          symptom: "wrong   cli flag",
          proposedFix: "Document --dry-run"
        }),
        JSON.stringify({ skill: "front-ui", step: "" })
      ].join("\n") + "\n"
    );

    const read = await readFeedbackLog(logPath);
    expect(read.entries).toHaveLength(2);
    expect(read.invalidLines).toHaveLength(2);

    const summary = await summarizeFeedback(root);
    expect(summary.totalEntries).toBe(2);
    expect(summary.uniqueGroups).toBe(1);
    expect(summary.groups[0]).toMatchObject({
      skill: "front-ui",
      count: 2,
      latestTimestamp: "2026-10-02T12:00:00Z",
      suggestedEvalCases: 1
    });
    expect(summary.groups[0].proposedFixes).toEqual(["Use --dry-run first", "Document --dry-run"]);
  });

  test("promoteFeedback validates cases, avoids duplicates, supports dry-run and --prune", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "ui",
      description: "Audits React components for accessibility. Use when reviewing UI views."
    });
    fs.writeFileSync(
      path.join(root, "skills", "front-ui", "params.json"),
      JSON.stringify({ runner: { type: "enum", values: ["vitest", "jest"], default: "vitest" } })
    );
    const logPath = path.join(root, FEEDBACK_FILE);
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          skill: "front-ui",
          step: "Step 1",
          symptom: "Forgot ARIA focus check",
          suggestedEvalCase: {
            id: "aria-focus",
            prompt: "Audit button focus state",
            expected: "Checks focus ring",
            params: { runner: "jest" }
          }
        }),
        // Duplicate case id should be skipped.
        JSON.stringify({
          skill: "front-ui",
          step: "Step 1",
          symptom: "Another report",
          suggestedEvalCase: {
            id: "aria-focus",
            prompt: "Different prompt",
            expected: ["Checks focus ring"]
          }
        }),
        // Unknown param value should be skipped cleanly.
        JSON.stringify({
          skill: "front-ui",
          step: "Step 2",
          symptom: "Bad runner param",
          suggestedEvalCase: {
            id: "bad-param",
            prompt: "Run tests",
            expected: "Runs tests",
            params: { runner: "mocha" }
          }
        }),
        // Missing skill should be skipped cleanly.
        JSON.stringify({
          skill: "back-missing",
          step: "Step 1",
          symptom: "Skill removed",
          suggestedEvalCase: { id: "missing", prompt: "x", expected: ["y"] }
        }),
        "corrupt-json-line"
      ].join("\n") + "\n"
    );

    const dry = await promoteFeedback(root, { dryRun: true, prune: true });
    expect(dry.promoted).toHaveLength(1);
    expect(dry.prunedLines).toBe(0);
    expect(fs.existsSync(path.join(root, "skills", "front-ui", "evals.json"))).toBe(false);

    const applied = await promoteFeedback(root, { prune: true });
    expect(applied.promoted).toEqual([
      {
        skill: "front-ui",
        id: "aria-focus",
        prompt: "Audit button focus state",
        file: "skills/front-ui/evals.json"
      }
    ]);
    expect(applied.skipped).toHaveLength(3);
    expect(applied.invalidLines).toHaveLength(1);
    expect(applied.prunedLines).toBe(1);

    const evals = JSON.parse(fs.readFileSync(path.join(root, "skills", "front-ui", "evals.json"), "utf8"));
    expect(evals).toEqual({
      cases: [
        {
          id: "aria-focus",
          prompt: "Audit button focus state",
          params: { runner: "jest" },
          expected: ["Checks focus ring"]
        }
      ]
    });
    const remaining = fs.readFileSync(logPath, "utf8");
    expect(remaining).not.toContain("Audit button focus state");
    expect(remaining).toContain("Different prompt");
    expect(remaining).toContain("corrupt-json-line");
  });

  test("routePrompt ranks non-deprecated skills by BM25 score and reports matched tokens", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "a11y",
      description: "Audits React modals for WCAG accessibility and focus management. Use when reviewing UI."
    });
    await scaffoldSkill(root, {
      type: "back",
      name: "sql",
      description: "Reviews Postgres SQL migrations and indexes. Use when changing database schemas."
    });
    await scaffoldSkill(root, {
      type: "front",
      name: "old-a11y",
      description: "Old React WCAG accessibility checker. Use when checking legacy UI."
    });
    await editSkill(root, "front-old-a11y", { status: "deprecated", replacedBy: "front-a11y" });

    const lib = await Library.open(root);
    const hit = await routePrompt(lib, "Review React WCAG accessibility focus", { top: 2 });
    expect(hit.totalSkills).toBe(2);
    expect(hit.candidates[0]).toMatchObject({ skill: "front-a11y", rank: 1 });
    expect(hit.candidates[0].matchedTokens).toEqual(
      expect.arrayContaining(["react", "wcag", "accessibility", "focus"])
    );

    const none = await routePrompt(lib, "Deploy terraform kubernetes cluster");
    expect(none.candidates).toEqual([]);
  });
});

describe("security rules, duplicate triggers, doctor migration and CI formats", () => {
  test("no-secrets and no-local-paths flag leaked credentials and personal paths without leaking values", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "deploy",
      description: "Deploys frontend assets safely. Use when preparing production releases."
    });

    const ghToken = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
    const awsKey = `AKIA${"1234567890ABCDEF"}`;
    const bearerSecret = `Bearer ${"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload999"}`;

    const skillPath = path.join(root, "skills", "front-deploy", "SKILL.md");
    fs.writeFileSync(
      skillPath,
      [
        "---",
        "name: front-deploy",
        "description: Deploys frontend assets safely. Use when preparing production releases.",
        "---",
        "",
        "# Deploy",
        "",
        "## Objective",
        "",
        "Deploy static assets safely.",
        "",
        "## When to Activate This Skill",
        "",
        "- Act when releasing frontend builds.",
        "- Skip backend database changes.",
        "",
        "## Instructions",
        "",
        "1. Run [scripts/deploy.sh](scripts/deploy.sh) from the repo root.",
        "2. Check generic doc path `/Users/<user>/app` and `/home/runner/work/app` safely.",
        "3. Never hardcode `Authorization: Bearer <YOUR_TOKEN>` or `Authorization: Bearer YOUR_TOKEN_PLACEHOLDER_12345`.",
        "4. Inspect local path `/Users/jdoe/workspace/app` only in legacy configs.",
        "",
        "## Error Recovery",
        "",
        "| Failure | Cause | Recovery Action |",
        "| --- | --- | --- |",
        "| Build fails | Missing env | Export credentials and rerun `npm run build`. |",
        "",
        "## Output Format",
        "",
        "- Deployment URL.",
        "",
        "## Quality Criteria",
        "",
        "- Zero exposed secrets.",
        ""
      ].join("\n")
    );

    fs.writeFileSync(
      path.join(root, "skills", "front-deploy", "scripts", "deploy.sh"),
      [
        "#!/usr/bin/env bash",
        `TOKEN="${ghToken}"`,
        `AWS_ACCESS_KEY_ID="${awsKey}"`,
        `HEADER="Authorization: ${bearerSecret}"`,
        'CACHE_DIR="C:\\Users\\Alice\\cache"',
        ""
      ].join("\n")
    );

    const lib = await Library.open(root);
    const result = await validateLibrary(lib);
    const secrets = result.diagnostics.filter((d) => d.rule === "no-secrets");
    const localPaths = result.diagnostics.filter((d) => d.rule === "no-local-paths");

    expect(secrets).toHaveLength(3);
    for (const diag of secrets) {
      expect(diag.severity).toBe("error");
      expect(diag.file).toBe("skills/front-deploy/scripts/deploy.sh");
      expect(diag.message).not.toContain(ghToken);
      expect(diag.message).not.toContain(awsKey);
      expect(diag.message).not.toContain("eyJhbGciOiJIUzI1NiI");
    }
    expect(localPaths.map((d) => `${d.file}:${d.line}`)).toEqual([
      "skills/front-deploy/SKILL.md:22",
      "skills/front-deploy/scripts/deploy.sh:5"
    ]);
  });

  test("duplicate-trigger detects cross-skill shouldTrigger collisions", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "alpha",
      description: "Audits React components for accessibility. Use when reviewing UI."
    });
    await scaffoldSkill(root, {
      type: "front",
      name: "beta",
      description: "Reviews CSS contrast and focus states. Use when styling UI forms."
    });
    fs.writeFileSync(
      path.join(root, "skills", "front-alpha", "evals.json"),
      JSON.stringify({ triggers: { shouldTrigger: ["Audit button accessibility."] } })
    );
    fs.writeFileSync(
      path.join(root, "skills", "front-beta", "evals.json"),
      JSON.stringify({ triggers: { shouldTrigger: ["  audit   button accessibility!  "] } })
    );

    const res = await validateLibrary(await Library.open(root));
    const dupes = res.diagnostics.filter((d) => d.rule === "duplicate-trigger");
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toMatchObject({
      severity: "warn",
      skill: "front-beta",
      file: "skills/front-beta/evals.json"
    });
    expect(dupes[0].message).toContain("front-alpha");
  });

  test("doctor --scaffold-sections inserts missing required sections only when requested", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "legacy",
      description: "Legacy frontend helper. Use when refactoring older components."
    });
    const file = path.join(root, "skills", "front-legacy", "SKILL.md");
    fs.writeFileSync(
      file,
      [
        "---",
        "name: front-legacy",
        "description: Legacy frontend helper. Use when refactoring older components.",
        "---",
        "",
        "# Legacy",
        "",
        "## Objective",
        "",
        "Help refactor old components.",
        "",
        "## When to Activate This Skill",
        "",
        "- Use on legacy components.",
        "",
        "## Instructions",
        "",
        "1. Inspect the module before editing.",
        "",
        "## Output Format",
        "",
        "- Modified files.",
        "",
        "## Quality Criteria",
        "",
        "- Passes tests.",
        ""
      ].join("\n")
    );

    const lib = await Library.open(root);
    await expect(doctor(lib, { scaffoldSections: true })).rejects.toThrow(/requires --fix/);

    const defaultFix = await doctor(lib, { fix: true });
    expect(defaultFix.fixes).toEqual([]);
    expect(defaultFix.after!.diagnostics.some((d) => d.rule === "required-sections")).toBe(true);

    const scaffolded = await doctor(lib, { fix: true, scaffoldSections: true });
    expect(scaffolded.fixes).toContain("front-legacy: scaffolded missing section '## Error Recovery'");
    expect(scaffolded.after!.errors).toBe(0);
    expect(scaffolded.after!.diagnostics.some((d) => d.rule === "template-unchanged")).toBe(true);
    const updated = fs.readFileSync(file, "utf8");
    expect(updated.indexOf("## Error Recovery")).toBeGreaterThan(-1);
    expect(updated.indexOf("## Error Recovery")).toBeLessThan(updated.indexOf("## Output Format"));
  });

  test("formatGitHubAnnotations and formatSarif produce valid CI outputs with locations", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "check",
      description: "Checks API contracts. Use when editing HTTP endpoints."
    });
    fs.appendFileSync(path.join(root, "skills", "front-check", "SKILL.md"), "\nLeave TODO here.\n");

    const lib = await Library.open(root);
    const result = await validateLibrary(lib);
    const github = formatGitHubAnnotations(result, lib);
    expect(github).toContain("::error file=skills/front-check/SKILL.md,line=");
    expect(github).toContain(",title=placeholders::");
    expect(github).toContain("::warning file=skills/front-check/SKILL.md,line=1,title=template-unchanged::");

    const sarif = JSON.parse(formatSarif(result, lib));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.name).toBe("skanvil");
    expect(sarif.runs[0].results.some((r: { ruleId: string }) => r.ruleId === "placeholders")).toBe(true);
    expect(
      sarif.runs[0].results.find((r: { ruleId: string }) => r.ruleId === "placeholders").locations[0].physicalLocation
        .artifactLocation.uri
    ).toBe("skills/front-check/SKILL.md");
  });
});

describe("multi-library sync v2 and Git sources", () => {
  test("coexisting libraries keep isolated pruning, remembered params, collision protection, and combined tokens", async () => {
    const libA = await makeLibrary({ agentSkill: false });
    const libB = await makeLibrary({ agentSkill: false });
    const project = tmp();

    await scaffoldSkill(libA, {
      type: "front",
      name: "alpha",
      description: "Frontend helper using {{runner}}. Use when running {{runner}} frontend checks."
    });
    fs.writeFileSync(
      path.join(libA, "skills", "front-alpha", "params.json"),
      JSON.stringify({ runner: { type: "enum", values: ["vitest", "jest"], default: "vitest" } })
    );
    await scaffoldSkill(libA, {
      type: "front",
      name: "shared",
      description: "Library A implementation of shared workflow. Use when auditing UI."
    });

    await scaffoldSkill(libB, {
      type: "back",
      name: "beta",
      description: "Backend helper for API migrations using {{runner}}. Use when updating schemas."
    });
    fs.writeFileSync(
      path.join(libB, "skills", "back-beta", "params.json"),
      JSON.stringify({ runner: { type: "enum", values: ["prisma", "drizzle"], default: "prisma" } })
    );
    await scaffoldSkill(libB, {
      type: "front",
      name: "shared",
      description: "Library B colliding skill. Use when testing collisions."
    });

    const [syncA] = await syncSkills(await Library.open(libA), {
      dest: project,
      targets: ["claude"],
      params: { runner: "jest" }
    });
    expect(syncA.added).toEqual(["front-alpha", "front-shared"]);

    const [syncB] = await syncSkills(await Library.open(libB), {
      dest: project,
      targets: ["claude"],
      params: { runner: "drizzle" }
    });
    expect(syncB.added).toEqual(["back-beta"]);
    expect(syncB.skipped).toContainEqual({
      skill: "front-shared",
      reason: expect.stringMatching(/already managed by another library/)
    });
    // Shared stays owned by Lib A and is not overwritten.
    expect(fs.readFileSync(path.join(project, ".claude", "skills", "front-shared", "SKILL.md"), "utf8")).toContain(
      "Library A implementation"
    );
    // Combined Stage-1 tokens include both libraries' skills.
    expect(syncB.alwaysLoadedTokens).toBeGreaterThan(syncA.alwaysLoadedTokens);

    // Pruning Lib A removes front-shared without touching Lib B's back-beta or remembered params.
    await removeSkill(libA, "front-shared");
    const [syncA2] = await syncSkills(await Library.open(libA), { dest: project, targets: ["claude"] });
    expect(syncA2.removed).toEqual(["front-shared"]);
    expect(syncA2.unchanged).toEqual(["front-alpha"]);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "back-beta", "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(project, ".claude", "skills", "front-alpha", "SKILL.md"), "utf8")).toContain(
      "jest"
    );

    const [syncB2] = await syncSkills(await Library.open(libB), { dest: project, targets: ["claude"] });
    expect(syncB2.unchanged).toEqual(["back-beta"]);
    expect(syncB2.params).toEqual({ runner: "drizzle" });
  });

  test("migrates legacy v1 .skanvil-sync.json transparently to manifest v2", async () => {
    const libA = await makeLibrary({ agentSkill: false });
    const libB = await makeLibrary({ agentSkill: false });
    const project = tmp();

    await scaffoldSkill(libA, {
      type: "front",
      name: "legacy-one",
      description: "Frontend skill synced by manifest v1. Use when testing upgrades."
    });
    await scaffoldSkill(libB, {
      type: "back",
      name: "new-two",
      description: "Backend skill synced by manifest v2. Use when adding second library."
    });

    const claudeDir = path.join(project, ".claude", "skills");
    await syncSkills(await Library.open(libA), { dest: project, targets: ["claude"] });

    // Rewrite manifest in v1 shape with exact installed hash & source path.
    const v2 = JSON.parse(fs.readFileSync(path.join(claudeDir, MANIFEST_FILE), "utf8")) as ManifestV2;
    const [[sourceKey, entry]] = Object.entries(v2.sources);
    fs.writeFileSync(
      path.join(claudeDir, MANIFEST_FILE),
      JSON.stringify({ tool: "skanvil", version: "1.0.0", source: sourceKey, skills: entry.skills })
    );

    const [syncB] = await syncSkills(await Library.open(libB), { dest: project, targets: ["claude"] });
    expect(syncB.added).toEqual(["back-new-two"]);
    expect(fs.existsSync(path.join(claudeDir, "front-legacy-one", "SKILL.md"))).toBe(true);

    const [syncA] = await syncSkills(await Library.open(libA), { dest: project, targets: ["claude"] });
    expect(syncA.unchanged).toEqual(["front-legacy-one"]);

    const upgraded = JSON.parse(fs.readFileSync(path.join(claudeDir, MANIFEST_FILE), "utf8")) as ManifestV2;
    expect(upgraded.manifestVersion).toBe(2);
    expect(Object.keys(upgraded.sources)).toHaveLength(2);
  });

  test("resolveSourceHandle clones offline git+file:// repos with #ref, prevents temp links, and cleans up", async () => {
    const repo = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(repo, {
      type: "transversal",
      name: "release",
      description: "Guides v1 release steps. Use when releasing packages."
    });
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Skanvil Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Skanvil Test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    };
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "initial v1"], { cwd: repo, env: gitEnv });
    execFileSync("git", ["checkout", "-b", "v2"], { cwd: repo });
    await scaffoldSkill(repo, {
      type: "front",
      name: "v2-only",
      description: "Exclusive v2 skill. Use when using v2 branch."
    });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "add v2 skill"], { cwd: repo, env: gitEnv });

    const project = tmp();
    const spec = `git+${pathToFileURL(repo).href}#v2`;
    const handle = await resolveSourceHandle(spec, project);
    const clonedRoot = handle.root;
    try {
      expect(handle.isTemporary).toBe(true);
      expect(handle.sourceLabel).toBe(spec);

      const lib = await Library.open(clonedRoot);
      const [result] = await syncSkills(lib, {
        dest: project,
        targets: ["cursor"],
        mode: "link",
        sourceLabel: handle.sourceLabel,
        forbidLinkReason: "temporary Git source cannot be linked; copied instead"
      });
      expect(result.added).toEqual(["front-v2-only", "release"]);
      expect(result.warnings).toContain("temporary Git source cannot be linked; copied instead");
      expect(fs.existsSync(path.join(project, ".cursor", "skills", "front-v2-only", "SKILL.md"))).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(project, ".cursor", "skills", MANIFEST_FILE), "utf8")
      ) as ManifestV2;
      expect(manifest.sources).toHaveProperty(spec);
    } finally {
      await handle.cleanup();
    }
    expect(fs.existsSync(clonedRoot)).toBe(false);
  });
});

describe("importSkills and diffLibrary", () => {
  test("importSkills handles multi-skill and single-skill folders, normalizes frontmatter, and rolls back on failure", async () => {
    const root = await makeLibrary({ agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "existing",
      description: "Existing skill before import. Use when checking overwrite behavior."
    });

    const external = path.join(tmp(), ".claude", "skills");
    fs.mkdirSync(path.join(external, "api-lint", "references"), { recursive: true });
    fs.mkdirSync(path.join(external, "front-existing"), { recursive: true });
    fs.writeFileSync(path.join(external, MANIFEST_FILE), JSON.stringify({ tool: "skanvil", manifestVersion: 2 }));
    fs.writeFileSync(
      path.join(external, "api-lint", "SKILL.md"),
      [
        "---",
        "name: api-lint",
        "description: Audits frontend fetch calls for retry safety. Use when checking API requests.",
        "tools: [Read, Grep]",
        "---",
        "",
        "## Objective",
        "",
        "Check API request wrappers.",
        ""
      ].join("\n")
    );
    fs.writeFileSync(path.join(external, "api-lint", "references", "guide.md"), "# Guide\n");
    fs.writeFileSync(
      path.join(external, "front-existing", "SKILL.md"),
      [
        "---",
        "name: front-existing",
        "description: Overwritten frontend skill. Use when replacing older behavior.",
        "---",
        "",
        "# Existing Overwritten",
        ""
      ].join("\n")
    );

    // Dry run writes nothing.
    const dry = await importSkills(root, external, { type: "front", dryRun: true });
    expect(dry.imported.map((i) => i.target)).toEqual(["front-api-lint"]);
    expect(dry.skipped.map((i) => i.target)).toEqual(["front-existing"]);
    expect(fs.existsSync(path.join(root, "skills", "front-api-lint"))).toBe(false);

    // Actual import without overwrite keeps front-existing untouched and imports front-api-lint.
    const applied = await importSkills(root, external, { type: "front" });
    expect(applied.imported).toHaveLength(1);
    expect(applied.skipped).toHaveLength(1);
    const importedMd = fs.readFileSync(path.join(root, "skills", "front-api-lint", "SKILL.md"), "utf8");
    expect(importedMd).toContain("name: front-api-lint");
    expect(importedMd).toContain("allowed-tools: Read Grep");
    expect(importedMd).toContain("domain: frontend");
    expect(importedMd).toContain("# Api Lint");
    expect(fs.existsSync(path.join(root, "skills", "front-api-lint", "references", "guide.md"))).toBe(true);
    expect(readme(root)).toContain("`skills/front-api-lint`");

    // Overwrite mode replaces front-existing and imports a single-skill directory directly.
    const single = path.join(tmp(), "single-worker");
    fs.mkdirSync(single, { recursive: true });
    fs.writeFileSync(
      path.join(single, "SKILL.md"),
      [
        "---",
        "name: back-worker",
        "description: Runs background queue checks cleanly. Use when debugging workers.",
        "---",
        "",
        "# Back Worker",
        ""
      ].join("\n")
    );
    const singleRes = await importSkills(root, single, { type: "back" });
    expect(singleRes.imported[0]).toMatchObject({ source: ".", target: "back-worker", type: "back" });

    // Rollback check: break README closing tag while importing with --overwrite.
    const readmeFile = path.join(root, "README.md");
    const goodReadme = fs.readFileSync(readmeFile, "utf8");
    fs.writeFileSync(readmeFile, goodReadme.replace(/<\/details>/g, ""));
    await expect(importSkills(root, external, { type: "front", overwrite: true })).rejects.toThrow(/rolled back/);
    expect(fs.readFileSync(path.join(root, "skills", "front-existing", "SKILL.md"), "utf8")).toContain(
      "Existing skill before import"
    );
  });

  test("diffLibrary compares subdirectory git snapshot and detects token deltas, param diffs, and regressions", async () => {
    const repo = tmp();
    const libRoot = path.join(repo, "packages", "skills");
    await createLibrary(libRoot, { git: false, agentSkill: false });

    await scaffoldSkill(libRoot, {
      type: "front",
      name: "a11y",
      description: "Audits React WCAG contrast. Use when reviewing UI components."
    });
    await scaffoldSkill(libRoot, {
      type: "back",
      name: "old",
      description: "Checks legacy queues. Use when checking old jobs."
    });
    await scaffoldSkill(libRoot, {
      type: "transversal",
      name: "git-flow",
      description: "Guides branch naming cleanly. Use when opening pull requests."
    });
    fs.writeFileSync(
      path.join(libRoot, "skills", "front-a11y", "evals.json"),
      JSON.stringify({
        triggers: {
          shouldTrigger: ["Check React WCAG contrast"],
          shouldNotTrigger: ["Check branch naming conventions"]
        }
      })
    );

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Skanvil Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Skanvil Test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    };
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base snapshot"], { cwd: repo, env: gitEnv });

    // Modify front-a11y: longer description, new param, active status, new placeholder error, and broken trigger.
    await editSkill(libRoot, "front-a11y", {
      status: "active",
      description:
        "Audits TypeScript formatting rules and branch naming conventions cleanly. Use when opening pull requests and inspecting diffs."
    });
    fs.writeFileSync(
      path.join(libRoot, "skills", "front-a11y", "params.json"),
      JSON.stringify({ strict: { type: "boolean", default: false } })
    );
    fs.appendFileSync(path.join(libRoot, "skills", "front-a11y", "SKILL.md"), "\nTODO finish WCAG checks\n");

    // Remove back-old and add back-cache.
    await removeSkill(libRoot, "back-old");
    await scaffoldSkill(libRoot, {
      type: "back",
      name: "cache",
      description: "Audits Redis cache invalidation rules. Use when adding caching layers."
    });

    const diff = await diffLibrary(libRoot, { baseRef: "HEAD" });
    expect(diff.added.map((entry) => entry.skill)).toEqual(["back-cache"]);
    expect(diff.removed.map((entry) => entry.skill)).toEqual(["back-old"]);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]).toMatchObject({
      skill: "front-a11y",
      statusChange: { from: "(unset)", to: "active" },
      paramChanges: ["added param 'strict'"]
    });
    expect(diff.modified[0].stage1TokenDelta).toBeGreaterThan(0);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.stage1Tokens.delta).toBe(diff.stage1Tokens.current - diff.stage1Tokens.base);
    expect(diff.newDiagnostics.some((d) => d.rule === "placeholders" && d.skill === "front-a11y")).toBe(true);
    expect(diff.triggerRegressions.some((r) => r.skill === "front-a11y" && r.kind === "shouldTrigger")).toBe(true);

    const md = formatDiffMarkdown(diff);
    expect(md).toContain("## skanvil diff (HEAD)");
    expect(md).toContain("`front-a11y`");
    expect(md).toContain("### New Validation Diagnostics");
    expect(md).toContain("### Trigger Routing Regressions");
  });
});

describe("telemetry client, offline queue, and agent hooks", () => {
  test("snapshots, feedback redaction, HTTP batch ingestion, and offline queue flush work end-to-end", async () => {
    const root = await makeLibrary({ name: "hub-demo", scope: "acme", agentSkill: false });
    await scaffoldSkill(root, {
      type: "front",
      name: "forms",
      description: "Audits form validation cleanly. Use when editing React forms."
    });
    fs.writeFileSync(
      path.join(root, FEEDBACK_FILE),
      `${JSON.stringify({
        timestamp: "2026-11-25T10:00:00Z",
        skill: "front-forms",
        step: "Step 2",
        symptom: "Fails inside /Users/jdoe/app with ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        suggestedEvalCase: { id: "form-check", prompt: "Check form", expected: ["Validates errors"] }
      })}\n`
    );

    const lib = await Library.open(root);
    const snapshot = await buildLibrarySnapshotEvent(lib);
    expect(snapshot.library).toBe("@acme/hub-demo");
    expect(snapshot.totals.skills).toBe(1);
    expect(snapshot.skills[0]).toMatchObject({ name: "front-forms", category: "front", valid: true });

    const { events: feedbackEvents } = await buildFeedbackEvents(lib);
    expect(feedbackEvents).toHaveLength(1);
    expect(feedbackEvents[0].symptom).not.toContain("jdoe");
    expect(feedbackEvents[0].symptom).toContain("<redacted-token>");

    const queueFile = path.join(tmp(), "queue.jsonl");
    // Unreachable port queues events cleanly.
    const offlineSettings = resolveTelemetrySettings(lib.config, {
      endpoint: "http://127.0.0.1:1",
      apiKey: "test-ingest-key",
      queueFile,
      timeoutMs: 400
    });
    const failedSend = await sendTelemetryEvents([snapshot, ...feedbackEvents], offlineSettings);
    expect(failedSend.sent).toBe(0);
    expect(failedSend.queued).toBe(2);
    expect(fs.existsSync(queueFile)).toBe(true);

    // Start local HTTP receiver and verify queue flush + Bearer header.
    const received: TelemetryEvent[] = [];
    let authHeader = "";
    const server = http.createServer((req, res) => {
      authHeader = req.headers.authorization ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { events: TelemetryEvent[] };
        received.push(...body.events);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, accepted: body.events.length, duplicates: 0 }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const addr = server.address() as { port: number };
      const onlineSettings = resolveTelemetrySettings(lib.config, {
        endpoint: `http://127.0.0.1:${addr.port}`,
        apiKey: "test-ingest-key",
        queueFile
      });
      const flushed = await flushTelemetryQueue(onlineSettings);
      expect(flushed).toMatchObject({ sent: 2, queued: 0, remaining: 0 });
      expect(authHeader).toBe("Bearer test-ingest-key");
      expect(received.map((e) => e.type)).toEqual(["library.snapshot", "skill.feedback"]);
      expect(fs.existsSync(queueFile)).toBe(false);

      const invoked = buildSkillInvokedEvent({
        skill: "front-forms",
        library: "@acme/hub-demo",
        agent: "claude",
        model: "claude-sonnet",
        projectPath: root,
        durationMs: 1200,
        toolCalls: 4
      });
      const direct = await sendTelemetryEvents([invoked], onlineSettings);
      expect(direct.sent).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("parseAgentHookPayload detects synced skills and installTelemetryHooks merges configs idempotently", async () => {
    const libRoot = await makeLibrary({ name: "team-skills", scope: "acme", agentSkill: false });
    await scaffoldSkill(libRoot, {
      type: "front",
      name: "table",
      description: "Reviews data tables cleanly. Use when building grids."
    });
    const project = tmp();
    await syncSkills(await Library.open(libRoot), { dest: project, targets: ["claude", "cursor", "gemini"] });

    // Non-skill file reads return null immediately.
    const ignored = await parseAgentHookPayload(
      "claude",
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: path.join(project, "src", "app.ts") } }),
      project
    );
    expect(ignored).toBeNull();

    const claudeFile = path.join(project, ".claude", "skills", "front-table", "SKILL.md");
    const claudeSignal = await parseAgentHookPayload(
      "claude",
      JSON.stringify({
        session_id: "sess-1",
        cwd: project,
        tool_name: "Read",
        tool_input: { file_path: claudeFile }
      })
    );
    expect(claudeSignal).toMatchObject({
      agent: "claude",
      skill: "front-table",
      library: "my-lib",
      outcome: "success"
    });
    expect(claudeSignal?.stage1Tokens).toBeGreaterThan(5);

    const cursorSignal = await parseAgentHookPayload(
      "cursor",
      JSON.stringify({
        conversation_id: "conv-1",
        workspace_roots: [project],
        file_path: path.join(project, ".cursor", "skills", "front-table", "SKILL.md")
      })
    );
    expect(cursorSignal).toMatchObject({ agent: "cursor", skill: "front-table" });

    const geminiSignal = await parseAgentHookPayload(
      "gemini",
      JSON.stringify({
        session_id: "gem-1",
        cwd: project,
        tool_name: "activate_skill",
        tool_input: { name: "front-table" }
      })
    );
    expect(geminiSignal).toMatchObject({ agent: "gemini", skill: "front-table" });

    // Preserve pre-existing settings and ensure idempotency on repeat runs.
    fs.writeFileSync(
      path.join(project, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] } })
    );
    const first = await installTelemetryHooks({ dest: project, targets: ["claude", "cursor", "gemini"] });
    expect(first.results.every((item) => item.status === "installed")).toBe(true);

    const claudeCfg = JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8"));
    expect(claudeCfg.permissions.allow).toEqual(["Bash(npm test:*)"]);
    expect(claudeCfg.hooks.PostToolUse).toHaveLength(1);
    expect(fs.existsSync(path.join(project, ".cursor", "hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".gemini", "settings.json"))).toBe(true);

    const second = await installTelemetryHooks({ dest: project, targets: ["claude", "cursor", "gemini"] });
    expect(second.results.every((item) => item.status === "already-configured")).toBe(true);
  });
});
