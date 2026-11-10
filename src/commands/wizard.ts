/**
 * Interactive wizard: `skanvil` without arguments (in a terminal) or `skanvil wizard`.
 *
 * It detects whether the current folder is a skills library and offers the matching actions
 * through menus. Every action calls the same core functions as the CLI commands and then prints
 * the equivalent non-interactive command, so users learn the flags for scripts and CI.
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";

import { checkbox, confirm, input, select } from "@inquirer/prompts";
import pc from "picocolors";

import { installAgentSkill } from "../core/agent-skill.js";
import { resolveConfig, type RawCategory } from "../core/config.js";
import { doctor } from "../core/doctor.js";
import { createLibrary } from "../core/init.js";
import { Library } from "../core/library.js";
import { toKebabCase, toTitleCase } from "../core/naming.js";
import { editSkill, removeSkill, scaffoldSkill } from "../core/skills.js";
import { resolveSource, syncSkills, type TargetResult, type TargetScope } from "../core/sync.js";
import { validateLibrary } from "../core/validate.js";
import { exists, isEmptyOrMissing } from "../util/fs.js";
import { Output } from "../util/output.js";
import { displayPath, packageVersion } from "../util/paths.js";
import { isInteractive, printValidation } from "./shared.js";
import { collectSkills, listCommand } from "./skills.js";

/** Options of {@link wizardCommand}. */
export interface WizardOptions {
  /** Folder the wizard starts in. @defaultValue `process.cwd()` */
  cwd?: string;
  /** Skip the terminal check (used by tests, which drive the prompts programmatically). */
  skipTtyCheck?: boolean;
}

/** Mutable wizard state: the folder being worked on changes after `init`. */
interface State {
  cwd: string;
}

/** Agents offered by the wizard, mapped to sync target presets. */
const AGENT_CHOICES = [
  { value: "claude", project: ".claude/skills", user: "~/.claude/skills", label: "Claude Code" },
  { value: "copilot", project: ".github/skills", user: "~/.copilot/skills", label: "GitHub Copilot" },
  { value: "agents", project: ".agents/skills", user: "~/.agents/skills", label: "Codex and other agents" }
] as const;

const DEFAULT_PROFILE = ["front", "back", "transversal"] as const;
const PREFIX_PATTERN = /^(_|[a-z0-9]+(?:-[a-z0-9]+)*-)$/;

/**
 * Formats arguments as a shell command, quoting only the ones that need it.
 *
 * @param args - Command and arguments.
 * @returns The command line.
 *
 * @example
 * ```ts
 * formatCommand(["skanvil", "add", "--description", "Reviews APIs."]); // skanvil add --description "Reviews APIs."
 * ```
 */
export function formatCommand(args: string[]): string {
  // Backslashes are left alone so Windows paths stay readable and paste correctly into any shell.
  return args.map((arg) => (/^[\w@%+=:,./\\~-]+$/.test(arg) ? arg : `"${arg.replace(/(["$`])/g, "\\$1")}"`)).join(" ");
}

function showCommand(args: string[]): void {
  console.log(`${pc.dim("  Equivalent command:")} ${pc.cyan(formatCommand(["skanvil", ...args]))}`);
}

/** `-C <path>` when the library is not the folder the user launched skanvil from. */
function cwdArgs(library: Library): string[] {
  return path.resolve(process.cwd()) === library.root ? [] : ["-C", displayPath(library.root)];
}

function isExitPrompt(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
}

async function tryOpen(cwd: string): Promise<Library | null> {
  try {
    return await Library.open(cwd);
  } catch {
    return null;
  }
}

function heading(text: string): void {
  console.log(`\n${pc.bold(text)}`);
}

// ---------------------------------------------------------------------------------------------
// Library creation
// ---------------------------------------------------------------------------------------------

