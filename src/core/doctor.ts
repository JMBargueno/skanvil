/**
 * `skanvil doctor`: diagnosis plus automatic repair of fixable problems.
 *
 * @module
 */
import type { Library } from "./library.js";
import { escapeRegex, KEBAB_CASE_PATTERN } from "./naming.js";
import { reconcileIndex } from "./reindex.js";
import { convertToolsField } from "./skills.js";
import { validateLibrary, type ValidationResult } from "./validate.js";

/** Options of {@link doctor}. */
export interface DoctorOptions {
  /** Apply automatic repairs. @defaultValue `false` */
  fix?: boolean;
  /** Insert minimal scaffold stubs for missing configured `requiredSections` (requires `fix: true`). @defaultValue `false` */
  scaffoldSections?: boolean;
}

const ERROR_RECOVERY_STUB = [
  "## Error Recovery",
  "",
  "| Failure | Cause | Recovery Action |",
  "| --- | --- | --- |",
  "| Expected command or check fails | Missing prerequisites or unexpected repository state | Inspect the error output, verify prerequisites, and report the blocking issue before proceeding. |"
].join("\n");

function buildSectionStub(section: string): string {
  const lower = section.trim().toLowerCase();
  if (lower === "error recovery") return ERROR_RECOVERY_STUB;
  if (lower === "instructions") {
    return [
      `## ${section}`,
      "",
      "1. Inspect the relevant target files and prerequisites before making edits.",
      "2. Apply focused changes and run the narrowest verification check."
    ].join("\n");
  }
  return `## ${section}\n\n- Document concrete requirements for ${section.toLowerCase()} here.`;
}

function insertSectionBlock(body: string, section: string, block: string): string {
  if (section.trim().toLowerCase() === "error recovery") {
    const match = body.match(/^##\s+Output Format\s*$/im);
    if (match && match.index !== undefined) {
      const before = body.slice(0, match.index).replace(/\n+$/, "");
      const after = body.slice(match.index);
      return before ? `${before}\n\n${block}\n\n${after}` : `${block}\n\n${after}`;
    }
  }
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

/** Result of {@link doctor}. */
export interface DoctorResult {
  /** Validation before any fix. */
  before: ValidationResult;
  /** One human-readable line per applied fix (empty without `fix`). */
  fixes: string[];
  /** Validation after fixing; only present when `fix` was requested. */
  after?: ValidationResult;
}

/**
 * Repairs one skill's fixable frontmatter problems:
 * - tabs are replaced with two spaces;
 * - `name` is set to the folder name when the folder name is valid;
 * - `tools` is converted to a space-separated `allowed-tools`.
 *
 * @param rules - Ids of the fixable rules reported for this skill.
 * @returns The fixes applied.
 */
async function fixSkill(library: Library, folder: string, rules: Set<string>): Promise<string[]> {
  const fixes: string[] = [];
  const skill = await library.readSkill(folder);

  if (rules.has("frontmatter-tabs") && skill.frontmatterRaw?.includes("\t")) {
    skill.replaceFrontmatterRaw(skill.frontmatterRaw.replace(/\t/g, "  "));
    fixes.push(`${folder}: replaced tabs in frontmatter`);
  }
  if (!skill.isValidYaml) {
    if (fixes.length > 0) await library.writeSkill(folder, skill);
    return fixes;
  }

  if (
    (rules.has("name-required") || rules.has("name-matches-folder")) &&
    KEBAB_CASE_PATTERN.test(folder.replace(/^_/, ""))
  ) {
    skill.set(["name"], folder);
    fixes.push(`${folder}: set frontmatter name to the folder name`);
  }

  if (rules.has("tools-field") && convertToolsField(skill)) {
    fixes.push(`${folder}: converted tools to allowed-tools`);
  }

  if (fixes.length > 0) await library.writeSkill(folder, skill);
  return fixes;
}

/**
 * Diagnoses a library and, with `fix`, repairs every problem flagged as `fixable`.
 *
 * Repairs:
 * - **Frontmatter** of each affected skill (see the `RULES` entries marked `fixable`).
 * - **README index**, through {@link reconcileIndex}.
 *
 * @remarks Converting `tools` to `allowed-tools` keeps the tool identifiers as they are. These may
 * be agent-specific, such as the VS Code names `read_file` and `grep_search`, so review them afterwards.
 *
 * @param library - Library to check.
 * @param options - Set `fix: true` to write repairs.
 * @returns Validation before and after, plus the fixes applied.
 *
 * @example
 * ```ts
 * const { fixes, after } = await doctor(lib, { fix: true });
 * fixes.forEach((line) => console.log("fixed:", line));
 * if (after!.errors > 0) process.exitCode = 1;
 * ```
 */
export async function doctor(library: Library, options: DoctorOptions = {}): Promise<DoctorResult> {
  if (options.scaffoldSections && !options.fix) {
    throw new Error("--scaffold-sections requires --fix.");
  }
  const before = await validateLibrary(library);
  if (!options.fix) return { before, fixes: [] };

  const fixes: string[] = [];
  const bySkill = new Map<string, Set<string>>();
  const missingSectionsSkills = new Set<string>();
  for (const diagnostic of before.diagnostics) {
    if (options.scaffoldSections && diagnostic.rule === "required-sections" && diagnostic.skill) {
      missingSectionsSkills.add(diagnostic.skill);
    }
    if (!diagnostic.fixable || !diagnostic.skill || diagnostic.rule.startsWith("readme-")) continue;
    if (!bySkill.has(diagnostic.skill)) bySkill.set(diagnostic.skill, new Set());
    bySkill.get(diagnostic.skill)!.add(diagnostic.rule);
  }
  for (const [folder, rules] of bySkill) {
    fixes.push(...(await fixSkill(library, folder, rules)));
  }

  if (options.scaffoldSections) {
    for (const folder of missingSectionsSkills) {
      const skill = await library.readSkill(folder);
      if (!skill.isValidYaml) continue;
      let changed = false;
      for (const section of library.config.validation.requiredSections) {
        const headingPattern = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`, "im");
        if (headingPattern.test(skill.body)) continue;
        skill.body = insertSectionBlock(skill.body, section, buildSectionStub(section));
        fixes.push(`${folder}: scaffolded missing section '## ${section}'`);
        changed = true;
      }
      if (changed) await library.writeSkill(folder, skill);
    }
  }

  if (before.diagnostics.some((diagnostic) => diagnostic.rule.startsWith("readme-"))) {
    const readme = await library.readReadme();
    const { text, changes } = await reconcileIndex(library, readme.text);
    if (changes.length > 0) {
      await library.writeReadme({ text, eol: readme.eol });
      fixes.push(...changes);
    }
  }

  return { before, fixes, after: await validateLibrary(library) };
}
