/**
 * `skanvil build`: turns a library's skills into an importable, typed package.
 *
 * It generates ESM (`index.mjs`) and CommonJS (`index.cjs`) modules with matching type
 * declarations. They export one function per publishable skill, which returns its `SKILL.md`
 * (rendered with parameters when the skill has a `params.json`), plus a `skills` list with every
 * file of each skill. The generated code has no dependencies, not even skanvil.
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";

import { listFiles } from "../util/fs.js";
import type { Library } from "./library.js";
import { PARAMS_FILE, renderTemplate, resolveParamValues, type ParamDefinitions } from "./params.js";
import { validateLibrary } from "./validate.js";

/** Options of {@link buildLibrary}. */
export interface BuildOptions {
  /** Output folder, relative to the library root. @defaultValue `"dist"` */
  outDir?: string;
  /** Build even when validation reports errors. @defaultValue `false` */
  force?: boolean;
}

/** One exported skill. */
export interface BuiltSkill {
  /** Skill folder name. */
  name: string;
  /** Name of the exported function. */
  exportName: string;
  /** Category id. */
  category: string;
  /** Declared parameter names. */
  params: string[];
}

/** Result of {@link buildLibrary}. */
export interface BuildResult {
  /** Absolute output folder. */
  outDir: string;
  /** Generated files, relative to the library root (posix). */
  files: string[];
  /** Exported skills, in folder order. */
  skills: BuiltSkill[];
}

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await arguments eval " +
    "skills getSkill renderTemplate resolveParamValues"
  ).split(" ")
);

function camelCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

/** Upper-cases the first character of an identifier that is already camelCase. */
function capitalize(identifier: string): string {
  return identifier.charAt(0).toUpperCase() + identifier.slice(1);
}

/**
 * Chooses export names: the folder name without its category prefix, in camelCase
 * (`front-api-review` becomes `apiReview`). Names that would collide fall back to the full folder
 * name (`frontReview`, `backReview`), and invalid or reserved identifiers get a `skill` prefix.
 *
 * @param library - Library whose categories define the prefixes.
 * @param names - Skill folder names.
 * @returns Export name by folder name.
 */
export function exportNames(library: Library, names: string[]): Map<string, string> {
  const fix = (name: string) => (/^[a-z]/.test(name) && !RESERVED.has(name) ? name : `skill${capitalize(name)}`);
  const short = new Map(names.map((name) => [name, fix(camelCase(library.categories.stripPrefix(name)))]));
  const counts = new Map<string, number>();
  for (const value of short.values()) counts.set(value, (counts.get(value) ?? 0) + 1);
  const result = new Map<string, string>();
  for (const name of names) {
    const candidate = short.get(name)!;
    result.set(name, counts.get(candidate)! > 1 ? fix(camelCase(name)) : candidate);
  }
  return result;
}

function isText(buffer: Buffer): boolean {
  return !buffer.includes(0) && Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer);
}

function docComment(lines: string[], indent = ""): string {
  const body = lines
    .flatMap((line) => line.split("\n"))
    .map((line) => `${indent} * ${line.replace(/\*\//g, "*\\/")}`.trimEnd());
  return `${indent}/**\n${body.join("\n")}\n${indent} */\n`;
}

function paramsType(definitions: ParamDefinitions): string {
  const entries = Object.entries(definitions).map(([name, definition]) => {
    const type =
      definition.type === "enum"
        ? definition.values.map((value) => JSON.stringify(value)).join(" | ")
        : definition.type === "boolean"
          ? "boolean"
          : "string";
    const doc = docComment(
      [
        ...(definition.description ? [definition.description] : []),
        `@defaultValue ${JSON.stringify(definition.default)}`
      ],
      "  "
    );
    return `${doc}  ${name}?: ${type};`;
  });
  return entries.length ? `{\n${entries.join("\n")}\n}` : "Record<string, never>";
}

interface SkillData {
  name: string;
  exportName: string;
  category: string;
  title: string;
  description: string;
  params: ParamDefinitions;
  template: string;
  files: Record<string, { encoding: "utf8" | "base64"; content: string }>;
}

function runtimeSource(skills: SkillData[]): string {
  const data = skills.map((skill) => ({
    name: skill.name,
    category: skill.category,
    title: skill.title,
    description: skill.description,
    params: skill.params,
    template: skill.template,
    files: skill.files
  }));
  return `const renderTemplate = ${renderTemplate.toString()};

const resolveParamValues = ${resolveParamValues.toString()};

const definitions = ${JSON.stringify(data, null, 2)};

function createSkill(definition) {
  const render = (params) =>
    renderTemplate(definition.template, resolveParamValues(definition.params, params || {}, definition.name));
  return Object.freeze({
    name: definition.name,
    category: definition.category,
    title: definition.title,
    description: definition.description,
    params: definition.params,
    render,
    files: (params) => Object.assign({ "SKILL.md": { encoding: "utf8", content: render(params) } }, definition.files)
  });
}

const skills = Object.freeze(definitions.map(createSkill));

function getSkill(name) {
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) throw new Error("Unknown skill '" + name + "'. Available: " + skills.map((s) => s.name).join(", "));
  return skill;
}
`;
}

