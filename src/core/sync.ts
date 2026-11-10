/**
 * `skanvil sync`: installation of a library's skills into the skill folders that agents read.
 *
 * @module
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { exists, hashDirectory } from "../util/fs.js";
import { packageVersion } from "../util/paths.js";
import type { Library } from "./library.js";
import { validateLibrary } from "./validate.js";

/**
 * Project-level skill folders read by each agent, relative to the project root.
 *
 * - `claude`: Claude Code. GitHub Copilot also reads it.
 * - `copilot`: GitHub Copilot in VS Code, the Copilot CLI and the coding agent.
 * - `agents` / `codex`: OpenAI Codex. GitHub Copilot also reads it.
 */
export const TARGET_PRESETS: Record<string, string> = {
  claude: ".claude/skills", // Claude Code
  copilot: ".github/skills", // GitHub Copilot (VS Code, CLI, coding agent)
  agents: ".agents/skills", // OpenAI Codex and other agents following the shared convention
  codex: ".agents/skills"
};

/**
 * User-level skill folders read by each agent, relative to the home directory. Skills here are
 * available in every project of the user (`--global`).
 *
 * - `claude`: Claude Code (`~/.claude/skills`).
 * - `copilot`: GitHub Copilot (`~/.copilot/skills`).
 * - `agents` / `codex`: OpenAI Codex, also read by Copilot (`~/.agents/skills`).
 */
export const USER_TARGET_PRESETS: Record<string, string> = {
  claude: ".claude/skills",
  copilot: ".copilot/skills",
  agents: ".agents/skills",
  codex: ".agents/skills"
};

/** Where targets are resolved: inside a project (`dest`) or in the user's home folder. */
export type TargetScope = "project" | "user";

/** Options of {@link resolveTarget}. */
export interface ResolveTargetOptions {
  /** @defaultValue `"project"` */
  scope?: TargetScope;
  /** Home folder used for the `user` scope. @defaultValue `os.homedir()` */
  homeDir?: string;
}

/** Manifest file written in each target folder to remember which skills skanvil installed. */
export const MANIFEST_FILE = ".skanvil-sync.json";

/** Content of {@link MANIFEST_FILE}. */
interface Manifest {
  tool: "skanvil";
  /** skanvil version that wrote the manifest. */
  version: string;
  /** Library root, relative to the target folder (posix). */
  source: string;
  /** Installed skills: content hash of the source folder and how it was placed. */
  skills: Record<string, { hash: string; mode: "copy" | "link" }>;
}

/** Options of {@link syncSkills}. */
export interface SyncOptions {
  /** Project folder that receives the skills. */
  dest: string;
  /** Preset names (see {@link TARGET_PRESETS}) or paths relative to `dest`. */
  targets: string[];
  /** Copy files or create symlinks (junctions on Windows). @defaultValue `config.sync.mode` */
  mode?: "copy" | "link";
  /** Report what would change without writing anything. @defaultValue `false` */
  dryRun?: boolean;
  /** Sync skills even when they have validation errors. @defaultValue `false` */
  force?: boolean;
  /** Only sync these categories (ids or aliases). Disables pruning. */
  categories?: string[];
  /** Only sync these skill folders. Disables pruning. */
  skills?: string[];
  /** Install into the project (`dest`) or the user's home folder. @defaultValue `"project"` */
  scope?: TargetScope;
  /** Home folder for the `user` scope. @defaultValue `os.homedir()` */
  homeDir?: string;
}

/** Outcome of {@link syncSkills} for one target. */
export interface TargetResult {
  /** Target as given (preset name or path). */
  target: string;
  /** Absolute target folder. */
  path: string;
  /** Skills installed for the first time. */
  added: string[];
  /** Skills whose content (or mode) changed and were replaced. */
  updated: string[];
  /** Skills already up to date. */
  unchanged: string[];
  /** Previously installed skills removed because they no longer exist in the library. */
  removed: string[];
  /** Skills not installed, with the reason. */
  skipped: { skill: string; reason: string }[];
  /** Non-fatal problems, such as a link that fell back to a copy. */
  warnings: string[];
}

