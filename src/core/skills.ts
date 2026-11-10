/**
 * Skill lifecycle operations: create, edit and remove, keeping each skill folder, its frontmatter
 * and the README index in sync.
 *
 * @module
 */
import fs from "node:fs/promises";

import { exists } from "../util/fs.js";
import type { Category } from "./config.js";
import { Library } from "./library.js";
import { ensureSentence, lowerFirst } from "./naming.js";
import { buildEntry, getEntry, insertEntry, removeEntry, replaceEntry } from "./readme-index.js";
import type { SkillFile } from "./skill.js";
import { copyTemplateDir, resolveSkillTemplate } from "./templates.js";

/** A {@link Library} instance or the path of a library root. */
export type LibraryRef = Library | string;

/**
 * Normalises a {@link LibraryRef}.
 *
 * @param ref - Library instance (returned as-is) or root path (opened with {@link Library.open}).
 * @returns The library.
 * @throws Error when the path is not a library.
 */
export async function toLibrary(ref: LibraryRef): Promise<Library> {
  return typeof ref === "string" ? Library.open(ref) : ref;
}

function buildResources(includeAssets: boolean, includeReferences: boolean, includeScripts: boolean): string {
  const lines: string[] = [];
  if (includeReferences) lines.push("- Use `references/REFERENCE.md` for deep domain guidance and edge cases.");
  if (includeScripts) lines.push("- Use scripts in `scripts/` when repeated automation improves reliability.");
  if (includeAssets) lines.push("- Use assets in `assets/` for output templates or reusable static content.");
  return lines.length > 0
    ? lines.join("\n")
    : "- Keep the workflow self-contained when no extra resources are required.";
}

/**
 * Writes a category's `metadata` entries and `compatibility` into the frontmatter. An empty
 * `compatibility` is removed when the category has none, because the spec requires 1-500 characters.
 */
function applyCategory(skill: SkillFile, category: Category): void {
  for (const [key, value] of Object.entries(category.metadata)) {
    skill.set(["metadata", key], value);
  }
  if (category.compatibility) {
    skill.set(["compatibility"], category.compatibility);
  } else if (!skill.getString("compatibility")) {
    skill.delete(["compatibility"]);
  }
}

/** Options of {@link scaffoldSkill}. */
export interface AddSkillOptions {
  /** Category id or alias. */
  type: string;
  /** Free-form name; it is kebab-cased and prefixed with the category prefix. */
  name: string;
  /** Display title. @defaultValue derived from the name */
  title?: string;
  /** What the skill does and when to use it; a final period is added if missing. */
  description: string;
  /** Copy the template's `assets/` folder. @defaultValue `true` */
  includeAssets?: boolean;
  /** Copy the template's `references/` folder. @defaultValue `true` */
  includeReferences?: boolean;
  /** Copy the template's `scripts/` folder. @defaultValue `true` */
  includeScripts?: boolean;
  /** Name of a template folder under the library's templates dir (see {@link resolveSkillTemplate}). */
  template?: string;
}

/** Result of {@link scaffoldSkill}. */
export interface AddSkillResult {
  /** Folder name of the new skill. */
  skillName: string;
  /** Display title written to the heading and README. */
  title: string;
  /** Resolved category id. */
  type: string;
  /** Absolute path of the new skill folder. */
  target: string;
  /** Absolute path of the template folder that was used. */
  template: string;
}

/**
 * Creates a skill folder from a template and registers it in the README index.
 *
 * @remarks
 * - The template is chosen by {@link resolveSkillTemplate}.
 * - The category's metadata and compatibility are applied to the frontmatter.
 * - Skills of non-indexed categories are not added to the README.
 * - If the README update fails, the new folder is removed again.
 *
 * @param ref - Library or library root.
 * @param options - Skill details.
 * @returns What was created.
 * @throws Error when the category is unknown, the name or description is empty, the folder
 *   already exists, the README cannot be read, or the named template does not exist.
 *
 * @example
 * ```ts
 * const { skillName } = await scaffoldSkill("./my-skills", {
 *   type: "front",
 *   name: "API review",
 *   description: "Reviews API integration changes"
 * });
 * // skillName === "front-api-review"
 * ```
 */
export async function scaffoldSkill(ref: LibraryRef, options: AddSkillOptions): Promise<AddSkillResult> {
  const library = await toLibrary(ref);
  const category = library.categories.resolve(options.type);
  const skillName = library.categories.buildName(category.id, options.name);
  const title = library.categories.buildTitle(category.id, options.name, options.title);
  const description = ensureSentence(options.description);
  const includeAssets = options.includeAssets !== false;
  const includeReferences = options.includeReferences !== false;
  const includeScripts = options.includeScripts !== false;

  if (!description) {
    throw new Error("Skill description is required.");
  }

  const target = library.skillPath(skillName);
  if (await exists(target)) {
    throw new Error(`Skill folder already exists: ${target}`);
  }

  // Read the README first so a missing README fails before anything is written.
  const readme = category.indexed ? await library.readReadme() : null;
  const template = await resolveSkillTemplate(library, category.id, options.template);

  await copyTemplateDir(template, target, {
    variables: {
      name: skillName,
      title,
      description,
      descriptionLower: lowerFirst(description),
      category: category.id,
      domain: category.metadata.domain ?? category.id,
      compatibility: category.compatibility ?? "",
      resources: buildResources(includeAssets, includeReferences, includeScripts),
      ...Object.fromEntries(Object.entries(category.metadata).map(([key, value]) => [`metadata.${key}`, value]))
    },
    skip: (relativePath) =>
      (!includeAssets && relativePath === "assets") ||
      (!includeReferences && relativePath === "references") ||
      (!includeScripts && relativePath === "scripts")
  });

  try {
    if (await library.hasSkill(skillName)) {
      const skill = await library.readSkill(skillName);
      if (skill.isValidYaml) {
        applyCategory(skill, category);
        await library.writeSkill(skillName, skill);
      }
    }

    if (readme) {
      readme.text = insertEntry(
        readme.text,
        category.title,
        buildEntry({ title, description, skillName }, library.skillsDirRef)
      );
      await library.writeReadme(readme);
    }
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }

  return { skillName, title, type: category.id, target, template };
}

