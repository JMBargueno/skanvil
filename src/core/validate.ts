/**
 * Validation engine: Agent Skills spec checks, library conventions and README consistency.
 *
 * @see https://agentskills.io/specification
 * @module
 */
import path from "node:path";
import { isMap, isScalar } from "yaml";

import { listFiles } from "../util/fs.js";
import type { Severity } from "./config.js";
import type { Library } from "./library.js";
import { escapeRegex, KEBAB_CASE_PATTERN } from "./naming.js";
import type { SkillFile } from "./skill.js";
import { TEMPLATE_BOILERPLATE } from "./templates.js";

/** Severity of a reported diagnostic (rules set to `off` report nothing). */
export type DiagnosticSeverity = Exclude<Severity, "off">;

/** A single validation finding. */
export interface Diagnostic {
  /** Rule id, a key of {@link RULES}. */
  rule: string;
  /** Effective severity after configuration overrides. */
  severity: DiagnosticSeverity;
  /** Skill folder concerned, if the problem belongs to one skill. */
  skill?: string;
  /** Human-readable explanation, without the skill prefix (see {@link formatDiagnostic}). */
  message: string;
  /** `true` when `skanvil doctor --fix` can repair the problem. */
  fixable?: boolean;
}

/** Definition of a validation rule. */
export interface RuleDefinition {
  /** Severity used when the library does not override it. */
  severity: DiagnosticSeverity;
  /** What the rule checks. */
  description: string;
  /** Whether `skanvil doctor --fix` can repair violations. */
  fixable?: boolean;
}

/**
 * Every validation rule, keyed by id, with its default severity.
 * Override severities per library in `.skanvilrc.json` > `validation.rules`.
 */
export const RULES: Record<string, RuleDefinition> = {
  "skill-file": { severity: "error", description: "Each skill folder contains SKILL.md." },
  frontmatter: {
    severity: "error",
    description: "SKILL.md starts with valid YAML frontmatter between --- delimiters."
  },
  "folder-name": { severity: "error", description: "Folder name is strict kebab-case." },
  "name-required": { severity: "error", description: "Frontmatter `name` is present.", fixable: true },
  "name-format": {
    severity: "error",
    description: "Spec: name is 1-64 chars of a-z, 0-9 and single hyphens, not starting or ending with a hyphen."
  },
  "name-matches-folder": {
    severity: "error",
    description: "Frontmatter `name` equals the folder name.",
    fixable: true
  },
  "duplicate-name": { severity: "error", description: "Frontmatter names are unique across the library." },
  "description-required": { severity: "error", description: "Frontmatter `description` is present." },
  "description-length": { severity: "error", description: "Spec: description is at most 1024 characters." },
  "compatibility-length": { severity: "error", description: "Spec: compatibility is 1-500 characters." },
  "metadata-format": { severity: "warn", description: "Spec: metadata is a map of string keys to string values." },
  "allowed-tools-format": { severity: "warn", description: "Spec: allowed-tools is a space-separated string." },
  "tools-field": {
    severity: "warn",
    description: "`tools` is not a spec field; use `allowed-tools` (space-separated string).",
    fixable: true
  },
  "frontmatter-tabs": { severity: "error", description: "YAML frontmatter has no tab characters.", fixable: true },
  "required-sections": { severity: "error", description: "Body has every configured `## Section`." },
  placeholders: { severity: "error", description: "No placeholder text such as TODO or lorem ipsum." },
  "max-lines": {
    severity: "warn",
    description: "Spec recommendation: SKILL.md stays under the configured line count."
  },
  "broken-references": {
    severity: "error",
    description:
      "Relative links and `references/`, `scripts/`, `assets/` paths in SKILL.md exist inside the skill folder."
  },
  "template-unchanged": {
    severity: "warn",
    description: "The body no longer contains the generic text of the built-in skill template."
  },
  "readme-missing": { severity: "error", description: "Every indexed skill is listed in the README.", fixable: true },
  "readme-orphan": { severity: "error", description: "README does not reference missing skills.", fixable: true },
  "readme-section": {
    severity: "error",
    description: "Skills are listed under the README section of their category.",
    fixable: true
  }
};

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_COMPATIBILITY = 500;

