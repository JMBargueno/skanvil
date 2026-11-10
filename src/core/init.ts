/**
 * `skanvil init`: generation of a new skills library.
 *
 * @module
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { isEmptyOrMissing } from "../util/fs.js";
import { installAgentSkill, type AgentSkillResult } from "./agent-skill.js";
import { Categories } from "./categories.js";
import {
  CONFIG_FILE,
  DEFAULT_CATEGORIES,
  DEFAULT_MAX_LINES,
  DEFAULT_PLACEHOLDERS,
  DEFAULT_REQUIRED_SECTIONS,
  resolveConfig,
  type RawCategory,
  type RawConfig
} from "./config.js";
import { Library } from "./library.js";
import { toKebabCase, toTitleCase } from "./naming.js";
import { buildSections } from "./readme-index.js";
import { resolveTarget } from "./sync.js";
import { builtinTemplate, copyTemplateDir, ejectSkillTemplate } from "./templates.js";

const defaultCategories = new Categories(resolveConfig().categories);

/**
 * Parses the `--profile` option into indexed category ids of the default preset.
 *
 * @param value - Comma-separated ids or aliases (`front,backend`), `"all"` or empty for all.
 * @returns Unique category ids in the given order.
 * @throws Error `Invalid profile` when an entry is unknown or not an indexed category.
 */
export function parseProfile(value?: string): string[] {
  const indexed = defaultCategories.indexed.map((category) => category.id);
  if (!value || value === "all") {
    return indexed;
  }
  const ids = String(value)
    .split(",")
    .map((part) => {
      try {
        const category = defaultCategories.resolve(part);
        return category.indexed ? category.id : null;
      } catch {
        return null;
      }
    });
  if (ids.some((id) => !id)) {
    throw new Error(`Invalid profile '${value}'. Use a comma-separated list of: ${indexed.join(", ")} (or 'all').`);
  }
  return [...new Set(ids as string[])];
}

/** Options of {@link createLibrary}. */
export interface CreateLibraryOptions {
  /** Library and package name (kebab-cased). @defaultValue the target folder name */
  name?: string;
  /** npm scope, with or without `@`; the package becomes `@scope/name`. */
  scope?: string;
  /** Library description for README and package.json. @defaultValue a generic sentence */
  description?: string;
  /** Indexed categories of the default preset to create README sections for. @defaultValue `"all"` */
  profile?: string;
  /**
   * Custom categories, written to `.skanvilrc.json` instead of the default preset. `profile` is
   * ignored when they are given, and a README section is created for every indexed category.
   */
  categories?: RawCategory[];
  /** Run `git init` in the new folder. @defaultValue `true` */
  git?: boolean;
  /** Copy the built-in skill template to `.skanvil/templates/skill`. @defaultValue `false` */
  ejectTemplates?: boolean;
  /** `sync.targets` written to the config. @defaultValue `["claude"]` */
  syncTargets?: string[];
  /**
   * Install the `skanvil` agent skill into the new library's agent folders (the `syncTargets`),
   * so agents working in the library know how to use the CLI. @defaultValue `true`
   */
  agentSkill?: boolean;
}

/** Result of {@link createLibrary}. */
export interface CreateLibraryResult {
  /** Final (kebab-cased) library name. */
  name: string;
  /** Absolute path of the library. */
  target: string;
  /** Whether `git init` succeeded (`false` when skipped or git is not installed). */
  gitInitialized: boolean;
  /** Where the `skanvil` agent skill was installed (empty when disabled). */
  agentSkill: AgentSkillResult[];
}

/**
 * Generates a new skills library from the built-in `templates/library` skeleton.
 *
 * It writes:
 * - README with empty index sections;
 * - package.json with `skanvil` scripts;
 * - agent instruction files;
 * - a CI workflow;
 * - a complete `.skanvilrc.json` with the given categories, or the default preset restricted to the
 *   chosen profile;
 * - the `skanvil` agent skill in the library's agent folders (see {@link installAgentSkill}).
 *
 * @param target - Destination folder; it must be empty or not exist.
 * @param options - Library settings.
 * @returns What was created.
 * @throws Error when the folder is not empty, the name is empty, the profile or categories are
 *   invalid, or a sync target leaves the library folder. Nothing is written in those cases.
 *
 * @example
 * ```ts
 * await createLibrary("./my-skills", { scope: "acme", profile: "front,back", git: false });
 * ```
 */
export async function createLibrary(target: string, options: CreateLibraryOptions = {}): Promise<CreateLibraryResult> {
  target = path.resolve(target);
  if (!(await isEmptyOrMissing(target))) {
    throw new Error(`Target folder is not empty: ${target}`);
  }

  const name = toKebabCase(options.name || path.basename(target));
  if (!name) {
    throw new Error("Library name is required.");
  }

  const scope = options.scope ? toKebabCase(String(options.scope).replace(/^@/, "")) : "";
  const title = toTitleCase(name.replace(/-/g, " "));
  const description = options.description || `Library of reusable Agent Skills: ${title}.`;
  const syncTargets = options.syncTargets ?? ["claude"];

  let categories: RawCategory[];
  let sectionTitles: string[];
  if (options.categories) {
    categories = options.categories;
    sectionTitles = new Categories(resolveConfig({ categories }).categories).indexed.map((category) => category.title);
  } else {
    // Keep the selected indexed categories plus every non-indexed one and the default.
    const profile = parseProfile(options.profile);
    categories = DEFAULT_CATEGORIES.filter(
      (category) => profile.includes(category.id) || category.indexed === false || category.default
    );
    sectionTitles = defaultCategories.indexed
      .filter((category) => profile.includes(category.id))
      .map((category) => category.title);
  }
  // Fail on invalid targets before anything is written.
  for (const syncTarget of syncTargets) resolveTarget(target, syncTarget);

  await copyTemplateDir(builtinTemplate("library"), target, {
    variables: {
      name,
      scope,
      packageName: scope ? `@${scope}/${name}` : name,
      title,
      description,
      sections: buildSections(sectionTitles)
    }
  });

  const rc: RawConfig = {
    $schema: "./node_modules/skanvil/schema.json",
    name,
    ...(scope ? { scope } : {}),
    skillsDir: "skills",
    categories,
    validation: {
      requiredSections: DEFAULT_REQUIRED_SECTIONS,
      placeholders: DEFAULT_PLACEHOLDERS,
      maxLines: DEFAULT_MAX_LINES,
      rules: {}
    },
    sync: { targets: syncTargets, mode: "copy" }
  };
  resolveConfig(rc); // sanity check
  await fs.writeFile(path.join(target, CONFIG_FILE), `${JSON.stringify(rc, null, 2)}\n`, "utf8");

  if (options.ejectTemplates) {
    await ejectSkillTemplate(new Library(target, resolveConfig(rc)));
  }

  const agentSkill =
    options.agentSkill === false ? [] : await installAgentSkill({ dest: target, targets: syncTargets });

  let gitInitialized = false;
  if (options.git !== false) {
    const result = spawnSync("git", ["init", "-q"], { cwd: target, stdio: "ignore" });
    gitInitialized = result.status === 0;
  }

  return { name, target, gitInitialized, agentSkill };
}