/** Options of {@link editSkill}. At least one must change something. */
export interface EditSkillOptions {
  /** New base name; the (new) category prefix is applied automatically. */
  rename?: string;
  /** New category id or alias. Moves the README entry and updates metadata and compatibility. */
  type?: string;
  /** New title for the `# heading` and the README entry. */
  title?: string;
  /** New description for the frontmatter and the README entry. */
  description?: string;
}

/**
 * Renames, retypes, retitles or redescribes a skill. The folder, the frontmatter `name`, the
 * heading and the README entry are kept in sync.
 *
 * @remarks Transactional:
 * 1. The new `SKILL.md` and README are computed in memory.
 * 2. Both files are written.
 * 3. The folder is renamed last.
 *
 * If any step fails, both files are restored and the error is rethrown as "Edit failed and was rolled back".
 *
 * @param ref - Library or library root.
 * @param skillName - Current folder name.
 * @param options - Changes to apply.
 * @returns The new and previous folder names.
 * @throws Error when the skill does not exist, nothing would change, the target folder exists,
 *   the frontmatter is invalid, or the write/rename fails (after rolling back).
 *
 * @example
 * ```ts
 * await editSkill(lib, "front-api-review", { rename: "http-review", type: "back" });
 * // -> skills/back-http-review, listed under "Backend"
 * ```
 */
export async function editSkill(
  ref: LibraryRef,
  skillName: string,
  options: EditSkillOptions
): Promise<{ skillName: string; previousName: string }> {
  const library = await toLibrary(ref);
  await library.requireSkill(skillName);

  const oldCategory = library.categories.fromFolder(skillName);
  const newCategory = options.type ? library.categories.resolve(options.type) : oldCategory;
  const newName = library.categories.buildName(newCategory.id, options.rename || skillName);
  const description = options.description ? ensureSentence(options.description) : "";
  const title = options.title ? String(options.title).trim() : "";

  if (newName === skillName && !description && !title) {
    throw new Error("Nothing to edit. Provide --rename, --type, --title or --description.");
  }
  if (newName !== skillName && (await exists(library.skillPath(newName)))) {
    throw new Error(`Skill folder already exists: ${library.skillPath(newName)}`);
  }

  // 1. Compute the new SKILL.md.
  const skillFile = library.skillFilePath(skillName);
  const originalSkill = await fs.readFile(skillFile, "utf8");
  const skill = await library.readSkill(skillName);
  skill.set(["name"], newName);
  if (description) skill.set(["description"], description);
  if (title) skill.setTitle(title);
  if (newCategory.id !== oldCategory.id) applyCategory(skill, newCategory);

  // 2. Compute the new README.
  const readme = await library.readReadme();
  const originalReadme = { ...readme };
  const dir = library.skillsDirRef;
  const existing = getEntry(readme.text, skillName, dir);
  const entry = buildEntry(
    {
      title: title || existing?.title || skill.title || library.categories.buildTitle(newCategory.id, newName),
      description: description || existing?.description || skill.getString("description"),
      skillName: newName
    },
    dir
  );
  if (!newCategory.indexed) {
    readme.text = removeEntry(readme.text, skillName, dir);
  } else if (existing && oldCategory.id === newCategory.id) {
    readme.text = replaceEntry(readme.text, skillName, entry, dir);
  } else {
    readme.text = insertEntry(removeEntry(readme.text, skillName, dir), newCategory.title, entry);
  }

  // 3. Write, then rename; roll back on failure.
  try {
    await fs.writeFile(skillFile, skill.toString(), "utf8");
    await library.writeReadme(readme);
    if (newName !== skillName) {
      await fs.rename(library.skillPath(skillName), library.skillPath(newName));
    }
  } catch (error) {
    await fs.writeFile(skillFile, originalSkill, "utf8").catch(() => undefined);
    await library.writeReadme(originalReadme).catch(() => undefined);
    throw new Error(`Edit failed and was rolled back: ${(error as Error).message}`);
  }

  return { skillName: newName, previousName: skillName };
}

/**
 * Permanently deletes a skill folder and removes its README entry.
 *
 * @param ref - Library or library root.
 * @param skillName - Folder name.
 * @throws Error when the skill does not exist.
 */
export async function removeSkill(ref: LibraryRef, skillName: string): Promise<void> {
  const library = await toLibrary(ref);
  await library.requireSkill(skillName);
  const readme = await library.readReadmeOrEmpty();
  await fs.rm(library.skillPath(skillName), { recursive: true, force: true });
  if (readme.text) {
    readme.text = removeEntry(readme.text, skillName, library.skillsDirRef);
    await library.writeReadme(readme);
  }
}