/**
 * Builds the regular expression used to detect a configured placeholder.
 *
 * - ALL-CAPS markers such as `TODO` match case-sensitively as whole words delimited by
 *   whitespace, brackets or punctuation (so `TODOS` or `todo` do not match).
 * - Other placeholders match case-insensitively, with word boundaries at word-character edges.
 *
 * @param placeholder - Placeholder text from the configuration.
 * @returns The pattern.
 *
 * @example
 * ```ts
 * placeholderPattern("TODO").test("Fix later: TODO"); // true
 * placeholderPattern("tbd").test("Status: TBD.");     // true
 * ```
 */
export function placeholderPattern(placeholder: string): RegExp {
  const escaped = escapeRegex(placeholder);
  if (/^[A-Z0-9_]+$/.test(placeholder)) {
    return new RegExp(`(^|[\\s[(])${escaped}([\\s\\],.:;!?)]|$)`, "m");
  }
  const start = /^\w/.test(placeholder) ? "\\b" : "";
  const end = /\w$/.test(placeholder) ? "\\b" : "";
  return new RegExp(`${start}${escaped}${end}`, "i");
}

/** Accumulates diagnostics, applying severity overrides and dropping rules set to `off`. */
class Collector {
  readonly diagnostics: Diagnostic[] = [];

  constructor(private readonly overrides: Record<string, Severity>) {}

  add(rule: string, message: string, skill?: string): void {
    const severity = this.overrides[rule] ?? RULES[rule]?.severity ?? "error";
    if (severity === "off") return;
    const diagnostic: Diagnostic = { rule, severity, message };
    if (skill !== undefined) diagnostic.skill = skill;
    if (RULES[rule]?.fixable) diagnostic.fixable = true;
    this.diagnostics.push(diagnostic);
  }
}

/** Content rules taken from the library configuration. */
export interface ValidateOptions {
  /** Required `## Section` headings. */
  requiredSections: string[];
  /** Forbidden placeholder strings. */
  placeholders: string[];
  /** Line limit of the `max-lines` rule. */
  maxLines: number;
}

/**
 * Validates one `SKILL.md`. Stops early when the frontmatter is missing or invalid.
 *
 * @param allowUnderscore - Accept a leading `_` in folder and frontmatter names (internal category).
 * @param files - Files of the skill folder (posix paths relative to it), for reference checks.
 * @returns The frontmatter name (or `""`) for duplicate detection.
 */