/** Asks for custom categories until the result is a valid configuration. */
async function promptCategories(): Promise<RawCategory[]> {
  console.log(
    pc.dim(
      "  Each category has a folder prefix (e.g. mobile-) and a README section. A default category\n" +
        "  without prefix is added at the end for skills that fit none of them."
    )
  );
  for (;;) {
    const categories: RawCategory[] = [];
    do {
      const id = toKebabCase(
        await input({
          message: "Category id (e.g. mobile)",
          required: true,
          validate: (value) => {
            const candidate = toKebabCase(value);
            if (!candidate) return "Use letters and digits.";
            return categories.some((category) => category.id === candidate) ? "That id is already used." : true;
          }
        })
      );
      const prefix = await input({
        message: "Folder prefix",
        default: `${id}-`,
        validate: (value) => {
          if (!PREFIX_PATTERN.test(value)) return "Use '_' or kebab-case ending in '-', e.g. mobile-";
          return categories.some((category) => category.prefix === value) ? "That prefix is already used." : true;
        }
      });
      const title = await input({ message: "README section title", default: toTitleCase(id.replace(/-/g, " ")) });
      categories.push({ id, prefix, title });
    } while (await confirm({ message: "Add another category?", default: false }));

    const defaultId = toKebabCase(
      await input({
        message: "Default category for skills without prefix",
        default: "general",
        validate: (value) =>
          categories.some((category) => category.id === toKebabCase(value)) ? "That id is already used." : true
      })
    );
    categories.push({ id: defaultId, prefix: "", title: toTitleCase(defaultId.replace(/-/g, " ")), default: true });

    if (
      await confirm({
        message: "Add an internal category (_name) for skills that only help maintain the library?",
        default: false
      })
    ) {
      categories.push({ id: "internal", prefix: "_", title: "Internal", indexed: false, validated: false });
    }

    try {
      resolveConfig({ categories });
      return categories;
    } catch (error) {
      console.log(pc.red((error as Error).message));
      console.log(pc.yellow("Let's try again."));
    }
  }
}

async function promptTargets(message: string, scope: TargetScope, defaults: readonly string[]): Promise<string[]> {
  return checkbox({
    message,
    required: true,
    choices: AGENT_CHOICES.map((choice) => ({
      value: choice.value,
      name: `${choice.label} ${pc.dim(scope === "user" ? choice.user : choice.project)}`,
      checked: defaults.includes(choice.value)
    }))
  });
}

async function createLibraryFlow(state: State): Promise<void> {
  heading("Create a new skills library");
  const dir = await input({
    message: "Folder for the new library",
    default: "my-skills",
    validate: async (value) => {
      if (!value.trim()) return "A folder is required.";
      return (await isEmptyOrMissing(path.resolve(state.cwd, value))) ? true : "That folder exists and is not empty.";
    }
  });
  const target = path.resolve(state.cwd, dir);
  const name = await input({ message: "Library name", default: toKebabCase(path.basename(target)) || "my-skills" });
  const scope = await input({ message: "npm scope (optional, e.g. acme)", default: "" });
  const description = await input({ message: "One-line description (optional)", default: "" });

  const layout = await select({
    message: "How do you want to organise skills?",
    choices: [
      {
        value: "preset",
        name: "Front / Back / Transversal",
        description: "front-* and back-* skills, unprefixed transversal skills and _internal helpers"
      },
      { value: "custom", name: "My own categories", description: "e.g. mobile-*, data-*, platform-*" },
      { value: "flat", name: "No categories", description: "a single list of skills without prefixes" }
    ]
  });

  let profile: string[] | undefined;
  let categories: RawCategory[] | undefined;
  if (layout === "preset") {
    profile = await checkbox({
      message: "README sections to create",
      required: true,
      choices: DEFAULT_PROFILE.map((id) => ({ value: id, name: toTitleCase(id), checked: true }))
    });
  } else if (layout === "custom") {
    categories = await promptCategories();
  } else {
    categories = [{ id: "skill", title: "Skills", default: true }];
  }

  const targets = await promptTargets("Which agents will use these skills?", "project", ["claude"]);
  const agentSkill = await confirm({
    message: "Install the skanvil agent skill so those agents can manage the library for you?",
    default: true
  });
  const git = await confirm({ message: "Initialise a git repository?", default: true });

  const result = await createLibrary(target, {
    name,
    scope: scope || undefined,
    description: description || undefined,
    profile: profile?.join(","),
    categories,
    syncTargets: targets,
    agentSkill,
    git
  });

  console.log(pc.green(`\n✔ Created library '${result.name}' in ${displayPath(result.target)}`));
  for (const installed of result.agentSkill) {
    console.log(pc.green(`✔ Installed the skanvil agent skill in ${displayPath(installed.path)}`));
  }
  const args = ["init", displayPath(target)];
  if (name !== toKebabCase(path.basename(target))) args.push("--name", name);
  if (scope) args.push("--scope", scope);
  if (description) args.push("--description", description);
  if (profile && profile.length < DEFAULT_PROFILE.length) args.push("--profile", profile.join(","));
  if (targets.join(",") !== "claude") args.push("--target", targets.join(","));
  if (!agentSkill) args.push("--no-agent-skill");
  if (!git) args.push("--no-git");
  showCommand(args);
  if (categories)
    console.log(pc.dim("  (custom categories were written to .skanvilrc.json; the command has no flag for them)"));
  console.log(pc.dim(`  Run 'npm install' in ${displayPath(result.target)} to add skanvil as a dev dependency.`));

  state.cwd = result.target;
}

