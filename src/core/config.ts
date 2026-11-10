/**
 * Library configuration: the `.skanvilrc.json` schema, the default preset and resolution of
 * user values into a fully populated {@link ResolvedConfig}.
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** File name of the library configuration, looked up in the library root. */
export const CONFIG_FILE = ".skanvilrc.json";

/** Allowed severities for a validation rule. `off` disables the rule. */
export const SEVERITIES = ["error", "warn", "off"] as const;

/** Severity of a validation rule as configured in `validation.rules`. */
export type Severity = (typeof SEVERITIES)[number];

/** Valid category prefixes: empty (default category only), `_`, or kebab-case ending in `-`. */
const PREFIX_PATTERN = /^(|_|[a-z0-9]+(?:-[a-z0-9]+)*-)$/;

const CategorySchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "category id must be kebab-case")
      .describe("Category identifier used by `--type` (kebab-case)."),
    prefix: z
      .string()
      .regex(PREFIX_PATTERN, "prefix must be empty, '_' or kebab-case ending in '-'")
      .optional()
      .describe(
        "Folder-name prefix of the category's skills, e.g. `front-` or `_`. Only the default category may be empty."
      ),
    title: z.string().min(1).optional().describe("README section title. Defaults to the title-cased id."),
    aliases: z.array(z.string()).optional().describe("Alternative names accepted by `--type` (case-insensitive)."),
    default: z
      .boolean()
      .optional()
      .describe(
        "Marks the fallback category for folders without a known prefix. Exactly one category must be the default."
      ),
    indexed: z.boolean().optional().describe("List the category's skills in the README index. Default: true."),
    validated: z
      .boolean()
      .optional()
      .describe("Validate the category's skills against the spec and allow syncing them. Default: true."),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .describe("Key/value pairs written to the `metadata` frontmatter map of new or retyped skills."),
    compatibility: z
      .string()
      .max(500)
      .optional()
      .describe("Value written to the `compatibility` frontmatter field of new or retyped skills (max 500 chars).")
  })
  .strict()
  .describe("A skill category: folder prefix, README section and frontmatter defaults.");

/**
 * Zod schema of `.skanvilrc.json`. Every field is optional; see {@link resolveConfig} for defaults.
 * It is also published as JSON Schema in `skanvil/schema.json`.
 */
export const ConfigSchema = z
  .object({
    $schema: z.string().optional().describe("JSON Schema reference for editor support."),
    name: z.string().optional().describe("Library name (informational)."),
    scope: z.string().optional().describe("npm scope without '@' (informational)."),
    skillsDir: z
      .string()
      .min(1)
      .optional()
      .describe("Folder holding the skills, relative to the library root. Default: skills."),
    readme: z.string().min(1).optional().describe("README file holding the skills index. Default: README.md."),
    categories: z
      .array(CategorySchema)
      .min(1)
      .optional()
      .describe("Skill categories. Replaces the default preset (front, back, transversal, internal) when set."),
    validation: z
      .object({
        requiredSections: z
          .array(z.string())
          .optional()
          .describe("Level-2 headings (`## Name`) every SKILL.md must contain, compared case-insensitively."),
        placeholders: z
          .array(z.string())
          .optional()
          .describe("Forbidden placeholder strings. ALL-CAPS entries (TODO) match case-sensitively as words."),
        maxLines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Line count reported by the `max-lines` rule. Default: 500."),
        rules: z
          .record(z.string(), z.enum(SEVERITIES))
          .optional()
          .describe('Per-rule severity overrides, e.g. { "max-lines": "off" }. See `skanvil validate --help`.')
      })
      .strict()
      .optional()
      .describe("Validation settings."),
    templates: z
      .object({
        dir: z
          .string()
          .min(1)
          .optional()
          .describe("Folder with custom templates, relative to the library root. Default: .skanvil/templates.")
      })
      .strict()
      .optional()
      .describe("Custom template settings."),
    sync: z
      .object({
        targets: z
          .array(z.string())
          .optional()
          .describe("Default `skanvil sync` targets: presets (claude, copilot, agents, codex) or paths."),
        mode: z.enum(["copy", "link"]).optional().describe("Default sync mode. Default: copy.")
      })
      .strict()
      .optional()
      .describe("Defaults for `skanvil sync`.")
  })
  .strict()
  .describe("skanvil library configuration.");

/** Configuration exactly as written in `.skanvilrc.json` (all fields optional). */
export type RawConfig = z.infer<typeof ConfigSchema>;

/** A category exactly as written in `.skanvilrc.json`. */
export type RawCategory = z.infer<typeof CategorySchema>;

