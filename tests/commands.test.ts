import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { collectSkills } from "../src/commands/skills.js";
import { AGENT_SKILL_VERSION_KEY, agentSkillSource, installAgentSkill } from "../src/core/agent-skill.js";
import { CONFIG_FILE } from "../src/core/config.js";
import { doctor } from "../src/core/doctor.js";
import { createLibrary, parseProfile } from "../src/core/init.js";
import { Library } from "../src/core/library.js";
import { rebuildIndex, reconcileIndex } from "../src/core/reindex.js";
import { editSkill, removeSkill, scaffoldSkill } from "../src/core/skills.js";
import { MANIFEST_FILE, resolveTarget, syncSkills } from "../src/core/sync.js";
import { ejectSkillTemplate } from "../src/core/templates.js";
import { packageVersion } from "../src/util/paths.js";
import { findBrokenReferences, validateLibrary } from "../src/core/validate.js";

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
    expect(pkg.devDependencies.skanvil).toBe("^1.0.0");
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
    await scaffoldSkill(root, { type: "front", name: "demo", description: "Demo" });
    await scaffoldSkill(root, { type: "back", name: "svc", description: "Service" });

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
      skillMd(root, "front-demo").replace("compatibility:", "compatibility:\t"),
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
    expect(
      JSON.parse(fs.readFileSync(path.join(project, ".claude", "skills", MANIFEST_FILE), "utf8")).skills
    ).toHaveProperty("back-b");
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
  test("the bundled skill passes skanvil's own default validation with no warnings", async () => {
    const root = await makeLibrary({ agentSkill: false });
    fs.cpSync(agentSkillSource(), path.join(root, "skills", "skanvil"), { recursive: true });
    const library = await Library.open(root);
    const { text } = await reconcileIndex(library, readme(root));
    fs.writeFileSync(path.join(root, "README.md"), text, "utf8");

    const result = await validateLibrary(library);
    expect(result.diagnostics).toEqual([]);
    expect(result.count).toBe(1);
  });

  test("init installs it in the library's sync targets", async () => {
    const root = await makeLibrary();
    const installed = path.join(root, ".claude", "skills", "skanvil", "SKILL.md");
    expect(fs.existsSync(installed)).toBe(true);
    expect(fs.readFileSync(installed, "utf8")).toMatch(
      new RegExp(`${AGENT_SKILL_VERSION_KEY}: "?${packageVersion().replace(/\./g, "\\.")}`)
    );
    expect(fs.existsSync(path.join(root, ".claude", "skills", "skanvil", "references", "REFERENCE.md"))).toBe(true);

    const skipped = await makeLibrary({ agentSkill: false });
    expect(fs.existsSync(path.join(skipped, ".claude"))).toBe(false);
  });

  test("install-skill installs, keeps, updates and never overwrites foreign folders", async () => {
    const project = tmp();
    const first = await installAgentSkill({ dest: project, targets: ["claude", "copilot"] });
    expect(first.map((result) => result.status)).toEqual(["installed", "installed"]);
    expect(fs.existsSync(path.join(project, ".github", "skills", "skanvil", "SKILL.md"))).toBe(true);

    let [claude] = await installAgentSkill({ dest: project, targets: ["claude"] });
    expect(claude.status).toBe("unchanged");

    const file = path.join(project, ".claude", "skills", "skanvil", "SKILL.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/skanvil-version: .*/, 'skanvil-version: "0.0.1"'));
    [claude] = await installAgentSkill({ dest: project, targets: ["claude"] });
    expect(claude.status).toBe("updated");

    const foreign = path.join(project, ".agents", "skills", "skanvil");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: skanvil\ndescription: mine\n---\n");
    let [agents] = await installAgentSkill({ dest: project, targets: ["agents"] });
    expect(agents.status).toBe("skipped");
    expect(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8")).toMatch(/description: mine/);

    [agents] = await installAgentSkill({ dest: project, targets: ["agents"], force: true });
    expect(agents.status).toBe("updated");
    expect(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8")).toMatch(/Operate skanvil/);
  });
});

describe("content rules", () => {
  test("template-unchanged warns until the generic scaffold text is replaced", async () => {
    const root = await makeLibrary();
    await scaffoldSkill(root, { type: "front", name: "demo", description: "Demo" });
    const library = await Library.open(root);
    let result = await validateLibrary(library);
    expect(result.errors).toBe(0);
    expect(result.diagnostics.map((d) => `${d.rule}:${d.severity}`)).toEqual(["template-unchanged:warn"]);

    const file = path.join(root, "skills", "front-demo", "SKILL.md");
    const content = fs.readFileSync(file, "utf8");
    const instructions = "## Instructions\n\n1. Read the component.\n2. Check the props.\n\n";
    fs.writeFileSync(
      file,
      content
        .replace(
          /## When to Activate This Skill[\s\S]*?(?=## Instructions)/,
          "## When to Activate This Skill\n\nWhen a component changes.\n\n"
        )
        .replace(/## Instructions[\s\S]*?(?=- Use `references)/, instructions),
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

    const [skill] = await installAgentSkill({ dest: "unused", targets: ["agents"], scope: "user", homeDir: home });
    expect(skill.path).toBe(path.join(home, ".agents", "skills", "skanvil"));
    expect(() => resolveTarget("x", "my/folder", { scope: "user", homeDir: home })).toThrow(/only accept presets/);
  });
});