/**
 * Resolves a sync target to an absolute folder.
 *
 * - **Project scope:** presets resolve against `dest` ({@link TARGET_PRESETS}). Custom paths must
 *   stay inside `dest`, so a typo such as `../..` can never write or prune outside the project.
 * - **User scope:** only presets are accepted, and they resolve against the home folder
 *   ({@link USER_TARGET_PRESETS}).
 *
 * @param dest - Project root (ignored for the user scope).
 * @param target - Preset name, or a path relative to `dest`.
 * @param options - Scope and home folder.
 * @returns Absolute target folder.
 * @throws Error when a custom path leaves `dest`, or when a non-preset is used in the user scope.
 */
export function resolveTarget(dest: string, target: string, options: ResolveTargetOptions = {}): string {
  if (options.scope === "user") {
    const preset = USER_TARGET_PRESETS[target];
    if (!preset) {
      throw new Error(
        `Global installs only accept presets (${Object.keys(USER_TARGET_PRESETS).join(", ")}), got '${target}'.`
      );
    }
    return path.join(options.homeDir ?? os.homedir(), preset);
  }

  const root = path.resolve(dest);
  if (TARGET_PRESETS[target]) return path.resolve(root, TARGET_PRESETS[target]);

  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Target '${target}' must be a folder inside ${root}.`);
  }
  return resolved;
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8"));
    return parsed && parsed.tool === "skanvil" && parsed.skills ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the `--from` option to a library root.
 *
 * @param from - Folder path (relative to `dest`) or npm package name, e.g. `@acme/my-skills`.
 * @param dest - Project root; packages are searched in `node_modules` from here upwards.
 * @returns Absolute library root.
 * @throws Error when neither a folder nor an installed package matches.
 */
export async function resolveSource(from: string, dest: string): Promise<string> {
  const direct = path.resolve(dest, from);
  if (await exists(direct)) return direct;
  let dir = path.resolve(dest);
  for (;;) {
    const candidate = path.join(dir, "node_modules", from);
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot find skills source '${from}' (not a folder, nor an installed npm package).`);
}

/**
 * Replaces `target` with a copy of `source`, or a link to it.
 *
 * @returns The mode actually used: a failed link falls back to a copy and adds a warning.
 */
async function place(
  source: string,
  target: string,
  mode: "copy" | "link",
  warnings: string[]
): Promise<"copy" | "link"> {
  await fs.rm(target, { recursive: true, force: true });
  if (mode === "link") {
    try {
      // Junctions need no admin rights / Developer Mode on Windows.
      await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
      return "link";
    } catch (error) {
      warnings.push(`could not link ${path.basename(target)} (${(error as Error).message}); copied instead`);
    }
  }
  await fs.cp(source, target, { recursive: true });
  return "copy";
}

/**
 * Installs a library's publishable skills into the agent skill folders of a project.
 *
 * Which skills are synced:
 * - only categories with `validated: true`, so `_internal` skills are never published;
 * - skills with validation errors are skipped unless `force` is set;
 * - a target folder that already exists but is not in the manifest belongs to someone else and
 *   is skipped, never overwritten.
 *
 * @remarks Idempotent. Each target holds a {@link MANIFEST_FILE} with the hash of every skill
 * skanvil installed. Re-running:
 * - leaves unchanged skills alone and replaces changed ones;
 * - removes skills that were deleted from the library, unless a `categories`/`skills` filter is given;
 * - keeps the last good copy of a skill that is temporarily failing validation.
 *
 * @param library - Source library.
 * @param options - Destination, targets and filters.
 * @returns One result per target, in the order given.
 * @throws Error when a category filter is unknown or the library README cannot be read.
 *
 * @example
 * ```ts
 * const [claude] = await syncSkills(lib, { dest: "../app", targets: ["claude"], dryRun: true });
 * console.log(claude.added, claude.updated, claude.removed);
 * ```
 */