function validateSkillFile(
  collector: Collector,
  folderName: string,
  skill: SkillFile,
  options: ValidateOptions,
  allowUnderscore: boolean,
  files: Set<string>
): string {
  const add = (rule: string, message: string) => collector.add(rule, message, folderName);

  if (!skill.hasFrontmatter) {
    add("frontmatter", "SKILL.md must start with YAML frontmatter between --- delimiters");
    return "";
  }

  // Checked before parsing: tab indentation usually makes the YAML invalid.
  const tabLines = (skill.frontmatterRaw ?? "")
    .split("\n")
    .map((line, index) => (line.includes("\t") ? index + 2 : 0))
    .filter(Boolean);
  if (tabLines.length > 0) {
    add("frontmatter-tabs", `YAML frontmatter must not contain tabs (lines ${tabLines.join(", ")})`);
  }
  if (!skill.isValidYaml) {
    add("frontmatter", `invalid YAML frontmatter (${skill.yamlErrors[0] ?? "expected a mapping"})`);
    return "";
  }

  const bareFolder = allowUnderscore ? folderName.replace(/^_/, "") : folderName;
  if (!KEBAB_CASE_PATTERN.test(bareFolder)) {
    add("folder-name", "folder name must be strict kebab-case");
  }

  const name = skill.getString("name");
  if (!name) {
    add("name-required", "frontmatter name is required");
  } else {
    const bareName = allowUnderscore ? name.replace(/^_/, "") : name;
    if (!KEBAB_CASE_PATTERN.test(bareName) || name.length > MAX_NAME) {
      add(
        "name-format",
        `frontmatter name must be strict kebab-case (a-z, 0-9, single hyphens) and at most ${MAX_NAME} characters`
      );
    }
    if (name !== folderName) {
      add("name-matches-folder", `name (${name}) must match the folder name (${folderName})`);
    }
  }

  const description = skill.getString("description");
  if (!description) {
    add("description-required", "frontmatter description is required");
  } else if (description.length > MAX_DESCRIPTION) {
    add("description-length", `description has ${description.length} characters (max ${MAX_DESCRIPTION})`);
  }

  if (skill.has("compatibility")) {
    const compatibility = skill.getString("compatibility");
    if (!compatibility || compatibility.length > MAX_COMPATIBILITY) {
      add(
        "compatibility-length",
        `compatibility must be 1-${MAX_COMPATIBILITY} characters (has ${compatibility.length})`
      );
    }
  }

  if (skill.has("metadata")) {
    const node = skill.doc!.get("metadata", true);
    const ok =
      isMap(node) &&
      node.items.every((pair) => isScalar(pair.value) && typeof (pair.value as { value: unknown }).value === "string");
    if (!ok) {
      add("metadata-format", 'metadata must map string keys to string values (quote numbers, e.g. version: "1.0")');
    }
  }

  if (skill.has("allowed-tools")) {
    const node = skill.doc!.get("allowed-tools", true);
    if (!isScalar(node) || typeof node.value !== "string") {
      add("allowed-tools-format", "allowed-tools must be a space-separated string");
    }
  }
  if (skill.has("tools")) {
    add("tools-field", "`tools` is not part of the Agent Skills spec; use `allowed-tools` (space-separated string)");
  }

  const content = skill.toLfString();

  const sections = new Set<string>();
  for (const match of skill.body.matchAll(/^##\s+(.+)$/gm)) {
    sections.add(match[1].trim().toLowerCase());
  }
  for (const section of options.requiredSections) {
    if (!sections.has(section.toLowerCase())) {
      add("required-sections", `missing required section "## ${section}"`);
    }
  }

  for (const placeholder of options.placeholders) {
    if (placeholderPattern(placeholder).test(content)) {
      add("placeholders", `contains a forbidden placeholder ("${placeholder}")`);
    }
  }

  const lineCount = content.split("\n").length;
  if (lineCount > options.maxLines) {
    add(
      "max-lines",
      `SKILL.md has ${lineCount} lines (recommended max ${options.maxLines}); move detail to references/`
    );
  }

  for (const problem of findBrokenReferences(skill.body, files)) {
    add("broken-references", problem);
  }

  const boilerplate = TEMPLATE_BOILERPLATE.find((sentence) => skill.body.includes(sentence));
  if (boilerplate) {
    add(
      "template-unchanged",
      `still contains generic template text ("${boilerplate.slice(0, 48)}…"); replace it with skill-specific instructions`
    );
  }

  return name;
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** Characters that mark a path as a pattern or placeholder rather than a real file. */
const NOT_A_PATH = /[<>*{}$]/;

/**
 * Finds references from a SKILL.md body to files of its own folder that do not exist.
 *
 * Checked:
 * - relative Markdown link targets, `[text](references/x.md)`;
 * - backticked paths under `references/`, `scripts/` or `assets/`, such as `` `scripts/run.sh` ``.
 *
 * Ignored: fenced code blocks, URLs, `mailto:`, anchors, absolute paths, and patterns containing
 * `<`, `*`, `{` or `$`. Links that leave the skill folder (`../`) are reported, because the spec
 * keeps references inside the skill, one level deep.
 *
 * @param body - Markdown body (LF).
 * @param files - Files of the skill folder, as posix paths relative to it.
 * @returns One message per problem, without duplicates.
 */
export function findBrokenReferences(body: string, files: Set<string>): string[] {
  const text = body.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join("/"));
  }

  const targets = new Set<string>();
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) targets.add(match[1]);
  for (const match of text.matchAll(/`((?:references|scripts|assets)\/[^`\s]+)`/g)) targets.add(match[1]);

  const problems: string[] = [];
  for (const raw of targets) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.startsWith("/") || NOT_A_PATH.test(raw))
      continue;
    const clean = safeDecode(raw.split(/[?#]/)[0]);
    if (!clean) continue;
    const resolved = path.posix.normalize(clean).replace(/\/+$/, "");
    if (resolved === "." || resolved === "") continue;
    if (resolved === ".." || resolved.startsWith("../")) {
      problems.push(`reference '${raw}' points outside the skill folder`);
    } else if (!files.has(resolved) && !directories.has(resolved)) {
      problems.push(`reference '${raw}' does not exist in the skill folder`);
    }
  }
  return problems;
}

/** Result of {@link validateLibrary}. */
export interface ValidationResult {
  /** Every finding, skill checks first and README checks last. */
  diagnostics: Diagnostic[];
  /** Number of skills checked against the spec (categories with `validated !== false`). */
  count: number;
  /** Number of diagnostics with severity `error`. */
  errors: number;
  /** Number of diagnostics with severity `warn`. */
  warnings: number;
}

/** Options of {@link validateLibrary}. */
export interface ValidateLibraryOptions {
  /** Only report diagnostics of this skill folder. The whole library is still read. */
  skill?: string;
}

/**
 * Validates every skill of a library and the consistency of its README index.
 *
 * Checks performed:
 * - **Per skill** (categories with `validated: true`): frontmatter, spec limits, naming,
 *   required sections, placeholders and length.
 * - **Library-wide**: duplicated frontmatter names.
 * - **README** (categories with `indexed: true`): missing entries, entries for missing skills,
 *   and skills listed under another category's section.
 *
 * @param library - Library to check.
 * @param options - Optional filter.
 * @returns Diagnostics and counters. The function never throws for content problems.
 * @throws Error when the README cannot be read.
 *
 * @example
 * ```ts
 * const result = await validateLibrary(await Library.open("."));
 * if (result.errors > 0) {
 *   for (const d of result.diagnostics) console.error(formatDiagnostic(d), `[${d.rule}]`);
 *   process.exitCode = 1;
 * }
 * ```
 */
export async function validateLibrary(
  library: Library,
  options: ValidateLibraryOptions = {}
): Promise<ValidationResult> {
  const collector = new Collector(library.config.validation.rules);
  const folders = await library.listSkillFolders();
  const ruleOptions: ValidateOptions = library.config.validation;

  const validated = folders.filter((name) => library.categories.fromFolder(name).validated);
  const ownerByName = new Map<string, string>();

  for (const folder of validated) {
    let skill: SkillFile;
    try {
      skill = await library.readSkill(folder);
    } catch {
      collector.add("skill-file", "missing SKILL.md", folder);
      continue;
    }
    const files = new Set(await listFiles(library.skillPath(folder)));
    const allowUnderscore = library.categories.fromFolder(folder).prefix === "_";
    const name = validateSkillFile(collector, folder, skill, ruleOptions, allowUnderscore, files);
    if (name) {
      if (ownerByName.has(name)) {
        collector.add(
          "duplicate-name",
          `duplicated frontmatter name (${name}), already used by ${ownerByName.get(name)}`,
          folder
        );
      } else {
        ownerByName.set(name, folder);
      }
    }
  }

  const readme = await library.readReadme();
  const documented = library.documentedByCategory(readme.text);
  const indexedFolders = folders.filter((name) => library.categories.fromFolder(name).indexed);
  const allDocumented = new Set<string>();
  for (const names of documented.values()) for (const name of names) allDocumented.add(name);

  for (const folder of indexedFolders) {
    if (!allDocumented.has(folder)) {
      collector.add("readme-missing", `not documented in ${library.config.readme}`, folder);
    }
  }
  for (const name of allDocumented) {
    if (!folders.includes(name)) {
      collector.add("readme-orphan", `${library.config.readme} references a missing skill: ${name}`);
    }
  }
  for (const [categoryId, names] of documented) {
    const category = library.categories.byId(categoryId)!;
    for (const name of names) {
      if (folders.includes(name) && library.categories.fromFolder(name).id !== categoryId) {
        const expected = category.prefix
          ? `must use the ${category.prefix} prefix`
          : "must not use another category's prefix";
        collector.add("readme-section", `skills in the ${category.title} category ${expected}`, name);
      }
    }
  }

  let diagnostics = collector.diagnostics;
  if (options.skill) {
    diagnostics = diagnostics.filter((diagnostic) => diagnostic.skill === options.skill);
  }
  return {
    diagnostics,
    count: options.skill ? 1 : validated.length,
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === "warn").length
  };
}

/**
 * Formats a diagnostic for display.
 *
 * @param diagnostic - Diagnostic to format.
 * @returns `"<skill>: <message>"`, or just the message for library-level diagnostics.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  return diagnostic.skill ? `${diagnostic.skill}: ${diagnostic.message}` : diagnostic.message;
}
