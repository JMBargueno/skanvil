/**
 * CLI handlers for `add`, `edit` and `list`.
 *
 * Every handler returns the process exit code: 0 on success, 1 on failure.
 *
 * @module
 */
import { confirm, input, select } from "@inquirer/prompts";

import type { Library } from "../core/library.js";
import { editSkill, removeSkill, scaffoldSkill } from "../core/skills.js";
import { validateLibrary } from "../core/validate.js";
import { Output } from "../util/output.js";
import { displayPath } from "../util/paths.js";
import { isInteractive, openLibrary, validateAfter, type CommonOptions } from "./shared.js";

/** Options of `skanvil add`. Negated flags arrive from commander as `assets: false` and so on. */
export interface AddOptions extends CommonOptions {
  /** `--type`: category id or alias. */
  type?: string;
  /** `--name`: skill name. */
  name?: string;
  /** `--title`: display title. */
  title?: string;
  /** `--description`: what the skill does and when to use it. */
  description?: string;
  /** `false` with `--no-assets`. */
  assets?: boolean;
  /** `false` with `--no-references`. */
  references?: boolean;
  /** `false` with `--no-scripts`. */
  scripts?: boolean;
  /** `--template`: custom template folder name. */
  template?: string;
  /** `--skip-validate`. */
  skipValidate?: boolean;
}

/**
 * Prompts for whatever `add` is missing. The category is a select list built from the
 * configured categories.
 *
 * @throws Error when the terminal is not interactive.
 */
async function promptMissing(library: Library, options: AddOptions) {
  if (!isInteractive()) {
    throw new Error(
      "Missing required arguments for non-interactive execution. Provide --type, --name and --description."
    );
  }
  const type =
    options.type ||
    (await select({
      message: "Skill category",
      default: library.categories.default.id,
      choices: library.categories.list.map((category) => ({
        value: category.id,
        name: category.prefix ? `${category.id} (${category.prefix}*)` : category.id
      }))
    }));
  const name = options.name || (await input({ message: "Skill name", required: true }));
  const title =
    options.title || (await input({ message: "Skill title", default: library.categories.buildTitle(type, name) }));
  const description =
    options.description ||
    (await input({ message: "Skill description (what it does and when to use it)", required: true }));
  return { type, name, title, description };
}

/**
 * `skanvil add`: creates a skill. It prompts for missing values in a terminal, then validates the
 * library unless `--skip-validate` or `--json` is given.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code.
 */
export async function addCommand(options: AddOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("add", options.json);
  const answers =
    options.type && options.name && options.description
      ? { type: options.type, name: options.name, title: options.title, description: options.description }
      : await promptMissing(library, options);

  const result = await scaffoldSkill(library, {
    ...answers,
    includeAssets: options.assets !== false,
    includeReferences: options.references !== false,
    includeScripts: options.scripts !== false,
    template: options.template
  });

  out.info(`Created skill: ${result.skillName}`);
  out.info(`Target folder: ${displayPath(result.target)}`);
  out.data(result);
  return options.json ? 0 : validateAfter(library, "add", options.skipValidate);
}

/** Options of `skanvil edit`. */
export interface EditOptions extends CommonOptions {
  /** `--rename`: new base name. */
  rename?: string;
  /** `--type`: new category. */
  type?: string;
  /** `--title`: new title. */
  title?: string;
  /** `--description`: new description. */
  description?: string;
  /** `--remove`: delete the skill. */
  remove?: boolean;
  /** `--yes`: skip the delete confirmation. */
  yes?: boolean;
  /** `--skip-validate`. */
  skipValidate?: boolean;
}

/**
 * `skanvil edit <skill>`: edits or removes a skill.
 *
 * Removal asks for confirmation unless `--yes` is given, and refuses outside a terminal.
 *
 * @param skillName - Skill folder name.
 * @param options - Parsed CLI options.
 * @returns Exit code.
 */