// ---------------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------------

async function listTemplates(library: Library): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(library.root, library.config.templates.dir), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function addSkillFlow(library: Library): Promise<void> {
  heading("Add a skill");
  const categories = library.categories;
  const type = await select({
    message: "Category",
    default: categories.default.id,
    choices: categories.list.map((category) => ({
      value: category.id,
      name: `${category.title} ${pc.dim(category.prefix ? `${category.prefix}…` : "(no prefix)")}`,
      description: category.indexed ? undefined : "Not listed in the README, not validated, never synced."
    }))
  });

  const name = await input({
    message: "Skill name",
    required: true,
    validate: async (value) => {
      try {
        const skillName = categories.buildName(type, value);
        return (await exists(library.skillPath(skillName)))
          ? `${library.config.skillsDir}/${skillName} already exists.`
          : true;
      } catch (error) {
        return (error as Error).message;
      }
    }
  });
  const skillName = categories.buildName(type, name);
  console.log(pc.dim(`  → ${library.config.skillsDir}/${skillName}`));

  const defaultTitle = categories.buildTitle(type, name);
  const title = await input({ message: "Title", default: defaultTitle });
  const description = await input({
    message: "Description: what it does and when to use it",
    required: true,
    validate: (value) => (value.trim().length <= 1024 ? true : "The spec allows at most 1024 characters.")
  });
  const folders = await checkbox({
    message: "Extra folders",
    choices: [
      { value: "references", name: "references/ (long guidance loaded on demand)", checked: true },
      { value: "scripts", name: "scripts/ (helpers the agent can run)", checked: true },
      { value: "assets", name: "assets/ (output templates, static files)", checked: true }
    ]
  });

  const templates = await listTemplates(library);
  let template: string | undefined;
  if (templates.length > 0) {
    const chosen = await select({
      message: "Template",
      choices: [
        { value: "", name: "Automatic (category template, library template or built-in)" },
        ...templates.map((value) => ({ value, name: value }))
      ]
    });
    template = chosen || undefined;
  }

  const result = await scaffoldSkill(library, {
    type,
    name,
    title,
    description,
    includeReferences: folders.includes("references"),
    includeScripts: folders.includes("scripts"),
    includeAssets: folders.includes("assets"),
    template
  });

  console.log(pc.green(`\n✔ Created ${displayPath(result.target)}`));
  printValidation(new Output("add"), await validateLibrary(library));
  const args = ["add", ...cwdArgs(library), "--type", type, "--name", name];
  if (title !== defaultTitle) args.push("--title", title);
  args.push("--description", description);
  for (const folder of ["assets", "references", "scripts"]) {
    if (!folders.includes(folder)) args.push(`--no-${folder}`);
  }
  if (template) args.push("--template", template);
  showCommand(args);
  console.log(
    pc.dim(`  Next: write the real instructions in ${displayPath(path.join(result.target, "SKILL.md"))}.`) +
      pc.dim("\n  The generic template text keeps a 'template-unchanged' warning until you replace it.")
  );
}

