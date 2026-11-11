/**
 * The {@link Library} class: the single entry point for reading and writing a skills library.
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";

import { fromLf, splitEol, type Eol } from "../util/eol.js";
import { exists } from "../util/fs.js";
import { Categories } from "./categories.js";
import { loadConfig, resolveConfig, type Category, type ResolvedConfig } from "./config.js";
import { toTitleCase } from "./naming.js";
import { readParams, renderTemplate, resolveParamValues, type ParamDefinitions } from "./params.js";
import { getEntry, parseIndex } from "./readme-index.js";
import { SkillFile } from "./skill.js";

/** README content normalised to LF, plus the line ending to restore when writing. */
export interface ReadmeText {
  /** Content with LF line endings. */
  text: string;
  /** Line ending of the file on disk. */
  eol: Eol;
}

/** Summary of a skill used for README entries and listings. */
export interface SkillInfo {
  /** Folder name. */
  name: string;
  /** Category inferred from the folder name. */
  category: Category;
  /** Display title. */
  title: string;
  /** Description, possibly multi-line when it comes from a YAML block scalar. */
  description: string;
}

/**
 * A skills library on disk: its configuration, skill folders and README index.
 *
 * @remarks Every file access of the core goes through this class. README and SKILL.md content is
 * handled internally with LF line endings, and the original line ending is restored on write, so
 * CRLF files stay CRLF.
 *
 * @example
 * ```ts
 * const library = await Library.open("./my-skills");
 * for (const name of await library.listSkillFolders()) {
 *   const skill = await library.readSkill(name);
 *   console.log(name, library.categories.fromFolder(name).id, skill.getString("description"));
 * }
 * ```
 */
export class Library {
  /** Absolute library root. */
  readonly root: string;
  /** Resolved configuration. */
  readonly config: ResolvedConfig;
  /** Category helper built from {@link Library.config}. */
  readonly categories: Categories;

  /**
   * Creates a library handle without touching the disk. Prefer {@link Library.open} for existing libraries.
   *
   * @param root - Library root (resolved to an absolute path).
   * @param config - Resolved configuration. @defaultValue the default preset
   */
  constructor(root: string, config: ResolvedConfig = resolveConfig()) {
    this.root = path.resolve(root);
    this.config = config;
    this.categories = new Categories(config.categories);
  }

  /**
   * Opens an existing library: loads `.skanvilrc.json` and checks that the skills folder exists.
   *
   * @param root - Library root folder.
   * @returns The library.
   * @throws Error when the config is invalid or the skills folder is missing.
   */
  static async open(root: string): Promise<Library> {
    const library = new Library(root, await loadConfig(path.resolve(root)));
    if (!(await exists(library.skillsDir))) {
      throw new Error(
        `No ${library.config.skillsDir}/ folder found in ${library.root}. Run 'skanvil init' first or use --cwd.`
      );
    }
    return library;
  }

  /** Absolute path of the skills folder. */
  get skillsDir(): string {
    return path.join(this.root, this.config.skillsDir);
  }

  /** Skills folder as written in README entries (posix separators), e.g. `skills`. */
  get skillsDirRef(): string {
    return this.config.skillsDir.split(path.sep).join("/");
  }

  /** Absolute path of the README holding the index. */
  get readmePath(): string {
    return path.join(this.root, this.config.readme);
  }

  /**
   * @param name - Skill folder name.
   * @returns Absolute path of the skill folder (it may not exist).
   */
  skillPath(name: string): string {
    return path.join(this.skillsDir, name);
  }

  /**
   * @param name - Skill folder name.
   * @returns Absolute path of the skill's `SKILL.md` (it may not exist).
   */
  skillFilePath(name: string): string {
    return path.join(this.skillPath(name), "SKILL.md");
  }