export async function editCommand(skillName: string, options: EditOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("edit", options.json);

  if (options.remove) {
    await library.requireSkill(skillName);
    if (!options.yes) {
      if (!isInteractive()) {
        throw new Error("Refusing to delete without confirmation. Re-run with --yes.");
      }
      if (!(await confirm({ message: `Delete skill '${skillName}' permanently?`, default: false }))) {
        out.info("Cancelled.");
        return 0;
      }
    }
    await removeSkill(library, skillName);
    out.info(`Removed skill: ${skillName}`);
    out.data({ removed: skillName });
  } else {
    const result = await editSkill(library, skillName, options);
    const arrow = result.skillName !== result.previousName ? ` -> ${result.skillName}` : "";
    out.info(`Updated skill: ${result.previousName}${arrow}`);
    out.data(result);
  }

  return options.json ? 0 : validateAfter(library, "edit", options.skipValidate);
}

/** Options of `skanvil list`. */
export interface ListOptions extends CommonOptions {
  /** `--category`: only list this category (id or alias). */
  category?: string;
}

/** A row of `skanvil list` (also its `--json` output). */
export interface ListedSkill {
  /** Folder name. */
  name: string;
  /** Category id. */
  type: string;
  /** Listed in the README; `null` for non-indexed categories. */
  indexed: boolean | null;
  /** Free of skill-level validation errors; `null` for non-validated categories. */
  valid: boolean | null;
  /** Frontmatter description collapsed to one line. */
  description: string;
}

/**
 * Collects the category, README presence, validity and description of every skill folder.
 *
 * @param library - Library to list.
 * @param category - Optional category id or alias to filter by.
 * @returns One row per skill folder, sorted by name.
 * @throws Error when `category` is unknown.
 */
export async function collectSkills(library: Library, category?: string): Promise<ListedSkill[]> {
  const readme = await library.readReadmeOrEmpty();
  const documented = new Set<string>();
  for (const names of library.documentedByCategory(readme.text).values())
    for (const name of names) documented.add(name);

  const validation = await validateLibrary(library).catch(() => null);
  const invalid = new Set(
    (validation?.diagnostics ?? [])
      .filter(
        (diagnostic) => diagnostic.severity === "error" && diagnostic.skill && !diagnostic.rule.startsWith("readme-")
      )
      .map((diagnostic) => diagnostic.skill!)
  );
  const filter = category ? library.categories.resolve(category).id : null;

  const skills: ListedSkill[] = [];
  for (const name of await library.listSkillFolders()) {
    const cat = library.categories.fromFolder(name);
    if (filter && cat.id !== filter) continue;
    const info = await library.describeSkill(name);
    skills.push({
      name,
      type: cat.id,
      indexed: cat.indexed ? documented.has(name) : null,
      valid: cat.validated ? !invalid.has(name) : null,
      description: info.description.replace(/\s+/g, " ").trim()
    });
  }
  return skills;
}

function mark(value: boolean | null): string {
  return value === null ? "-" : value ? "yes" : "NO";
}

/**
 * `skanvil list`: prints a table, or JSON with `--json`. Descriptions are truncated to the
 * terminal width.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code (always 0 unless an error is thrown).
 */
export async function listCommand(options: ListOptions): Promise<number> {
  const library = await openLibrary(options);
  const skills = await collectSkills(library, options.category);
  if (options.json) {
    console.log(JSON.stringify(skills, null, 2));
    return 0;
  }
  if (skills.length === 0) {
    console.log("No skills found. Create one with 'skanvil add'.");
    return 0;
  }

  const width = Math.max(5, ...skills.map((skill) => skill.name.length));
  const typeWidth = Math.max(4, ...skills.map((skill) => skill.type.length));
  const maxDescription = Math.max(20, (process.stdout.columns || 120) - width - typeWidth - 26);
  console.log(
    `${"SKILL".padEnd(width)}  ${"TYPE".padEnd(typeWidth)}  ${"IN README".padEnd(9)}  ${"VALID".padEnd(5)}  DESCRIPTION`
  );
  for (const skill of skills) {
    const description =
      skill.description.length > maxDescription
        ? `${skill.description.slice(0, maxDescription - 1)}…`
        : skill.description;
    console.log(
      `${skill.name.padEnd(width)}  ${skill.type.padEnd(typeWidth)}  ${mark(skill.indexed).padEnd(9)}  ${mark(skill.valid).padEnd(5)}  ${description}`
    );
  }
  return 0;
}