async function pickSkill(library: Library, message: string): Promise<string | null> {
  const skills = await collectSkills(library);
  if (skills.length === 0) {
    console.log(pc.yellow("This library has no skills yet."));
    return null;
  }
  return select({
    message,
    pageSize: 15,
    choices: skills.map((skill) => ({
      value: skill.name,
      name: `${skill.name} ${pc.dim(`(${skill.type})`)}`,
      description: skill.description || undefined
    }))
  });
}

async function editSkillFlow(library: Library): Promise<void> {
  heading("Edit a skill");
  const skill = await pickSkill(library, "Which skill?");
  if (!skill) return;
  const current = library.categories.fromFolder(skill);

  const action = await select({
    message: `What do you want to do with ${skill}?`,
    choices: [
      { value: "rename", name: "Rename it" },
      { value: "move", name: "Move it to another category" },
      { value: "title", name: "Change its title" },
      { value: "description", name: "Change its description" },
      { value: "remove", name: pc.red("Delete it") }
    ]
  });

  if (action === "remove") {
    const sure = await confirm({ message: `Delete ${skill} permanently? This cannot be undone.`, default: false });
    if (!sure) return;
    await removeSkill(library, skill);
    console.log(pc.green(`\n✔ Removed ${skill}`));
    showCommand(["edit", skill, ...cwdArgs(library), "--remove", "--yes"]);
    return;
  }

  const options: { rename?: string; type?: string; title?: string; description?: string } = {};
  let flag: string;
  if (action === "rename") {
    flag = "--rename";
    options.rename = await input({
      message: `New name (the ${current.prefix || "no"} prefix is applied automatically)`,
      default: library.categories.stripPrefix(skill),
      required: true
    });
  } else if (action === "move") {
    flag = "--type";
    options.type = await select({
      message: "New category",
      choices: library.categories.list
        .filter((category) => category.id !== current.id)
        .map((category) => ({
          value: category.id,
          name: `${category.title} ${pc.dim(category.prefix || "(no prefix)")}`
        }))
    });
  } else if (action === "title") {
    flag = "--title";
    options.title = await input({ message: "New title", default: (await library.describeSkill(skill)).title });
  } else {
    flag = "--description";
    options.description = await input({
      message: "New description",
      default: (await library.describeSkill(skill)).description,
      required: true
    });
  }

  const result = await editSkill(library, skill, options);
  const arrow = result.skillName !== skill ? ` → ${result.skillName}` : "";
  console.log(pc.green(`\n✔ Updated ${skill}${arrow}`));
  printValidation(new Output("edit"), await validateLibrary(library));
  showCommand(["edit", skill, ...cwdArgs(library), flag, String(Object.values(options)[0])]);
}

async function checkFlow(library: Library): Promise<void> {
  heading("Check the library");
  const result = await validateLibrary(library);
  printValidation(new Output("validate"), result);
  showCommand(["validate", ...cwdArgs(library)]);

  const fixable = result.diagnostics.filter((diagnostic) => diagnostic.fixable).length;
  if (fixable === 0) return;
  if (!(await confirm({ message: `Apply ${fixable} automatic fix(es)?`, default: true }))) return;

  const fixed = await doctor(library, { fix: true });
  for (const fix of fixed.fixes) console.log(pc.green(`  ✔ ${fix}`));
  printValidation(new Output("doctor"), fixed.after!);
  showCommand(["doctor", ...cwdArgs(library), "--fix"]);
}

