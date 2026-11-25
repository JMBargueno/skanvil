/**
 * CLI handlers for `add`, `edit` and `list`.
 *
 * Every handler returns the process exit code: 0 on success, 1 on failure.
 *
 * @module
 */
import path from "node:path";
import { confirm, input, select } from "@inquirer/prompts";

import { SKILL_STATUSES } from "../core/config.js";
import { importSkills } from "../core/import.js";
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
  /** `--owner`: metadata owner. */
  owner?: string;
  /** `--status`: metadata status. */
  status?: string;
  /** `--replaced-by`: replacement skill folder. */
  replacedBy?: string;
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
  /** `--status`: only list skills with this `metadata.status`. */
  status?: string;
  /** `--owner`: only list skills with this `metadata.owner`. */
  owner?: string;
}

/** Filters accepted by {@link collectSkills}. */
export interface ListFilterOptions {
  /** Category id or alias. */
  category?: string;
  /** Lifecycle status (`draft`, `experimental`, `active`, `deprecated`). */
  status?: string;
  /** Owner (`metadata.owner`, matched case-insensitively). */
  owner?: string;
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
  /** Optional `metadata.status` value when set. */
  status?: string;
  /** Optional `metadata.owner` value when set. */
  owner?: string;
  /** Optional `metadata.replaced-by` value when set. */
  replacedBy?: string;
  /** Frontmatter description collapsed to one line. */
  description: string;
}

/**
 * Collects the category, README presence, validity, lifecycle metadata and description of every
 * matching skill folder.
 *
 * @param library - Library to list.
 * @param filter - Optional category string or {@link ListFilterOptions}.
 * @returns One row per skill folder, sorted by name.
 * @throws Error when `category` or `status` is unknown.
 */
