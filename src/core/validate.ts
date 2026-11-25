/**
 * Validation engine: Agent Skills spec checks, library conventions and README consistency.
 *
 * @see https://agentskills.io/specification
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isMap, isScalar } from "yaml";

import { listFiles } from "../util/fs.js";
import { SKILL_STATUSES, type Severity } from "./config.js";
import { EVALS_FILE, type SkillEvals } from "./evals.js";
import type { Library } from "./library.js";
import { escapeRegex, KEBAB_CASE_PATTERN } from "./naming.js";
import {
  findUndeclaredParams,
  PARAMS_FILE,
  renderTemplate,
  resolveParamValues,
  type ParamDefinitions
} from "./params.js";
import { SkillFile } from "./skill.js";
import { TEMPLATE_BOILERPLATE } from "./templates.js";
import { estimateTokens, extractSection, jaccardSimilarity, stripFencedCode, tokenizeForSimilarity } from "./text.js";

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
  /** Relative posix path from the library root (e.g. `skills/front-api/SKILL.md`), when known. */
  file?: string;
  /** 1-based line number inside {@link Diagnostic.file}, when known. */
  line?: number;
}

/** Definition of a validation rule. */
export interface RuleDefinition {
  /** Severity used when the library does not override it (`off` means opt-in). */
  severity: Severity;
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
  "params-file": {
    severity: "error",
    description:
      "params.json, when present, is valid: camelCase names, a type, and a default (in its values for enums)."
  },
  "params-template": {
    severity: "error",
    description: "{{placeholders}} and {{#if}} blocks use declared parameters and are balanced."
  },
  "readme-missing": { severity: "error", description: "Every indexed skill is listed in the README.", fixable: true },
  "readme-orphan": { severity: "error", description: "README does not reference missing skills.", fixable: true },
  "readme-section": {
    severity: "error",
    description: "Skills are listed under the README section of their category.",
    fixable: true
  },
  "description-budget": {
    severity: "warn",
    description: "Stage-1 always-loaded metadata (name + description) stays within the configured token budget."
  },
  "description-triggers": {
    severity: "warn",
    description: "Description states what the skill does and when to activate it (>= 40 chars with trigger cues)."
  },
  "numbered-steps": {
    severity: "warn",
    description: "Instructions section uses numbered steps (1., 2., ...) or numbered subsections (### 1., ### 2.)."
  },
  "vague-fallback": {
    severity: "warn",
    description: "Body avoids vague error-recovery phrases such as 'try again'."
  },
  "error-recovery-table": {
    severity: "warn",
    description: "Error Recovery section uses a Markdown table mapping failures to concrete recovery actions."
  },
  "unused-resources": {
    severity: "warn",
    description: "Files in references/, scripts/ and assets/ are referenced from SKILL.md."
  },
  "description-overlap": {
    severity: "warn",
    description: "Validated skills have distinct descriptions to avoid routing collisions."
  },
  "always-loaded-budget": {
    severity: "warn",
    description:
      "Total Stage-1 always-loaded tokens across validated skills stay within validation.maxAlwaysLoadedTokens."
  },
  "evals-file": {
    severity: "error",
    description: "evals.json, when present, is valid and its case params match params.json."
  },
  "evals-required": {
    severity: "off",
    description: "Every validated skill includes an evals.json with positive and negative trigger prompts."
  },
  "duplicate-trigger": {
    severity: "warn",
    description: "Positive shouldTrigger prompts in evals.json are not duplicated across multiple skills."
  },
  "no-secrets": {
    severity: "error",
    description: "SKILL.md and text resources contain no hardcoded secrets, API tokens, or private keys."
  },
  "no-local-paths": {
    severity: "warn",
    description: "SKILL.md and text resources avoid machine-specific local home paths."
  },
  "owner-required": {
    severity: "off",
    description: "Frontmatter metadata.owner is set."
  },
  "status-valid": {
    severity: "warn",
    description: "Frontmatter metadata.status, when present, is one of: draft, experimental, active, deprecated."
  },
  "replaced-by-exists": {
    severity: "error",
    description: "Frontmatter metadata.replaced-by points to an existing, non-deprecated skill in the library."
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

  add(rule: string, message: string, skill?: string, location?: { file?: string; line?: number }): void {
    const severity = this.overrides[rule] ?? RULES[rule]?.severity ?? "error";
    if (severity === "off") return;
    const diagnostic: Diagnostic = { rule, severity, message };
    if (skill !== undefined) diagnostic.skill = skill;
    if (RULES[rule]?.fixable) diagnostic.fixable = true;
    if (location?.file !== undefined) diagnostic.file = location.file;
    if (location?.line !== undefined && location.line > 0) diagnostic.line = location.line;
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
  /** Stage-1 token budget (`name` + `description`). */
  maxDescriptionTokens: number;
  /** Optional library-wide Stage-1 token budget. */
  maxAlwaysLoadedTokens?: number;
  /** Jaccard similarity threshold (0.1-1.0) for `description-overlap`. */
  overlapThreshold: number;
  /** Vague error-recovery phrases flagged by `vague-fallback`. */
  vagueFallbacks: string[];
}

const TRIGGER_CUE_PATTERN =
  /\b(use\s+(?:this\s+)?(?:skill\s+)?(?:when|whenever|for|to|if)|use\s+it\s+(?:when|whenever|for|to|if)|when\s+\w+|whenever\b|triggers?\b|activate\b|for\s+(?:creating|building|debugging|reviewing|testing|migrating|deploying|fixing|auditing|managing|running|validating|generating|optimizing|writing|logging)\b)/i;

const TABLE_SEPARATOR_PATTERN = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  return trimmed.replace(/\|/g, "").trim().length > 0;
}

function hasMarkdownTable(section: string): boolean {
  const lines = stripFencedCode(section).split("\n");
  for (let i = 0; i + 2 < lines.length; i += 1) {
    if (
      isTableRow(lines[i]) &&
      TABLE_SEPARATOR_PATTERN.test(lines[i + 1]) &&
      isTableRow(lines[i + 2]) &&
      !TABLE_SEPARATOR_PATTERN.test(lines[i + 2])
    ) {
      return true;
    }
  }
  return false;
}

const MAX_TEXT_SCAN_BYTES = 1024 * 1024;
const ALLOWED_LOCAL_PATH_USERS = new Set([
  "user",
  "username",
  "your-user",
  "your_user",
  "your-name",
  "yourname",
  "example",
  "runner",
  "ci",
  "vscode",
  "ubuntu"
]);

const LOCAL_PATH_PATTERN =
  /(?:^|[\s"'`(=:])((?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|[A-Za-z]:\/Users\/)([A-Za-z0-9._-]+)(?:[\\/\s"'`):]|$))/;

const SECRET_RULES: { label: string; pattern: RegExp; extractToken?: (match: RegExpMatchArray) => string }[] = [
  { label: "private key block", pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
  { label: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { label: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { label: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{15,}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "provider API key", pattern: /\b(?:sk-proj-|sk-ant-api\d+-|sk_live_)[A-Za-z0-9_-]{20,}\b/ },
  {
    label: "API secret key",
    pattern: /\bsk-([A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]{23,})\b/
  },
  {
    label: "Bearer auth token",
    pattern: /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/-]{24,}=*)/i,
    extractToken: (match) => match[1]
  }
];

function looksLikePlaceholderSecret(value: string): boolean {
  if (/[<>{}$]/.test(value)) return true;
  if (/(?:your[-_]?|example|placeholder|sample|dummy|fake|redact|replace|token[-_]?here)/i.test(value)) {
    return true;
  }
  const core = value.replace(/^(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza)/, "");
  return /^(.)\1{7,}$/.test(core);
}

function findSecretLabel(line: string): string | null {
  for (const rule of SECRET_RULES) {
    const match = line.match(rule.pattern);
    if (!match) continue;
    const token = rule.extractToken ? rule.extractToken(match) : match[0];
    if (looksLikePlaceholderSecret(token)) continue;
    return rule.label;
  }
  return null;
}

function findLine(text: string, pattern: RegExp): number | undefined {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return undefined;
}

async function scanSkillTextFiles(
  library: Library,
  folder: string,
  files: Set<string>,
  collector: Collector
): Promise<void> {
  const skillDir = library.skillPath(folder);
  const candidates = [...files].filter((relFile) => relFile === "SKILL.md" || RESOURCE_PREFIX_PATTERN.test(relFile));

  for (const relFile of candidates) {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(path.join(skillDir, relFile));
    } catch {
      continue;
    }
    if (buffer.length > MAX_TEXT_SCAN_BYTES || buffer.subarray(0, 8192).includes(0)) continue;

    const lines = buffer.toString("utf8").split(/\r?\n/);
    const relFromRoot = `${library.skillsDirRef}/${folder}/${relFile}`;
    for (let i = 0; i < lines.length; i += 1) {
      const lineText = lines[i];
      const lineNumber = i + 1;

      const secretLabel = findSecretLabel(lineText);
      if (secretLabel) {
        collector.add("no-secrets", `possible ${secretLabel} detected in ${relFile}:${lineNumber}`, folder, {
          file: relFromRoot,
          line: lineNumber
        });
      }

      const pathMatch = lineText.match(LOCAL_PATH_PATTERN);
      if (pathMatch && !ALLOWED_LOCAL_PATH_USERS.has(pathMatch[2].toLowerCase())) {
        collector.add(
          "no-local-paths",
          `machine-specific local path detected in ${relFile}:${lineNumber} (use relative paths or environment variables)`,
          folder,
          { file: relFromRoot, line: lineNumber }
        );
      }
    }
  }
}

/**
 * Validates one `SKILL.md`. Stops early when the frontmatter is missing or invalid.
 *
 * @param allowUnderscore - Accept a leading `_` in folder and frontmatter names (internal category).
 * @param files - Files of the skill folder (posix paths relative to it), for reference checks.
 * @param skillFileRel - Posix path of `SKILL.md` relative to library root, for diagnostic locations.
 * @returns The frontmatter name (or `""`) for duplicate detection.
 */
function validateSkillFile(
  collector: Collector,
  folderName: string,
  skill: SkillFile,
  options: ValidateOptions,
  allowUnderscore: boolean,
  files: Set<string>,
  skillFileRel?: string
): string {
  const add = (rule: string, message: string, line?: number) =>
    collector.add(rule, message, folderName, skillFileRel ? { file: skillFileRel, line } : undefined);

  if (!skill.hasFrontmatter) {
    add("frontmatter", "SKILL.md must start with YAML frontmatter between --- delimiters", 1);
    return "";
  }

  // Checked before parsing: tab indentation usually makes the YAML invalid.
  const tabLines = (skill.frontmatterRaw ?? "")
    .split("\n")
    .map((line, index) => (line.includes("\t") ? index + 2 : 0))
    .filter(Boolean);
  if (tabLines.length > 0) {
    add("frontmatter-tabs", `YAML frontmatter must not contain tabs (lines ${tabLines.join(", ")})`, tabLines[0]);
  }
  if (!skill.isValidYaml) {
    add("frontmatter", `invalid YAML frontmatter (${skill.yamlErrors[0] ?? "expected a mapping"})`, 1);
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
  } else {
    if (description.length > MAX_DESCRIPTION) {
      add("description-length", `description has ${description.length} characters (max ${MAX_DESCRIPTION})`);
    }
    const stage1Tokens = estimateTokens(`${name || folderName}\n${description}`);
    if (stage1Tokens > options.maxDescriptionTokens) {
      add(
        "description-budget",
        `Stage-1 always-loaded metadata is ~${stage1Tokens} tokens (recommended max ${options.maxDescriptionTokens})`
      );
    }
    if (description.length < 40) {
      add(
        "description-triggers",
        "description is too short (< 40 chars) to guide routing; explain what the skill does and when to use it"
      );
    } else if (!TRIGGER_CUE_PATTERN.test(description)) {
      add(
        "description-triggers",
        "description should explain when to activate the skill (for example, 'Use when ...')"
      );
    }
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

  if (!skill.getString("metadata", "owner")) {
    add("owner-required", "frontmatter metadata.owner is required");
  }

  if (skill.has("metadata", "status")) {
    const status = skill.getString("metadata", "status");
    if (!status || !(SKILL_STATUSES as readonly string[]).includes(status)) {
      add(
        "status-valid",
        `metadata.status must be one of: ${SKILL_STATUSES.join(", ")} (got '${status || "(empty)"}')`
      );
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
    const pattern = placeholderPattern(placeholder);
    if (pattern.test(content)) {
      add("placeholders", `contains a forbidden placeholder ("${placeholder}")`, findLine(content, pattern));
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

  for (const unused of findUnusedResources(skill.body, files)) {
    add("unused-resources", `unused resource '${unused}' is never referenced from SKILL.md`);
  }

  const instructionsSection = extractSection(skill.body, ["instructions"]);
  if (instructionsSection !== null) {
    const strippedInstructions = stripFencedCode(instructionsSection);
    if (!/^\s*1\.\s+\S/m.test(strippedInstructions) && !/^###\s+1\.\s+\S/m.test(strippedInstructions)) {
      add(
        "numbered-steps",
        "## Instructions should use numbered steps (1., 2., ...) or numbered subsections (### 1., ### 2.)"
      );
    }
  }

  const strippedBody = stripFencedCode(skill.body);
  for (const phrase of options.vagueFallbacks) {
    const pattern = placeholderPattern(phrase);
    if (pattern.test(strippedBody)) {
      add(
        "vague-fallback",
        `contains vague error-recovery phrase ("${phrase}"); specify a concrete diagnostic or recovery action`,
        findLine(content, pattern)
      );
    }
  }

  const recoverySection = extractSection(skill.body, ["error recovery", "troubleshooting"]);
  if (recoverySection !== null && !hasMarkdownTable(recoverySection)) {
    add(
      "error-recovery-table",
      "## Error Recovery should contain a Markdown table mapping failure cases to concrete recovery actions"
    );
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

function inspectReferences(body: string, files: Set<string>): { broken: string[]; referenced: Set<string> } {
  const text = stripFencedCode(body);
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join("/"));
  }

  const targets = new Set<string>();
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) targets.add(match[1]);
  for (const match of text.matchAll(/`((?:references|scripts|assets)\/[^`\s]+)`/g)) targets.add(match[1]);

  const broken: string[] = [];
  const referenced = new Set<string>();
  for (const raw of targets) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.startsWith("/") || NOT_A_PATH.test(raw))
      continue;
    const clean = safeDecode(raw.split(/[?#]/)[0]);
    if (!clean) continue;
    const resolved = path.posix.normalize(clean).replace(/\/+$/, "");
    if (resolved === "." || resolved === "") continue;
    if (resolved === ".." || resolved.startsWith("../")) {
      broken.push(`reference '${raw}' points outside the skill folder`);
    } else if (!files.has(resolved) && !directories.has(resolved)) {
      broken.push(`reference '${raw}' does not exist in the skill folder`);
    } else {
      referenced.add(resolved);
    }
  }
  return { broken, referenced };
}

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
  return inspectReferences(body, files).broken;
}

const RESOURCE_PREFIX_PATTERN = /^(?:references|scripts|assets)\//;

/**
 * Lists files under `references/`, `scripts/` and `assets/` that are never referenced from
 * `SKILL.md` (either directly or via an ancestor directory such as `scripts/`).
 *
 * Hidden files whose basename starts with `.` (such as `.gitkeep`) are ignored.
 *
 * @param body - Markdown body (LF).
 * @param files - Files of the skill folder, as posix paths relative to it.
 * @returns Unreferenced resource paths, sorted alphabetically.
 */
export function findUnusedResources(body: string, files: Set<string>): string[] {
  const { referenced } = inspectReferences(body, files);
  for (const match of stripFencedCode(body).matchAll(/`((?:references|scripts|assets))\/`/g)) {
    referenced.add(match[1]);
  }
  const unused: string[] = [];
  for (const file of files) {
    if (!RESOURCE_PREFIX_PATTERN.test(file)) continue;
    const base = path.posix.basename(file);
    if (base.startsWith(".")) continue;
    const parts = file.split("/");
    let isReferenced = false;
    for (let i = 1; i <= parts.length; i += 1) {
      if (referenced.has(parts.slice(0, i).join("/"))) {
        isReferenced = true;
        break;
      }
    }
    if (!isReferenced) unused.push(file);
  }
  return unused.sort();
}

/**
 * Checks a skill's `params.json` and template, and renders it with the default values.
 *
 * @returns The rendered skill, or `null` when the skill has no parameters or cannot be rendered
 *   (the problem is reported and the raw file is validated instead).
 */
async function renderForValidation(
  library: Library,
  folder: string,
  raw: SkillFile,
  collector: Collector
): Promise<{ skill: SkillFile | null; params: ParamDefinitions | null; paramsValid: boolean }> {
  const paramsRelFile = `${library.skillsDirRef}/${folder}/${PARAMS_FILE}`;
  const skillRelFile = `${library.skillsDirRef}/${folder}/SKILL.md`;
  let params: ParamDefinitions | null;
  try {
    params = await library.readSkillParams(folder);
  } catch (error) {
    collector.add("params-file", (error as Error).message, folder, { file: paramsRelFile, line: 1 });
    return { skill: null, params: null, paramsValid: false };
  }
  if (!params) return { skill: null, params: null, paramsValid: true };

  const source = raw.toLfString();
  const undeclared = findUndeclaredParams(source, params);
  if (undeclared.length > 0) {
    collector.add(
      "params-template",
      `uses undeclared parameter(s) ${undeclared.map((name) => `{{${name}}}`).join(", ")}; declare them in ${PARAMS_FILE}`,
      folder,
      { file: skillRelFile }
    );
  }
  try {
    return {
      skill: SkillFile.parse(renderTemplate(source, resolveParamValues(params, {}, folder))),
      params,
      paramsValid: true
    };
  } catch (error) {
    collector.add("params-template", (error as Error).message, folder, { file: skillRelFile });
    return { skill: null, params, paramsValid: true };
  }
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
  const stage1Summaries: {
    folder: string;
    name: string;
    description: string;
    tokens: number;
    uniqueTokens: string[];
  }[] = [];
  const statusByFolder = new Map<string, string>();
  const replacedByByFolder = new Map<string, string>();
  const triggerOwners = new Map<string, { folder: string; prompt: string }>();
  const validSkills = new Set<string>();

  for (const folder of validated) {
    const skillRelFile = `${library.skillsDirRef}/${folder}/SKILL.md`;
    const evalsRelFile = `${library.skillsDirRef}/${folder}/${EVALS_FILE}`;
    let skill: SkillFile;
    try {
      skill = await library.readSkill(folder);
    } catch {
      collector.add("skill-file", "missing SKILL.md", folder, { file: skillRelFile, line: 1 });
      continue;
    }
    // Parametrized skills are checked as rendered with their default values.
    const { skill: rendered, params, paramsValid } = await renderForValidation(library, folder, skill, collector);
    if (rendered) skill = rendered;

    let evals: SkillEvals | null = null;
    let evalsReadable = true;
    try {
      evals = await library.readSkillEvals(folder);
    } catch (error) {
      evalsReadable = false;
      collector.add("evals-file", (error as Error).message, folder, { file: evalsRelFile, line: 1 });
    }
    if (evals && paramsValid) {
      for (const testCase of evals.cases ?? []) {
        if (!testCase.params) continue;
        try {
          resolveParamValues(params ?? {}, testCase.params, `${folder} (evals case '${testCase.id}')`);
        } catch (error) {
          collector.add("evals-file", (error as Error).message, folder, { file: evalsRelFile, line: 1 });
        }
      }
    }
    if (evals?.triggers?.shouldTrigger) {
      for (const entry of evals.triggers.shouldTrigger) {
        const key = entry.prompt
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ")
          .replace(/[.?!]+$/, "");
        if (!key) continue;
        const owner = triggerOwners.get(key);
        if (owner && owner.folder !== folder) {
          collector.add(
            "duplicate-trigger",
            `shouldTrigger prompt "${entry.prompt}" is already claimed by '${owner.folder}'`,
            folder,
            { file: evalsRelFile, line: 1 }
          );
        } else if (!owner) {
          triggerOwners.set(key, { folder, prompt: entry.prompt });
        }
      }
    }
    if (
      evalsReadable &&
      (!evals ||
        (evals.triggers?.shouldTrigger.length ?? 0) === 0 ||
        (evals.triggers?.shouldNotTrigger.length ?? 0) === 0)
    ) {
      collector.add(
        "evals-required",
        "missing evals.json with at least one shouldTrigger and one shouldNotTrigger prompt",
        folder,
        { file: evalsRelFile, line: 1 }
      );
    }
    const files = new Set(await listFiles(library.skillPath(folder)));
    await scanSkillTextFiles(library, folder, files, collector);
    const allowUnderscore = library.categories.fromFolder(folder).prefix === "_";
    const name = validateSkillFile(collector, folder, skill, ruleOptions, allowUnderscore, files, skillRelFile);
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
    if (skill.isValidYaml) {
      validSkills.add(folder);
      const status = skill.getString("metadata", "status");
      if (status) statusByFolder.set(folder, status);
      const replacedBy = skill.getString("metadata", "replaced-by");
      if (replacedBy) replacedByByFolder.set(folder, replacedBy);

      const description = skill.getString("description");
      const effectiveName = name || folder;
      const tokens = description ? estimateTokens(`${effectiveName}\n${description}`) : 0;
      const uniqueTokens = [...new Set(tokenizeForSimilarity(`${effectiveName} ${description}`))];
      stage1Summaries.push({ folder, name: effectiveName, description, tokens, uniqueTokens });
    }
  }

  for (const [folder, target] of replacedByByFolder) {
    if (target === folder) {
      collector.add("replaced-by-exists", `metadata.replaced-by ('${target}') cannot reference itself`, folder);
    } else if (!validSkills.has(target)) {
      collector.add(
        "replaced-by-exists",
        `metadata.replaced-by target '${target}' does not exist (or is not a publishable skill)`,
        folder
      );
    } else if (statusByFolder.get(target) === "deprecated") {
      collector.add("replaced-by-exists", `metadata.replaced-by target '${target}' is also deprecated`, folder);
    }
  }

  if (ruleOptions.maxAlwaysLoadedTokens !== undefined) {
    const totalStage1 = stage1Summaries.reduce((sum, entry) => sum + entry.tokens, 0);
    if (totalStage1 > ruleOptions.maxAlwaysLoadedTokens) {
      collector.add(
        "always-loaded-budget",
        `total Stage-1 always-loaded metadata is ~${totalStage1} tokens across ${stage1Summaries.length} skill(s) (max ${ruleOptions.maxAlwaysLoadedTokens})`
      );
    }
  }

  for (let i = 0; i < stage1Summaries.length; i += 1) {
    const a = stage1Summaries[i];
    if (a.uniqueTokens.length < 3) continue;
    for (let j = i + 1; j < stage1Summaries.length; j += 1) {
      const b = stage1Summaries[j];
      if (b.uniqueTokens.length < 3) continue;
      const similarity = jaccardSimilarity(a.uniqueTokens, b.uniqueTokens);
      if (similarity >= ruleOptions.overlapThreshold) {
        collector.add(
          "description-overlap",
          `description closely overlaps with '${a.folder}' (${Math.round(similarity * 100)}% lexical similarity); sharpen trigger boundaries`,
          b.folder
        );
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