/** A category with every default applied. */
export interface Category {
  /** Identifier used by `--type`. */
  id: string;
  /** Folder-name prefix; `""` only for the default category. */
  prefix: string;
  /** README section title. */
  title: string;
  /** Lower-cased alternative names accepted by `--type`. */
  aliases: string[];
  /** Whether this is the fallback category for unprefixed folders. */
  default: boolean;
  /** Whether skills of this category are listed in the README index. */
  indexed: boolean;
  /** Whether skills of this category are validated against the spec and can be synced. */
  validated: boolean;
  /** Metadata written to new or retyped skills. */
  metadata: Record<string, string>;
  /** `compatibility` written to new or retyped skills, if any. */
  compatibility?: string;
}

/** Configuration with every default applied. Produced by {@link resolveConfig}. */
export interface ResolvedConfig {
  /** Library name, if configured. */
  name?: string;
  /** npm scope, if configured. */
  scope?: string;
  /** Skills folder relative to the library root. @defaultValue `"skills"` */
  skillsDir: string;
  /** README file relative to the library root. @defaultValue `"README.md"` */
  readme: string;
  /** Categories in configuration order (also the README section order). */
  categories: Category[];
  /** Validation settings. */
  validation: {
    /** Required `## Section` headings. @defaultValue {@link DEFAULT_REQUIRED_SECTIONS} */
    requiredSections: string[];
    /** Forbidden placeholder strings. @defaultValue {@link DEFAULT_PLACEHOLDERS} */
    placeholders: string[];
    /** Line limit for the `max-lines` rule. @defaultValue {@link DEFAULT_MAX_LINES} */
    maxLines: number;
    /** Severity overrides by rule id. */
    rules: Record<string, Severity>;
  };
  /** Custom templates folder. @defaultValue `{ dir: ".skanvil/templates" }` */
  templates: { dir: string };
  /** Sync defaults. @defaultValue `{ targets: [], mode: "copy" }` */
  sync: { targets: string[]; mode: "copy" | "link" };
}

/**
 * The default preset: `front-` and `back-` prefixes, a prefix-less
 * `transversal` default category and `_internal` skills that are neither indexed nor validated.
 */
export const DEFAULT_CATEGORIES: RawCategory[] = [
  {
    id: "front",
    prefix: "front-",
    title: "Front",
    aliases: ["frontend", "f"],
    metadata: { domain: "frontend" },
    compatibility: "Designed for skills-compatible coding agents in frontend repositories."
  },
  {
    id: "back",
    prefix: "back-",
    title: "Backend",
    aliases: ["backend", "b"],
    metadata: { domain: "backend" },
    compatibility: "Designed for skills-compatible coding agents in backend repositories."
  },
  {
    id: "transversal",
    prefix: "",
    title: "Transversal",
    default: true,
    aliases: ["transverse", "shared", "common", "t"],
    metadata: { domain: "transversal" },
    compatibility: "Designed for skills-compatible coding agents in shared or cross-functional repositories."
  },
  {
    id: "internal",
    prefix: "_",
    title: "Internal",
    indexed: false,
    validated: false,
    aliases: ["private", "i"],
    metadata: { domain: "internal" },
    compatibility: "Designed for maintainers of this repository and internal workflow automation."
  }
];

/** Sections every SKILL.md must contain by default. */
export const DEFAULT_REQUIRED_SECTIONS = [
  "Objective",
  "When to Activate This Skill",
  "Instructions",
  "Output Format",
  "Quality Criteria"
];

/** Placeholder strings rejected by default. */
export const DEFAULT_PLACEHOLDERS = ["TODO", "describe...", "lorem ipsum", "tbd", "to be defined"];

/** Recommended maximum SKILL.md length from the Agent Skills spec. */
export const DEFAULT_MAX_LINES = 500;