// ---------------------------------------------------------------------------------------------
// Installing skills
// ---------------------------------------------------------------------------------------------

function summarise(results: TargetResult[]): number {
  let changes = 0;
  for (const result of results) {
    changes += result.added.length + result.updated.length + result.removed.length;
    console.log(
      `  ${pc.bold(result.target)} ${pc.dim(displayPath(result.path))}: ` +
        `${result.added.length} to add, ${result.updated.length} to update, ` +
        `${result.removed.length} to remove, ${result.unchanged.length} up to date`
    );
    for (const name of result.added) console.log(pc.green(`    + ${name}`));
    for (const name of result.updated) console.log(pc.yellow(`    ~ ${name}`));
    for (const name of result.removed) console.log(pc.red(`    - ${name}`));
    for (const entry of result.skipped) console.log(pc.dim(`    skipped ${entry.skill}: ${entry.reason}`));
  }
  return changes;
}

/** Shared by the "sync" actions: asks where, previews with a dry run, then applies. */
async function syncFlow(library: Library, state: State, from?: string): Promise<void> {
  const where = await select({
    message: "Install the skills where?",
    choices: [
      { value: "project", name: "Into a project folder" },
      { value: "user", name: "For my user, available in every project" }
    ]
  });
  const scope: TargetScope = where === "user" ? "user" : "project";

  let dest = state.cwd;
  if (scope === "project" && !from) {
    const answer = await input({
      message: "Project folder",
      default: displayPath(path.dirname(library.root)),
      validate: async (value) => ((await exists(path.resolve(state.cwd, value))) ? true : "That folder does not exist.")
    });
    dest = path.resolve(state.cwd, answer);
  }

  const configured = library.config.sync.targets.filter((target) => AGENT_CHOICES.some((c) => c.value === target));
  const targets = await promptTargets("For which agents?", scope, configured.length ? configured : ["claude"]);

  const preview = await syncSkills(library, { dest, targets, scope, dryRun: true });
  console.log(pc.dim("\n  Preview:"));
  if (summarise(preview) === 0) {
    console.log(pc.green("\n✔ Everything is already up to date."));
    return;
  }
  if (!(await confirm({ message: "Apply these changes?", default: true }))) return;

  await syncSkills(library, { dest, targets, scope });
  console.log(pc.green("\n✔ Skills installed."));

  const args = ["sync"];
  if (scope === "project" && !from) args.push(displayPath(dest));
  if (from) args.push("--from", from);
  else args.push(...cwdArgs(library));
  if (scope === "user") args.push("--global");
  args.push("--target", targets.join(","));
  showCommand(args);
}

async function syncFromFlow(state: State): Promise<void> {
  heading("Install skills from a library into this folder");
  const from = await input({
    message: "Library folder or installed npm package (e.g. ../my-skills or @acme/my-skills)",
    required: true,
    validate: async (value) => {
      try {
        await Library.open(await resolveSource(value, state.cwd));
        return true;
      } catch (error) {
        return (error as Error).message;
      }
    }
  });
  const library = await Library.open(await resolveSource(from, state.cwd));
  await syncFlow(library, state, from);
}

async function agentSkillFlow(state: State): Promise<void> {
  heading("Install or update the skanvil agent skill");
  console.log(pc.dim("  It teaches coding agents how to use skanvil: commands, rules and how to fix each diagnostic."));
  const where = await select({
    message: "Install it where?",
    choices: [
      { value: "project", name: `In this folder ${pc.dim(state.cwd)}` },
      { value: "user", name: "For my user, available in every project" }
    ]
  });
  const scope: TargetScope = where === "user" ? "user" : "project";
  const targets = await promptTargets("For which agents?", scope, ["claude"]);

  let results = await installAgentSkill({ dest: state.cwd, targets, scope });
  const skipped = results.filter((result) => result.status === "skipped");
  if (
    skipped.length > 0 &&
    (await confirm({
      message: `${skipped.map((result) => displayPath(result.path)).join(", ")} already contains a 'skanvil' skill that skanvil did not install. Replace it?`,
      default: false
    }))
  ) {
    results = await installAgentSkill({ dest: state.cwd, targets, scope, force: true });
  }
  for (const result of results) {
    const line = `${result.target}: ${result.status} ${displayPath(result.path)}`;
    console.log(result.status === "skipped" ? pc.yellow(`  ${line}`) : pc.green(`  ✔ ${line}`));
  }

  const args = ["install-skill"];
  if (scope === "user") args.push("--global");
  else if (path.resolve(process.cwd()) !== state.cwd) args.push(displayPath(state.cwd));
  args.push("--target", targets.join(","));
  showCommand(args);
}