function declarationSource(skills: SkillData[], packageName: string): string {
  const header = `// Generated by skanvil build. Do not edit.

/** Definition of a skill parameter (from its params.json). */
export interface SkillParamDefinition {
  type: "enum" | "string" | "boolean";
  /** Allowed values of an enum parameter. */
  values?: string[];
  default: string | boolean;
  description?: string;
}

/** A file of a skill. Text files are UTF-8, binary files base64. */
export interface SkillFileContent {
  encoding: "utf8" | "base64";
  content: string;
}

/** A skill of ${packageName}. */
export interface Skill<P = Record<string, unknown>> {
  /** Folder and frontmatter name, e.g. "front-api-review". */
  readonly name: string;
  /** Category id. */
  readonly category: string;
  /** Display title. */
  readonly title: string;
  /** Frontmatter description (rendered with default parameters). */
  readonly description: string;
  /** Declared parameters. */
  readonly params: Readonly<Record<string, SkillParamDefinition>>;
  /** Returns SKILL.md rendered with the given parameters (defaults for the rest). Throws on invalid values. */
  render(params?: P): string;
  /** Every file of the skill folder, keyed by relative path, with SKILL.md rendered. Write them to e.g. .claude/skills/<name>/. */
  files(params?: P): Record<string, SkillFileContent>;
}

/** Every skill of the package, in folder order. */
export declare const skills: readonly Skill[];

/** Finds a skill by folder name. Throws when it does not exist. */
export declare function getSkill(name: SkillName): Skill;

/** Folder names of the skills in this package. */
export type SkillName = ${skills.map((skill) => JSON.stringify(skill.name)).join(" | ") || "never"};
`;
  const perSkill = skills.map((skill) => {
    const typeName = `${capitalize(skill.exportName)}Params`;
    return (
      `\n${docComment([`Parameters of the \`${skill.name}\` skill.`])}export type ${typeName} = ${paramsType(skill.params)};\n\n` +
      docComment([
        `${skill.title}: ${skill.description}`,
        "",
        `@returns The \`${skill.name}\` SKILL.md${Object.keys(skill.params).length ? ", rendered with the given parameters" : ""}.`
      ]) +
      `export declare function ${skill.exportName}(params?: ${typeName}): string;\n`
    );
  });
  return header + perSkill.join("");
}

/**
 * Generates `index.mjs`, `index.cjs`, `index.d.mts` and `index.d.cts` for the library's
 * publishable skills (categories with `validated: true`).
 *
 * @param library - Library to build.
 * @param options - Output folder and error handling.
 * @returns What was generated.
 * @throws Error when validation reports errors (unless `force`), or a skill's parameters are invalid.
 *
 * @example
 * ```ts
 * const { skills } = await buildLibrary(await Library.open("."));
 * // then, in a consumer: import { apiReview } from "@acme/my-skills";
 * ```
 */
export async function buildLibrary(library: Library, options: BuildOptions = {}): Promise<BuildResult> {
  if (!options.force) {
    const validation = await validateLibrary(library);
    if (validation.errors > 0) {
      throw new Error(
        `Validation found ${validation.errors} error(s); run 'skanvil validate' (or build with --force).`
      );
    }
  }

  const folders = [];
  for (const folder of await library.listSkillFolders()) {
    if (library.categories.fromFolder(folder).validated && (await library.hasSkill(folder))) folders.push(folder);
  }
  const names = exportNames(library, folders);

  const skills: SkillData[] = [];
  for (const folder of folders) {
    const dir = library.skillPath(folder);
    const params = (await library.readSkillParams(folder)) ?? {};
    const template = (await fs.readFile(path.join(dir, "SKILL.md"), "utf8")).replace(/\r\n/g, "\n");
    const rendered = await library.readSkillRendered(folder);
    const files: SkillData["files"] = {};
    for (const file of await listFiles(dir)) {
      if (file === "SKILL.md" || file === PARAMS_FILE) continue;
      const buffer = await fs.readFile(path.join(dir, file));
      files[file] = isText(buffer)
        ? { encoding: "utf8", content: buffer.toString("utf8") }
        : { encoding: "base64", content: buffer.toString("base64") };
    }
    skills.push({
      name: folder,
      exportName: names.get(folder)!,
      category: library.categories.fromFolder(folder).id,
      title: rendered.title || folder,
      description: rendered.getString("description"),
      params,
      template,
      files
    });
  }

  let packageName = library.config.name ?? path.basename(library.root);
  try {
    packageName = JSON.parse(await fs.readFile(path.join(library.root, "package.json"), "utf8")).name ?? packageName;
  } catch {
    // No package.json: keep the library name.
  }

  const outDir = path.resolve(library.root, options.outDir ?? "dist");
  await fs.mkdir(outDir, { recursive: true });
  const runtime = runtimeSource(skills);
  const exportsList = skills.map((skill) => `  ${skill.exportName}`);
  const functions = skills
    .map((skill, index) => `const ${skill.exportName} = (params) => skills[${index}].render(params);`)
    .join("\n");
  const banner = "// Generated by skanvil build. Do not edit.\n";
  const esm = `${banner}${runtime}\n${functions}\n\nexport {\n  skills,\n  getSkill${exportsList.length ? ",\n" + exportsList.join(",\n") : ""}\n};\n`;
  const cjs = `${banner}"use strict";\n${runtime}\n${functions}\n\nmodule.exports = {\n  skills,\n  getSkill${exportsList.length ? ",\n" + exportsList.join(",\n") : ""}\n};\n`;
  const dts = declarationSource(skills, packageName);

  const written: Record<string, string> = {
    "index.mjs": esm,
    "index.cjs": cjs,
    "index.d.mts": dts,
    "index.d.cts": dts
  };
  for (const [file, content] of Object.entries(written)) {
    await fs.writeFile(path.join(outDir, file), content, "utf8");
  }

  return {
    outDir,
    files: Object.keys(written).map((file) =>
      path.relative(library.root, path.join(outDir, file)).split(path.sep).join("/")
    ),
    skills: skills.map((skill) => ({
      name: skill.name,
      exportName: skill.exportName,
      category: skill.category,
      params: Object.keys(skill.params)
    }))
  };
}