  /**
   * Lists the skill folders. Hidden folders (starting with `.`) are ignored.
   *
   * @returns Folder names sorted with `localeCompare`.
   */
  async listSkillFolders(): Promise<string[]> {
    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * @param name - Skill folder name.
   * @returns Whether the folder contains a `SKILL.md`.
   */
  async hasSkill(name: string): Promise<boolean> {
    return exists(this.skillFilePath(name));
  }

  /**
   * Asserts that a skill exists.
   *
   * @param name - Skill folder name.
   * @throws Error `Skill '<name>' not found` when there is no `SKILL.md`.
   */
  async requireSkill(name: string): Promise<void> {
    if (!(await this.hasSkill(name))) {
      throw new Error(`Skill '${name}' not found in ${this.skillsDir}.`);
    }
  }

  /**
   * Reads and parses a skill's `SKILL.md`.
   *
   * @param name - Skill folder name.
   * @returns The parsed file.
   * @throws The file system error when the file cannot be read.
   */
  async readSkill(name: string): Promise<SkillFile> {
    return SkillFile.parse(await fs.readFile(this.skillFilePath(name), "utf8"));
  }

  /**
   * Reads a skill's parameter definitions (`params.json`).
   *
   * @param name - Skill folder name.
   * @returns The definitions, or `null` when the skill has none.
   * @throws Error when `params.json` exists but is invalid.
   */
  async readSkillParams(name: string): Promise<ParamDefinitions | null> {
    return readParams(this.skillPath(name));
  }

  /**
   * Reads a skill's `SKILL.md` rendered with parameter values. Skills without `params.json` are
   * returned as they are.
   *
   * @param name - Skill folder name.
   * @param values - Parameter values; missing ones take their defaults. @defaultValue `{}`
   * @returns The rendered file.
   * @throws Error when the file cannot be read, `params.json` is invalid, a value is invalid, or
   *   the template is malformed.
   */
  async readSkillRendered(name: string, values: Record<string, unknown> = {}): Promise<SkillFile> {
    const text = await fs.readFile(this.skillFilePath(name), "utf8");
    const params = await this.readSkillParams(name);
    if (!params) return SkillFile.parse(text);
    return SkillFile.parse(renderTemplate(text, resolveParamValues(params, values, name)));
  }

  /**
   * Writes a skill's `SKILL.md`, keeping the line ending it was read with.
   *
   * @param name - Skill folder name.
   * @param skill - File content to write.
   */
  async writeSkill(name: string, skill: SkillFile): Promise<void> {
    await fs.writeFile(this.skillFilePath(name), skill.toString(), "utf8");
  }

  /**
   * Reads the README.
   *
   * @returns The content normalised to LF and its original line ending.
   * @throws Error `Cannot read README.md` when the file is missing or unreadable.
   */
  async readReadme(): Promise<ReadmeText> {
    try {
      return splitEol(await fs.readFile(this.readmePath, "utf8"));
    } catch {
      throw new Error(`Cannot read ${this.config.readme} in ${this.root}.`);
    }
  }

  /**
   * Like {@link Library.readReadme}, but returns empty LF content instead of throwing.
   *
   * @returns The README, or `{ text: "", eol: "\n" }` when it cannot be read.
   */
  async readReadmeOrEmpty(): Promise<ReadmeText> {
    try {
      return await this.readReadme();
    } catch {
      return { text: "", eol: "\n" };
    }
  }

  /**
   * Writes the README, converting LF content back to its original line ending.
   *
   * @param readme - Content and line ending, usually from {@link Library.readReadme}.
   */
  async writeReadme(readme: ReadmeText): Promise<void> {
    await fs.writeFile(this.readmePath, fromLf(readme.text, readme.eol), "utf8");
  }

  /**
   * Lists the skills documented in each README section of the indexed categories.
   *
   * @param readmeText - README content (LF).
   * @returns Folder names keyed by category id. Every indexed category has an entry, which may be empty.
   */
  documentedByCategory(readmeText: string): Map<string, Set<string>> {
    const indexed = this.categories.indexed;
    const byTitle = parseIndex(
      readmeText,
      indexed.map((category) => category.title),
      this.skillsDirRef
    );
    const result = new Map<string, Set<string>>();
    for (const category of indexed) {
      result.set(category.id, byTitle.get(category.title) ?? new Set());
    }
    return result;
  }

  /**
   * Gathers the title and description of a skill.
   *
   * Sources, in order of preference:
   * 1. the first `# ` heading and the `description` field of `SKILL.md`;
   * 2. the README entry, when `readmeText` is given;
   * 3. a title derived from the folder name.
   *
   * @param name - Skill folder name.
   * @param readmeText - README content (LF), used as a fallback source.
   * @returns The skill summary. Never throws for a missing or broken `SKILL.md`.
   */
  async describeSkill(name: string, readmeText?: string): Promise<SkillInfo> {
    const category = this.categories.fromFolder(name);
    let title = "";
    let description = "";
    try {
      // Rendered with default parameter values, so the README never shows {{placeholders}}.
      const skill = await this.readSkillRendered(name).catch(() => this.readSkill(name));
      title = skill.title;
      description = skill.getString("description");
    } catch {
      // Missing SKILL.md: fall back to README / derived values.
    }
    if (readmeText !== undefined && (!title || !description)) {
      const entry = getEntry(readmeText, name, this.skillsDirRef);
      title ||= entry?.title ?? "";
      description ||= entry?.description ?? "";
    }
    title ||= toTitleCase(this.categories.stripPrefix(name).replace(/-/g, " "));
    return { name, category, title, description };
  }
}