// ---------------------------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------------------------

/**
 * `skanvil wizard`, also run by `skanvil` without arguments in a terminal: a menu-driven assistant.
 *
 * - **Inside a library:** add, edit, list, check, install the skills, or install the agent skill.
 * - **Elsewhere:** create a library, install skills from one, or install the agent skill.
 *
 * Errors inside an action are reported and the menu is shown again. Ctrl+C or "Exit" ends the wizard.
 *
 * @param options - Starting folder.
 * @returns Exit code (0 when the user exits).
 * @throws Error when the terminal is not interactive.
 */
export async function wizardCommand(options: WizardOptions = {}): Promise<number> {
  if (!options.skipTtyCheck && !isInteractive()) {
    throw new Error("The wizard needs an interactive terminal. Run 'skanvil --help' to see the commands.");
  }
  const state: State = { cwd: path.resolve(options.cwd ?? process.cwd()) };
  console.log(`${pc.bold("skanvil")} ${pc.dim(`${packageVersion()} · interactive mode · Ctrl+C to quit`)}`);

  try {
    for (;;) {
      const library = await tryOpen(state.cwd);
      let action: string;

      if (library) {
        const count = (await library.listSkillFolders()).length;
        action = await select({
          message: `Library ${pc.cyan(library.config.name ?? path.basename(library.root))} (${count} skill${count === 1 ? "" : "s"}). What do you want to do?`,
          choices: [
            { value: "add", name: "Add a skill" },
            {
              value: "edit",
              name: "Edit, rename, move or delete a skill",
              disabled: count === 0 ? "(no skills yet)" : false
            },
            { value: "list", name: "List skills" },
            { value: "check", name: "Check the library (validate and repair)" },
            { value: "sync", name: "Install the skills into a project or for my user" },
            { value: "agent", name: "Install or update the skanvil agent skill" },
            { value: "exit", name: "Exit" }
          ]
        });
      } else {
        action = await select({
          message: `This folder (${path.basename(state.cwd)}) is not a skills library. What do you want to do?`,
          choices: [
            { value: "init", name: "Create a new skills library" },
            { value: "sync-from", name: "Install skills from a library into this folder" },
            { value: "agent", name: "Install or update the skanvil agent skill" },
            { value: "exit", name: "Exit" }
          ]
        });
      }

      if (action === "exit") {
        console.log(pc.dim("Bye."));
        return 0;
      }

      try {
        if (action === "init") await createLibraryFlow(state);
        else if (action === "sync-from") await syncFromFlow(state);
        else if (action === "agent") await agentSkillFlow(state);
        else if (library && action === "add") await addSkillFlow(library);
        else if (library && action === "edit") await editSkillFlow(library);
        else if (library && action === "list") await listCommand({ cwd: library.root });
        else if (library && action === "check") await checkFlow(library);
        else if (library && action === "sync") {
          heading("Install the skills");
          await syncFlow(library, state);
        }
      } catch (error) {
        if (isExitPrompt(error)) throw error;
        console.log(pc.red(`✖ ${(error as Error).message}`));
      }
      console.log("");
    }
  } catch (error) {
    if (isExitPrompt(error)) {
      console.log(pc.dim("\nBye."));
      return 0;
    }
    throw error;
  }
}