export async function collectSkills(library: Library, filter?: string | ListFilterOptions): Promise<ListedSkill[]> {
  const opts: ListFilterOptions = typeof filter === "string" ? { category: filter } : (filter ?? {});
  const statusFilter = opts.status ? opts.status.trim().toLowerCase() : undefined;
  if (statusFilter && !(SKILL_STATUSES as readonly string[]).includes(statusFilter)) {
    throw new Error(`Invalid status '${opts.status}'. Allowed values: ${SKILL_STATUSES.join(", ")}.`);
  }
  const ownerFilter = opts.owner ? opts.owner.trim().toLowerCase() : undefined;

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
  const categoryFilter = opts.category ? library.categories.resolve(opts.category).id : null;

  const skills: ListedSkill[] = [];
  for (const name of await library.listSkillFolders()) {
    const cat = library.categories.fromFolder(name);
    if (categoryFilter && cat.id !== categoryFilter) continue;
    const info = await library.describeSkill(name);

    let status = "";
    let owner = "";
    let replacedBy = "";
    try {
      const skill = await library.readSkillRendered(name).catch(() => library.readSkill(name));
      status = skill.getString("metadata", "status");
      owner = skill.getString("metadata", "owner");
      replacedBy = skill.getString("metadata", "replaced-by");
    } catch {
      // Unreadable or missing SKILL.md.
    }

    if (statusFilter && status.toLowerCase() !== statusFilter) continue;
    if (ownerFilter && owner.toLowerCase() !== ownerFilter) continue;

    skills.push({
      name,
      type: cat.id,
      indexed: cat.indexed ? documented.has(name) : null,
      valid: cat.validated ? !invalid.has(name) : null,
      ...(status ? { status } : {}),
      ...(owner ? { owner } : {}),
      ...(replacedBy ? { replacedBy } : {}),
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
  const skills = await collectSkills(library, {
    category: options.category,
    status: options.status,
    owner: options.owner
  });
  if (options.json) {
    console.log(JSON.stringify(skills, null, 2));
    return 0;
  }
  if (skills.length === 0) {
    console.log("No skills found. Create one with 'skanvil add'.");
    return 0;
  }

  const showStatus = skills.some((skill) => Boolean(skill.status));
  const showOwner = skills.some((skill) => Boolean(skill.owner));
  const width = Math.max(5, ...skills.map((skill) => skill.name.length));
  const typeWidth = Math.max(4, ...skills.map((skill) => skill.type.length));
  const statusWidth = showStatus ? Math.max(6, ...skills.map((skill) => (skill.status ?? "-").length)) : 0;
  const ownerWidth = showOwner ? Math.max(5, ...skills.map((skill) => (skill.owner ?? "-").length)) : 0;
  const extraWidth = (showStatus ? statusWidth + 2 : 0) + (showOwner ? ownerWidth + 2 : 0);
  const maxDescription = Math.max(20, (process.stdout.columns || 120) - width - typeWidth - extraWidth - 26);

  const header = [
    "SKILL".padEnd(width),
    "TYPE".padEnd(typeWidth),
    "IN README".padEnd(9),
    "VALID".padEnd(5),
    ...(showStatus ? ["STATUS".padEnd(statusWidth)] : []),
    ...(showOwner ? ["OWNER".padEnd(ownerWidth)] : []),
    "DESCRIPTION"
  ].join("  ");
  console.log(header);
  for (const skill of skills) {
    const rawDescription =
      skill.status === "deprecated" && skill.replacedBy
        ? `[deprecated -> ${skill.replacedBy}] ${skill.description}`
        : skill.description;
    const description =
      rawDescription.length > maxDescription ? `${rawDescription.slice(0, maxDescription - 1)}…` : rawDescription;
    console.log(
      [
        skill.name.padEnd(width),
        skill.type.padEnd(typeWidth),
        mark(skill.indexed).padEnd(9),
        mark(skill.valid).padEnd(5),
        ...(showStatus ? [(skill.status ?? "-").padEnd(statusWidth)] : []),
        ...(showOwner ? [(skill.owner ?? "-").padEnd(ownerWidth)] : []),
        description
      ].join("  ")
    );
  }
  return 0;
}

/** Options of `skanvil import`. */
export interface ImportOptions extends CommonOptions {
  /** `--type`: category id or alias to apply when importing skills. */
  type?: string;
  /** `--skill`: only import specific skill(s). */
  skill?: string[];
  /** `--dry-run`: preview imports without modifying files. */
  dryRun?: boolean;
  /** `--overwrite`: replace existing skills of the same name. */
  overwrite?: boolean;
  /** `--skip-validate`: skip validation after importing. */
  skipValidate?: boolean;
}

/**
 * `skanvil import <sourceDir>`: imports existing skill folders into the library, normalising
 * frontmatter, updating the README index, and validating afterwards.
 *
 * @param sourceDir - Folder of skill directories or a single skill folder with `SKILL.md`.
 * @param options - Parsed CLI options.
 * @returns Exit code (`0` on success, `1` when post-import validation finds errors).
 */
export async function importCommand(sourceDir: string, options: ImportOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("import", options.json);
  const skills = (options.skill ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  const result = await importSkills(library, path.resolve(sourceDir), {
    type: options.type,
    skills: skills.length > 0 ? skills : undefined,
    dryRun: options.dryRun,
    overwrite: options.overwrite
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const prefix = result.dryRun ? "(dry run) " : "";
  for (const item of result.imported) {
    const note = item.changes.length > 0 ? ` (${item.changes.join(", ")})` : "";
    const tag = item.status === "overwritten" ? "~" : "+";
    out.print(`   ${tag} ${item.target} [${item.type}]${note}`);
  }
  for (const item of result.skipped) {
    out.warn(`   skipped ${item.target}: ${item.reason}`);
  }
  out.success(`${prefix}Imported ${result.imported.length} skill(s), skipped ${result.skipped.length}.`);

  if (result.dryRun || result.imported.length === 0) return 0;
  return validateAfter(library, "import", options.skipValidate);
}