function titleFromId(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Applies category defaults and checks cross-category constraints.
 *
 * @throws Error listing every problem: not exactly one default category, a default with a prefix,
 *   a non-default without one, an id/alias used twice, ambiguous prefixes (one starts with another)
 *   or duplicated README titles.
 */
function resolveCategories(raw: RawCategory[]): Category[] {
  const categories: Category[] = raw.map((entry) => ({
    id: entry.id,
    prefix: entry.prefix ?? "",
    title: entry.title ?? titleFromId(entry.id),
    aliases: (entry.aliases ?? []).map((alias) => alias.trim().toLowerCase()),
    default: entry.default ?? (entry.prefix ?? "") === "",
    indexed: entry.indexed ?? true,
    validated: entry.validated ?? true,
    metadata: entry.metadata ?? {},
    compatibility: entry.compatibility
  }));

  const problems: string[] = [];
  const defaults = categories.filter((category) => category.default);
  if (defaults.length !== 1) {
    problems.push(`exactly one category must be the default (found ${defaults.length})`);
  }
  for (const category of categories) {
    if (category.default && category.prefix !== "") {
      problems.push(`default category '${category.id}' must have an empty prefix`);
    }
    if (!category.default && category.prefix === "") {
      problems.push(`category '${category.id}' needs a prefix (only the default category may have none)`);
    }
  }

  const keys = new Map<string, string>();
  for (const category of categories) {
    for (const key of [category.id, ...category.aliases]) {
      if (keys.has(key) && keys.get(key) !== category.id) {
        problems.push(`'${key}' is used by both '${keys.get(key)}' and '${category.id}'`);
      }
      keys.set(key, category.id);
    }
  }

  const prefixed = categories.filter((category) => category.prefix);
  for (const a of prefixed) {
    for (const b of prefixed) {
      if (a !== b && b.prefix.startsWith(a.prefix)) {
        problems.push(`prefix '${a.prefix}' (${a.id}) is ambiguous with '${b.prefix}' (${b.id})`);
      }
    }
  }

  const titles = new Map<string, string>();
  for (const category of categories.filter((entry) => entry.indexed)) {
    const key = category.title.toLowerCase();
    if (titles.has(key)) {
      problems.push(`README title '${category.title}' is used by both '${titles.get(key)}' and '${category.id}'`);
    }
    titles.set(key, category.id);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid categories in ${CONFIG_FILE}:\n - ${problems.join("\n - ")}`);
  }
  return categories;
}

/**
 * Validates a raw configuration and applies every default.
 *
 * @remarks A missing or minimal config (such as `{ name, scope }`)
 * resolves to the {@link DEFAULT_CATEGORIES} preset.
 *
 * @param raw - Parsed `.skanvilrc.json` content (any JSON value; it is validated here).
 * @returns The resolved configuration.
 * @throws Error when the value does not match {@link ConfigSchema} or the categories are inconsistent.
 *
 * @example
 * ```ts
 * const config = resolveConfig({
 *   categories: [{ id: "mobile", prefix: "mobile-" }, { id: "general", default: true }]
 * });
 * config.categories[1].title; // "General"
 * ```
 */
export function resolveConfig(raw: unknown = {}): ResolvedConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`Invalid ${CONFIG_FILE}:\n - ${issues.join("\n - ")}`);
  }
  const config = parsed.data;

  return {
    name: config.name || undefined,
    scope: config.scope || undefined,
    skillsDir: config.skillsDir ?? "skills",
    readme: config.readme ?? "README.md",
    categories: resolveCategories(config.categories ?? DEFAULT_CATEGORIES),
    validation: {
      requiredSections: config.validation?.requiredSections ?? DEFAULT_REQUIRED_SECTIONS,
      placeholders: config.validation?.placeholders ?? DEFAULT_PLACEHOLDERS,
      maxLines: config.validation?.maxLines ?? DEFAULT_MAX_LINES,
      rules: config.validation?.rules ?? {}
    },
    templates: { dir: config.templates?.dir ?? ".skanvil/templates" },
    sync: { targets: config.sync?.targets ?? [], mode: config.sync?.mode ?? "copy" }
  };
}

/**
 * Reads `.skanvilrc.json` from a library root without validating it.
 *
 * @param root - Library root folder.
 * @returns The parsed JSON, or `{}` when the file does not exist.
 * @throws Error when the file exists but is not valid JSON.
 */
export async function readRawConfig(root: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, CONFIG_FILE), "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse ${CONFIG_FILE}: ${(error as Error).message}`);
  }
}

/**
 * Loads and resolves the configuration of a library.
 *
 * @param root - Library root folder.
 * @returns The resolved configuration (defaults when there is no config file).
 * @throws Error when the file is not valid JSON or fails validation.
 * @see {@link resolveConfig}
 */
export async function loadConfig(root: string): Promise<ResolvedConfig> {
  return resolveConfig(await readRawConfig(root));
}

/**
 * Builds the JSON Schema (draft-07) of `.skanvilrc.json`, published as `skanvil/schema.json`.
 *
 * @returns A JSON Schema object including the field descriptions.
 */
export function configJsonSchema(): unknown {
  return z.toJSONSchema(ConfigSchema, { target: "draft-7" });
}
