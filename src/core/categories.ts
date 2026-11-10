/**
 * Category lookup and skill naming.
 *
 * @module
 */
import type { Category } from "./config.js";
import { toKebabCase, toTitleCase } from "./naming.js";

/**
 * Resolves categories and builds skill names from a library's configured categories.
 *
 * @remarks Folder names map to categories by prefix: the longest matching prefix wins, and folders
 * without any known prefix belong to the default category.
 *
 * @example
 * ```ts
 * const categories = new Categories(resolveConfig().categories);
 * categories.buildName("backend", "Queue Worker"); // "back-queue-worker"
 * categories.fromFolder("_tools").id;               // "internal"
 * ```
 */
export class Categories {
  /** Categories in configuration order. */
  readonly list: Category[];

  /**
   * @param list - Resolved categories; must contain exactly one default category
   *   (guaranteed by {@link resolveConfig}).
   */
  constructor(list: Category[]) {
    this.list = list;
  }

  /** The fallback category for folders without a known prefix. */
  get default(): Category {
    return this.list.find((category) => category.default)!;
  }

  /** Categories listed in the README index, in configuration order. */
  get indexed(): Category[] {
    return this.list.filter((category) => category.indexed);
  }

  /** @returns Every category id, in configuration order. */
  ids(): string[] {
    return this.list.map((category) => category.id);
  }

  /**
   * @param id - Exact category id (aliases are not considered).
   * @returns The category, or `undefined` when there is none with that id.
   */
  byId(id: string): Category | undefined {
    return this.list.find((category) => category.id === id);
  }

  /**
   * Finds an indexed category by its README section title (case-insensitive).
   *
   * @param title - README section title, e.g. `"Backend"`.
   * @returns The category, or `undefined` when no indexed category has that title.
   */
  byTitle(title: string): Category | undefined {
    const key = title.trim().toLowerCase();
    return this.indexed.find((category) => category.title.toLowerCase() === key);
  }

  /**
   * Resolves a category from user input.
   *
   * @param value - Category id or alias (case-insensitive, surrounding whitespace ignored).
   * @returns The matching category.
   * @throws Error `Invalid skill type '<value>'` listing the allowed ids when nothing matches.
   */
  resolve(value: unknown): Category {
    const key = String(value ?? "")
      .trim()
      .toLowerCase();
    const found = this.list.find((category) => category.id === key || category.aliases.includes(key));
    if (!found) {
      throw new Error(`Invalid skill type '${value}'. Allowed values: ${this.ids().join(", ")}.`);
    }
    return found;
  }

  /**
   * Infers the category of a skill folder.
   *
   * @param folderName - Skill folder name, e.g. `front-api-review`.
   * @returns The category with the longest prefix matching the start of the name, or the
   *   default category when none matches.
   *
   * @example
   * ```ts
   * categories.fromFolder("front-x").id; // "front"
   * categories.fromFolder("x").id;       // "transversal" (the default)
   * ```
   */
  fromFolder(folderName: string): Category {
    let best: Category | undefined;
    for (const category of this.list) {
      if (category.prefix && folderName.startsWith(category.prefix)) {
        if (!best || category.prefix.length > best.prefix.length) best = category;
      }
    }
    return best ?? this.default;
  }

  /**
   * Removes every known category prefix from the start of a name, repeatedly
   * (`_back-x` becomes `x`).
   *
   * @param name - Skill name or folder name.
   * @returns The name without category prefixes.
   */
  stripPrefix(name: string): string {
    let current = name;
    for (;;) {
      const category = this.fromFolder(current);
      if (!category.prefix || !current.startsWith(category.prefix)) return current;
      current = current.slice(category.prefix.length);
    }
  }

  /**
   * Builds the folder name of a skill: the category prefix plus the kebab-cased base name.
   * Any category prefix already present in `rawName` is replaced.
   *
   * @param type - Category id or alias.
   * @param rawName - Free-form name, e.g. `"API review"` or `"front-api-review"`.
   * @returns The skill folder name.
   * @throws Error when the category is unknown or the name is empty after normalisation.
   *
   * @example
   * ```ts
   * categories.buildName("front", "front-api review"); // "front-api-review"
   * categories.buildName("internal", "tools");          // "_tools"
   * ```
   */
  buildName(type: unknown, rawName: unknown): string {
    const category = this.resolve(type);
    const base = this.stripPrefix(toKebabCase(rawName));
    if (!base) {
      throw new Error("Skill name is required.");
    }
    return `${category.prefix}${base}`;
  }

  /**
   * Returns the display title of a skill.
   *
   * @param type - Category id or alias.
   * @param rawName - Free-form name used to derive a title.
   * @param explicitTitle - Title to use as-is when non-empty.
   * @returns `explicitTitle` trimmed, or the title-cased base name (`api-review` becomes `Api Review`).
   * @throws Error under the same conditions as {@link Categories.buildName}.
   */
  buildTitle(type: unknown, rawName: unknown, explicitTitle?: unknown): string {
    if (explicitTitle && String(explicitTitle).trim()) {
      return String(explicitTitle).trim();
    }
    const base = this.stripPrefix(this.buildName(type, rawName));
    return toTitleCase(base.replace(/-/g, " "));
  }
}
