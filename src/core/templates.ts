/**
 * Template rendering and resolution (built-in and library-local templates).
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";

import { exists } from "../util/fs.js";
import { TEMPLATES_ROOT } from "../util/paths.js";
import type { Library } from "./library.js";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".py",
  ".sh",
  ".txt",
  ""
]);
// npm never publishes files named ".gitignore", so templates store them under an alias.
const FILE_ALIASES: Record<string, string> = { gitignore: ".gitignore" };

/**
 * Generic sentences of the built-in `templates/skill/SKILL.md`. The `template-unchanged` rule warns
 * while a skill still contains any of them, so scaffolds get real content before they are published.
 * Keep this list in sync with the template.
 */
export const TEMPLATE_BOILERPLATE: readonly string[] = [
  "Confirm the relevant scope, files, and expected output with the user request.",
  "Inspect the existing implementation or documentation before proposing changes.",
  "Apply focused changes that preserve repository conventions and public behavior unless a change is explicitly required.",
  "Run the narrowest useful validation and repair any issues introduced by the change.",
  "Use this skill when the user requests work related to"
];

/** Template variables, keyed by placeholder name (`{{name}}`, `{{metadata.domain}}`…). */
export type Variables = Record<string, unknown>;

/**
 * Replaces `{{key}}` placeholders. Keys may contain letters, digits, `_` and `.`, and unknown
 * keys are left untouched.
 *
 * @param text - Template text.
 * @param variables - Values to substitute.
 * @param format - Converts each value to text. @defaultValue `String`
 * @returns The rendered text.
 *
 * @example
 * ```ts
 * render("Hello {{name}} {{missing}}", { name: "skills" }); // "Hello skills {{missing}}"
 * ```
 */
export function render(text: string, variables: Variables, format: (value: unknown) => string = String): string {
  return text.replace(/\{\{([\w.]+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? format(variables[key]) : match
  );
}

/** Serialises a value as a single-line YAML scalar, quoted only when necessary. */
function yamlScalar(value: unknown): string {
  return stringify(String(value ?? ""), { lineWidth: 0 }).trimEnd();
}

/**
 * Renders a `SKILL.md` template. Values in the frontmatter are YAML-escaped (quoted when they
 * contain characters such as `:` or `#`), while values in the Markdown body are inserted as-is.
 *
 * @param text - Template content.
 * @param variables - Values to substitute.
 * @returns The rendered file.
 */
export function renderSkillMarkdown(text: string, variables: Variables): string {
  const match = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!match) return render(text, variables);
  return match[1] + render(match[2], variables, yamlScalar) + match[3] + render(text.slice(match[0].length), variables);
}

/** Options of {@link copyTemplateDir}. */
export interface CopyOptions {
  /** Values for `{{placeholders}}`. @defaultValue `{}` */
  variables?: Variables;
  /** Receives each relative path (posix, e.g. `references` or `assets/x.md`); return `true` to omit it. */
  skip?: (relativePath: string) => boolean;
  /**
   * Render placeholders in text files and apply file aliases (`gitignore` becomes `.gitignore`).
   * Set it to `false` for a raw copy, as `templates eject` does. @defaultValue `true`
   */
  render?: boolean;
}

/**
 * Copies a template folder recursively.
 *
 * - **Text files** (by extension) are rendered. `SKILL.md` goes through {@link renderSkillMarkdown}.
 * - **Other files** are copied byte for byte.
 *
 * @param source - Template folder.
 * @param destination - Target folder; created if missing.
 * @param options - Rendering options.
 * @param relative - Internal recursion state; leave empty.
 */
export async function copyTemplateDir(
  source: string,
  destination: string,
  options: CopyOptions = {},
  relative = ""
): Promise<void> {
  const { variables = {}, skip = () => false, render: shouldRender = true } = options;
  await fs.mkdir(path.join(destination, relative), { recursive: true });

  for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (skip(relativePath)) continue;

    if (entry.isDirectory()) {
      await copyTemplateDir(source, destination, options, relativePath);
      continue;
    }

    const targetName = shouldRender ? FILE_ALIASES[entry.name] || entry.name : entry.name;
    const from = path.join(source, relative, entry.name);
    const target = path.join(destination, relative, targetName);
    if (shouldRender && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      const text = await fs.readFile(from, "utf8");
      const rendered = entry.name === "SKILL.md" ? renderSkillMarkdown(text, variables) : render(text, variables);
      await fs.writeFile(target, rendered, "utf8");
    } else {
      await fs.copyFile(from, target);
    }
  }
}

/**
 * @param name - Built-in template name (`library` or `skill`).
 * @returns Absolute path of the template folder shipped with skanvil.
 */
export function builtinTemplate(name: string): string {
  return path.join(TEMPLATES_ROOT, name);
}

/**
 * Resolves the template folder for a new skill. Whole folders are resolved; files are not
 * merged across levels.
 *
 * The first existing folder wins:
 * 1. `<lib>/<templates.dir>/<explicit>` when `explicit` is given (an error if it does not exist).
 * 2. `<lib>/<templates.dir>/skill-<categoryId>`
 * 3. `<lib>/<templates.dir>/skill`
 * 4. The built-in `templates/skill`.
 *
 * @param library - Library whose `templates.dir` is searched.
 * @param categoryId - Category of the new skill.
 * @param explicit - Template folder name passed with `--template`.
 * @returns Absolute path of the template folder.
 * @throws Error when `explicit` is given but not found.
 */
export async function resolveSkillTemplate(library: Library, categoryId: string, explicit?: string): Promise<string> {
  const localRoot = path.join(library.root, library.config.templates.dir);
  if (explicit) {
    const candidate = path.join(localRoot, explicit);
    if (await exists(candidate)) return candidate;
    throw new Error(`Template '${explicit}' not found in ${localRoot}.`);
  }
  for (const candidate of [path.join(localRoot, `skill-${categoryId}`), path.join(localRoot, "skill")]) {
    if (await exists(candidate)) return candidate;
  }
  return builtinTemplate("skill");
}

/**
 * Copies the built-in skill template, unrendered, into the library so it can be customised.
 *
 * @param library - Target library.
 * @param categoryId - When given, ejects to `skill-<id>`, which is used only for that category.
 *   Otherwise ejects to `skill`, which is used for all categories.
 * @param force - Overwrite an existing folder. @defaultValue `false`
 * @returns Absolute path of the ejected template.
 * @throws Error when the folder exists and `force` is false, or the category is unknown.
 */
export async function ejectSkillTemplate(library: Library, categoryId?: string, force = false): Promise<string> {
  const folder = categoryId ? `skill-${library.categories.resolve(categoryId).id}` : "skill";
  const target = path.join(library.root, library.config.templates.dir, folder);
  if ((await exists(target)) && !force) {
    throw new Error(`Template folder already exists: ${target} (use --force to overwrite).`);
  }
  await fs.rm(target, { recursive: true, force: true });
  await copyTemplateDir(builtinTemplate("skill"), target, { render: false });
  return target;
}
