/**
 * Wizard tests. `@inquirer/prompts` is mocked with a queue of answers: each prompt takes the next
 * answer (or its default for `DEFAULT`), runs the prompt's own `validate`, and when the queue is
 * empty it behaves like Ctrl+C, which ends the wizard.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const prompts = vi.hoisted(() => {
  const DEFAULT = Symbol("default");
  const queue: unknown[] = [];
  const asked: string[] = [];

  async function next(config: { message: string; default?: unknown; validate?: (value: never) => unknown }) {
    asked.push(config.message);
    if (queue.length === 0) {
      throw Object.assign(new Error("User force closed the prompt"), { name: "ExitPromptError" });
    }
    let value = queue.shift();
    if (value === DEFAULT) value = config.default;
    if (config.validate) {
      const verdict = await config.validate(value as never);
      if (verdict !== true)
        throw new Error(`Answer ${JSON.stringify(value)} rejected for "${config.message}": ${verdict}`);
    }
    return value;
  }

  return { DEFAULT, queue, asked, next };
});

vi.mock("@inquirer/prompts", () => ({
  input: prompts.next,
  select: prompts.next,
  checkbox: prompts.next,
  confirm: prompts.next
}));

import { formatCommand, wizardCommand } from "../src/commands/wizard.js";
import { createLibrary } from "../src/core/init.js";
import { scaffoldSkill } from "../src/core/skills.js";

const { DEFAULT } = prompts;
let output: string[] = [];

beforeEach(() => {
  prompts.queue.length = 0;
  prompts.asked.length = 0;
  output = [];
  const capture = (...args: unknown[]) => void output.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skanvil-wizard-"));
}

const text = () => stripVTControlCharacters(output.join("\n"));

async function run(cwd: string, ...answers: unknown[]): Promise<number> {
  prompts.queue.push(...answers);
  const code = await wizardCommand({ cwd, skipTtyCheck: true });
  expect(prompts.queue).toEqual([]); // every scripted answer was consumed
  return code;
}

async function library(): Promise<string> {
  const root = path.join(tmp(), "lib");
  await createLibrary(root, { git: false, agentSkill: false });
  await scaffoldSkill(root, { type: "front", name: "a", description: "A" });
  return root;
}

test("formatCommand quotes only what needs quoting", () => {
  expect(formatCommand(["skanvil", "add", "--name", "api review", "--description", 'Say "hi"', "-C", "../lib"])).toBe(
    'skanvil add --name "api review" --description "Say \\"hi\\"" -C ../lib'
  );
  expect(formatCommand(["skanvil", "-C", "C:\\Users\\me\\my lib", "-C", "C:\\tmp\\lib"])).toBe(
    'skanvil -C "C:\\Users\\me\\my lib" -C C:\\tmp\\lib'
  );
});

test("refuses to start without an interactive terminal", async () => {
  await expect(wizardCommand({ cwd: tmp() })).rejects.toThrow(/interactive terminal/);
});

describe("outside a library", () => {
  test("creates a library with the preset, then continues inside it to add a skill", async () => {
    const dir = tmp();
    const code = await run(
      dir,
      "init",
      "my-lib", // folder
      DEFAULT, // name
      "", // scope
      "", // description
      "preset",
      ["front", "back"],
      ["claude", "copilot"],
      true, // agent skill
      false, // git
      // now inside the new library
      "add",
      "front",
      "api review",
      DEFAULT, // title
      "Reviews API changes",
      ["references"],
      "exit"
    );

    expect(code).toBe(0);
    const root = path.join(dir, "my-lib");
    const rc = JSON.parse(fs.readFileSync(path.join(root, ".skanvilrc.json"), "utf8"));
    expect(rc.sync.targets).toEqual(["claude", "copilot"]);
    expect(rc.categories.map((category: { id: string }) => category.id)).toEqual([
      "front",
      "back",
      "transversal",
      "internal"
    ]);
    expect(fs.existsSync(path.join(root, ".github", "skills", "skanvil", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    expect(fs.readdirSync(path.join(root, "skills", "front-api-review")).sort()).toEqual(["SKILL.md", "references"]);

    const out = text();
    expect(out).toMatch(
      /Equivalent command: skanvil init .*my-lib --profile front,back --target claude,copilot --no-git/
    );
    expect(out).toMatch(
      /skanvil add .*--type front --name "api review" --description "Reviews API changes" --no-assets --no-scripts/
    );
    expect(out).toMatch(/template-unchanged/);
  });

  test("creates a library with custom categories", async () => {
    const dir = tmp();
    await run(
      dir,
      "init",
      "apps",
      DEFAULT,
      "acme",
      "Mobile skills",
      "custom",
      "mobile",
      DEFAULT, // prefix mobile-
      DEFAULT, // title Mobile
      false, // no more categories
      "general",
      true, // internal category
      ["claude"],
      false,
      false,
      "exit"
    );

    const root = path.join(dir, "apps");
    const rc = JSON.parse(fs.readFileSync(path.join(root, ".skanvilrc.json"), "utf8"));
    expect(rc.scope).toBe("acme");
    expect(rc.categories).toEqual([
      { id: "mobile", prefix: "mobile-", title: "Mobile" },
      { id: "general", prefix: "", title: "General", default: true },
      { id: "internal", prefix: "_", title: "Internal", indexed: false, validated: false }
    ]);
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme).toMatch(/<strong>Mobile<\/strong>/);
    expect(readme).toMatch(/<strong>General<\/strong>/);
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(false);
    expect(text()).toMatch(/custom categories were written to \.skanvilrc\.json/);
  });

  test("rejects a non-empty folder for a new library", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "busy"));
    fs.writeFileSync(path.join(dir, "busy", "file.txt"), "x");
    prompts.queue.push("init", "busy");
    await wizardCommand({ cwd: dir, skipTtyCheck: true });
    expect(text()).toMatch(/That folder exists and is not empty/);
  });

  test("installs the agent skill in the current folder", async () => {
    const dir = tmp();
    await run(dir, "agent", "project", ["agents"], "exit");
    expect(fs.existsSync(path.join(dir, ".agents", "skills", "skanvil", "SKILL.md"))).toBe(true);
    expect(text()).toMatch(/skanvil install-skill .*--target agents/);
  });
});

describe("inside a library", () => {
  test("moves a skill to another category, then deletes it", async () => {
    const root = await library();
    await run(root, "edit", "front-a", "move", "back", "edit", "back-a", "remove", true, "exit");
    expect(fs.existsSync(path.join(root, "skills", "front-a"))).toBe(false);
    expect(fs.existsSync(path.join(root, "skills", "back-a"))).toBe(false);
    expect(text()).toMatch(/Updated front-a → back-a/);
    expect(text()).toMatch(/skanvil edit back-a .*--remove --yes/);
  });

  test("deleting asks for confirmation and keeps the skill on 'no'", async () => {
    const root = await library();
    await run(root, "edit", "front-a", "remove", false, "exit");
    expect(fs.existsSync(path.join(root, "skills", "front-a"))).toBe(true);
  });

  test("check offers automatic fixes", async () => {
    const root = await library();
    const file = path.join(root, "skills", "front-a", "SKILL.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("name: front-a", "name: wrong"));

    await run(root, "check", true, "exit");
    expect(fs.readFileSync(file, "utf8")).toMatch(/^name: front-a$/m);
    expect(text()).toMatch(/set frontmatter name to the folder name/);
    expect(text()).toMatch(/skanvil doctor .*--fix/);
  });

  test("installs the skills into a project after a preview", async () => {
    const root = await library();
    const project = tmp();
    await run(root, "sync", "project", project, ["claude", "copilot"], true, "exit");
    expect(fs.existsSync(path.join(project, ".claude", "skills", "front-a", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".github", "skills", "front-a", "SKILL.md"))).toBe(true);
    expect(text()).toMatch(/\+ front-a/);

    output = [];
    await run(root, "sync", "project", project, ["claude"], "exit");
    expect(text()).toMatch(/Everything is already up to date/);
  });

  test("declining the preview writes nothing and returns to the menu", async () => {
    const root = await library();
    const project = tmp();
    await run(root, "sync", "project", project, ["claude"], false, "exit");
    expect(fs.existsSync(path.join(project, ".claude"))).toBe(false);
    expect(prompts.asked.filter((message) => /What do you want to do/.test(message))).toHaveLength(2);
  });

  test("an error inside an action is reported and the menu comes back", async () => {
    const root = await library();
    // A library whose README lost its closing tag makes `add` fail after the prompts.
    const readme = path.join(root, "README.md");
    fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace(/<\/details>/g, ""));
    await run(root, "add", "front", "b", DEFAULT, "B", [], "exit");
    expect(text()).toMatch(/✖ README closing <\/details> tag not found/);
    expect(prompts.asked.filter((message) => /What do you want to do/.test(message))).toHaveLength(2);
  });
});