export async function syncSkills(library: Library, options: SyncOptions): Promise<TargetResult[]> {
  const mode = options.mode ?? library.config.sync.mode;
  const filtered = Boolean(options.categories?.length || options.skills?.length);
  const categoryFilter = options.categories?.length
    ? options.categories.map((value) => library.categories.resolve(value).id)
    : null;

  const validation = await validateLibrary(library);
  const failing = new Set(
    validation.diagnostics
      .filter(
        (diagnostic) => diagnostic.severity === "error" && diagnostic.skill && !diagnostic.rule.startsWith("readme-")
      )
      .map((diagnostic) => diagnostic.skill!)
  );

  const skipped: { skill: string; reason: string }[] = [];
  const candidates: string[] = [];
  for (const folder of await library.listSkillFolders()) {
    const category = library.categories.fromFolder(folder);
    if (!category.validated) continue; // e.g. _internal skills: not spec-compliant names
    if (categoryFilter && !categoryFilter.includes(category.id)) continue;
    if (options.skills?.length && !options.skills.includes(folder)) continue;
    if (!(await library.hasSkill(folder))) continue;
    if (failing.has(folder) && !options.force) {
      skipped.push({ skill: folder, reason: "has validation errors (use --force)" });
      continue;
    }
    candidates.push(folder);
  }
  if (options.skills?.length) {
    for (const name of options.skills) {
      if (!candidates.includes(name) && !skipped.some((entry) => entry.skill === name)) {
        skipped.push({ skill: name, reason: "not found or not publishable" });
      }
    }
  }

  const hashes = new Map<string, string>();
  for (const name of candidates) hashes.set(name, await hashDirectory(library.skillPath(name)));

  // Resolve every target first, so an invalid one fails before anything is written.
  const dirs = options.targets.map((target) =>
    resolveTarget(options.dest, target, { scope: options.scope, homeDir: options.homeDir })
  );

  const results: TargetResult[] = [];
  for (const [index, target] of options.targets.entries()) {
    const dir = dirs[index];
    const manifest = (await readManifest(dir)) ?? { tool: "skanvil", version: "", source: "", skills: {} };
    const result: TargetResult = {
      target,
      path: dir,
      added: [],
      updated: [],
      unchanged: [],
      removed: [],
      skipped: [...skipped],
      warnings: []
    };
    const next: Manifest = {
      tool: "skanvil",
      version: packageVersion(),
      // Relative, so a committed manifest does not change from machine to machine.
      source: path.relative(dir, library.root).split(path.sep).join("/"),
      skills: filtered ? { ...manifest.skills } : {}
    };

    if (!options.dryRun) await fs.mkdir(dir, { recursive: true });

    for (const name of candidates) {
      const destination = path.join(dir, name);
      const previous = manifest.skills[name];
      const present = await exists(destination);
      const hash = hashes.get(name)!;

      if (present && !previous) {
        result.skipped.push({ skill: name, reason: `${destination} exists and is not managed by skanvil` });
        continue;
      }
      if (present && previous && previous.hash === hash && previous.mode === mode) {
        result.unchanged.push(name);
        next.skills[name] = previous;
        continue;
      }
      (present ? result.updated : result.added).push(name);
      const actualMode = options.dryRun
        ? mode
        : await place(library.skillPath(name), destination, mode, result.warnings);
      next.skills[name] = { hash, mode: actualMode };
    }

    if (!filtered) {
      for (const name of Object.keys(manifest.skills)) {
        if (candidates.includes(name)) continue;
        if (skipped.some((entry) => entry.skill === name)) {
          next.skills[name] = manifest.skills[name]; // keep the last good copy of a temporarily failing skill
          continue;
        }
        result.removed.push(name);
        if (!options.dryRun) await fs.rm(path.join(dir, name), { recursive: true, force: true });
      }
    }

    if (!options.dryRun) {
      await fs.writeFile(path.join(dir, MANIFEST_FILE), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    }
    results.push(result);
  }
  return results;
}
