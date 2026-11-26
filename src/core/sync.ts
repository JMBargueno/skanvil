/**
 * `skanvil sync`: installation of a library's skills into the skill folders that agents read,
 * plus `skanvil outdated` drift inspection and reproducible Git commit pinning (`--frozen`).
 *
 * @module
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { exists, hashDirectory, listFiles } from "../util/fs.js";
import { packageVersion } from "../util/paths.js";
import { SKILL_STATUSES } from "./config.js";
import { EVALS_FILE } from "./evals.js";
import { Library } from "./library.js";
import { PARAMS_FILE, renderTemplate, resolveParamValues, type ParamDefinitions } from "./params.js";
import { SkillFile } from "./skill.js";
import { estimateTokens } from "./text.js";
import { validateLibrary } from "./validate.js";

const execFileAsync = promisify(execFile);
const EXCLUDED_SYNC_FILES = new Set([PARAMS_FILE, EVALS_FILE]);
const GIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Project-level skill folders read by each agent, relative to the project root.
 *
 * - `claude`: Claude Code. GitHub Copilot also reads it.
 * - `copilot`: GitHub Copilot in VS Code, the Copilot CLI and the coding agent.
 * - `agents` / `codex`: OpenAI Codex. GitHub Copilot also reads it.
 * - `cursor`: Cursor (`.cursor/skills`).
 * - `opencode`: OpenCode (`.opencode/skills`).
 * - `windsurf`: Windsurf (`.windsurf/skills`).
 * - `gemini`: Gemini CLI (`.gemini/skills`).
 */
export const TARGET_PRESETS: Record<string, string> = {
  claude: ".claude/skills", // Claude Code
  copilot: ".github/skills", // GitHub Copilot (VS Code, CLI, coding agent)
  agents: ".agents/skills", // OpenAI Codex and other agents following the shared convention
  codex: ".agents/skills",
  cursor: ".cursor/skills", // Cursor
  opencode: ".opencode/skills", // OpenCode
  windsurf: ".windsurf/skills", // Windsurf
  gemini: ".gemini/skills" // Gemini CLI
};

/**
 * User-level skill folders read by each agent, relative to the home directory. Skills here are
 * available in every project of the user (`--global`).
 */
export const USER_TARGET_PRESETS: Record<string, string> = {
  claude: ".claude/skills",
  copilot: ".copilot/skills",
  agents: ".agents/skills",
  codex: ".agents/skills",
  cursor: ".cursor/skills",
  opencode: ".config/opencode/skills",
  windsurf: ".codeium/windsurf/skills",
  gemini: ".gemini/skills"
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

/** Installation metadata stored per synced skill inside {@link MANIFEST_FILE}. */
export interface InstalledSkillEntry {
  /** Short hash of the installed skill files. */
  hash: string;
  /** Placement mode actually used. */
  mode: "copy" | "link";
}

/** State recorded for one library source inside {@link ManifestV2}. */
export interface ManifestSourceEntry {
  /** Library source identifier (relative posix path or canonical Git specifier). */
  source: string;
  /** Resolved Git commit SHA when installed from a Git repository. */
  commitSha?: string;
  /** Requested Git branch or tag ref when installed with `#ref`. */
  ref?: string;
  /** Installed skills owned by this library source, keyed by skill folder name. */
  skills: Record<string, InstalledSkillEntry>;
  /** Parameter values used for this source, reused when omitted on re-sync. */
  params?: Record<string, string | boolean>;
}

/** Manifest v2 structure written to {@link MANIFEST_FILE}, supporting multiple coexisting libraries. */
export interface ManifestV2 {
  tool: "skanvil";
  /** Manifest schema version (`2`). */
  manifestVersion: 2;
  /** skanvil version that last updated the manifest. */
  version: string;
  /** Coexisting library sources keyed by {@link ManifestSourceEntry.source}. */
  sources: Record<string, ManifestSourceEntry>;
}

/** Parsed remote Git source specification for `--from`. */
export interface ParsedGitSource {
  /** Normalized Git clone URL (without fragment). */
  url: string;
  /** Optional branch or tag ref after `#`. */
  ref?: string;
  /** Canonical specifier stored in `.skanvil-sync.json`. */
  canonical: string;
}

/** Options of {@link resolveSourceHandle}. */
export interface ResolveSourceHandleOptions {
  /** Exact commit SHA to check out when resolving a Git source reproducibly (e.g. `--frozen`). */
  pinnedSha?: string;
}

/** Resolved `--from` source with temporary clone cleanup lifecycle. */
export interface ResolvedSourceHandle {
  /** Absolute library root path on disk. */
  root: string;
  /** Canonical identifier to record in the sync manifest (for example `github:org/repo`). */
  sourceLabel?: string;
  /** Exact Git commit SHA at `HEAD` when the source is a Git repository. */
  commitSha?: string;
  /** Requested branch or tag ref when supplied on a Git `--from` specifier. */
  gitRef?: string;
  /** Whether `root` points to a temporary clone cleaned up after syncing. */
  isTemporary: boolean;
  /** Removes any temporary clone directory (`no-op` for persistent sources). */
  cleanup: () => Promise<void>;
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
  /** Fail without writing if any synced skill would be added, updated, or removed, or lacks a manifest entry. */
  frozen?: boolean;
  /** Sync skills even when they have validation errors. @defaultValue `false` */
  force?: boolean;
  /** Only sync these categories (ids or aliases). Disables pruning. */
  categories?: string[];
  /** Only sync these skill folders. Disables pruning. */
  skills?: string[];
  /** Only sync skills with these `metadata.status` values. Disables pruning. */
  statuses?: string[];
  /** Include skills with `metadata.status: "deprecated"`. @defaultValue `false` */
  includeDeprecated?: boolean;
  /** Install into the project (`dest`) or the user's home folder. @defaultValue `"project"` */
  scope?: TargetScope;
  /** Home folder for the `user` scope. @defaultValue `os.homedir()` */
  homeDir?: string;
  /**
   * Override the source key written into `.skanvil-sync.json` (used for canonical Git URLs so
   * ephemeral clone directories are never stored in the manifest).
   */
  sourceLabel?: string;
  /** Resolved Git commit SHA stored on {@link ManifestSourceEntry.commitSha}. */
  commitSha?: string;
  /** Requested Git branch or tag ref stored on {@link ManifestSourceEntry.ref}. */
  gitRef?: string;
  /**
   * When set and `mode` is `"link"`, falls back to `"copy"` and emits this message as a warning.
   */
  forbidLinkReason?: string;
  /**
   * Values for parametrized skills (`params.json`), applied to every skill that declares them.
   * When omitted, each target reuses the values of its previous sync, then the defaults.
   * Every key must be declared by at least one synced skill.
   */
  params?: Record<string, string | boolean>;
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
  /** Parameter values used for this target (empty when no synced skill has parameters). */
  params: Record<string, string | boolean>;
  /** Estimated Stage-1 always-loaded tokens (`name` + `description`) for the resulting target set. */
  alwaysLoadedTokens: number;
}

/** Options of {@link checkOutdatedSkills}. */
export interface OutdatedOptions {
  /** Preset names or relative target paths. When omitted, scans every preset containing `.skanvil-sync.json`. */
  targets?: string[];
  /** Project or user scope. @defaultValue `"project"` */
  scope?: TargetScope;
  /** Home directory override for `"user"` scope. @defaultValue `os.homedir()` */
  homeDir?: string;
  /** Only check one matching manifest source key or substring. */
  sourceFilter?: string;
}

/** Drift status for a single `(target, source)` entry inside {@link OutdatedReport}. */
export interface OutdatedSourceEntry {
  target: string;
  targetPath: string;
  source: string;
  status: "up-to-date" | "outdated" | "error";
  installedCommitSha?: string;
  latestCommitSha?: string;
  added: string[];
  updated: string[];
  removed: string[];
  unchangedCount: number;
  installedAlwaysLoadedTokens: number;
  latestAlwaysLoadedTokens: number;
  stage1TokenDelta: number;
  error?: string;
}

/** Aggregated result returned by {@link checkOutdatedSkills}. */
export interface OutdatedReport {
  dest: string;
  scope: TargetScope;
  entries: OutdatedSourceEntry[];
  outdatedCount: number;
  errorCount: number;
}

/**
 * Resolves a sync target to an absolute folder.
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

function emptyManifest(): ManifestV2 {
  return { tool: "skanvil", manifestVersion: 2, version: "", sources: {} };
}

async function readManifest(dir: string): Promise<ManifestV2 | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8")) as Record<string, unknown>;
    if (!parsed || parsed.tool !== "skanvil") return null;

    if (
      parsed.manifestVersion === 2 &&
      parsed.sources &&
      typeof parsed.sources === "object" &&
      !Array.isArray(parsed.sources)
    ) {
      return parsed as unknown as ManifestV2;
    }

    if (parsed.skills && typeof parsed.skills === "object" && !Array.isArray(parsed.skills)) {
      const key = typeof parsed.source === "string" && parsed.source ? parsed.source : ".";
      return {
        tool: "skanvil",
        manifestVersion: 2,
        version: typeof parsed.version === "string" ? parsed.version : "",
        sources: {
          [key]: {
            source: key,
            skills: parsed.skills as Record<string, InstalledSkillEntry>,
            ...(parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
              ? { params: parsed.params as Record<string, string | boolean> }
              : {})
          }
        }
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function readGitHeadSha(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const sha = stdout.trim();
    return GIT_SHA_PATTERN.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Looks up a previously pinned Git commit SHA in target `.skanvil-sync.json` manifests for
 * reproducible `--frozen` syncs.
 *
 * @param dest - Project root.
 * @param targets - Target presets or relative paths.
 * @param sourceLabel - Canonical Git source key (`github:owner/repo[#ref]`, etc.).
 * @param scope - Project or user scope.
 * @param homeDir - Optional home directory override for `"user"` scope.
 * @returns Recorded commit SHA when present.
 */
export async function readManifestPinnedSha(
  dest: string,
  targets: readonly string[],
  sourceLabel: string,
  scope: TargetScope = "project",
  homeDir?: string
): Promise<string | undefined> {
  for (const target of targets) {
    const dir = resolveTarget(dest, target, { scope, homeDir });
    const manifest = await readManifest(dir);
    const sha = manifest?.sources[sourceLabel]?.commitSha;
    if (sha && GIT_SHA_PATTERN.test(sha)) return sha;
  }
  return undefined;
}

/**
 * Parses a Git `--from` specifier (`github:owner/repo[#ref]`, `git+https://...`,
 * `https://...git`, or `git@host:owner/repo`). Returns `null` for non-Git specs.
 *
 * @param spec - Source specifier passed to `--from`.
 * @returns Parsed URL, optional ref, and canonical label, or `null` for folder/npm sources.
 * @throws Error when a `#ref` fragment begins with `-` or contains whitespace.
 */
export function parseGitSource(spec: string): ParsedGitSource | null {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;

  let url = "";
  let ref: string | undefined;
  let canonical = trimmed;

  const ghMatch = trimmed.match(/^github:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:#([^\s]+))?$/);
  if (ghMatch) {
    url = `https://github.com/${ghMatch[1]}/${ghMatch[2]}.git`;
    ref = ghMatch[3];
    canonical = ref ? `github:${ghMatch[1]}/${ghMatch[2]}#${ref}` : `github:${ghMatch[1]}/${ghMatch[2]}`;
  } else if (/^git\+(?:https?|ssh|file):\/\/\S+$/i.test(trimmed)) {
    const body = trimmed.slice(4);
    const hashIdx = body.indexOf("#");
    url = hashIdx === -1 ? body : body.slice(0, hashIdx);
    ref = hashIdx === -1 ? undefined : body.slice(hashIdx + 1) || undefined;
  } else if (/^https?:\/\/\S+?\.git(?:#[^\s]+)?$/i.test(trimmed)) {
    const hashIdx = trimmed.indexOf("#");
    url = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
    ref = hashIdx === -1 ? undefined : trimmed.slice(hashIdx + 1) || undefined;
  } else if (/^git@[A-Za-z0-9._-]+:[^\s#]+(?:#[^\s]+)?$/.test(trimmed)) {
    const hashIdx = trimmed.indexOf("#");
    url = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
    ref = hashIdx === -1 ? undefined : trimmed.slice(hashIdx + 1) || undefined;
  } else {
    return null;
  }

  if (ref && (ref.startsWith("-") || /\s/.test(ref))) {
    throw new Error(`Invalid Git ref '${ref}' in source '${spec}'.`);
  }
  return { url, ...(ref ? { ref } : {}), canonical };
}

/**
 * Resolves the `--from` option to a library root folder (local directory or installed npm package).
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
 * Resolves a `--from` source (local folder, installed npm package, or remote/file Git URL)
 * into a {@link ResolvedSourceHandle} with lifecycle cleanup and commit SHA resolution.
 *
 * @param from - Local folder path, npm package name, or Git URL (`github:org/repo[#ref]`, `git+https://...`).
 * @param dest - Project root used to resolve relative paths and `node_modules`.
 * @param options - Optional `pinnedSha` for reproducible commit checkout.
 * @returns Source handle holding `root`, optional `sourceLabel`, `commitSha`, `gitRef`, and `cleanup()`.
 * @throws Error when cloning fails, the Git ref/SHA is invalid, or no local/npm source matches.
 */
export async function resolveSourceHandle(
  from: string,
  dest: string,
  options: ResolveSourceHandleOptions = {}
): Promise<ResolvedSourceHandle> {
  const git = parseGitSource(from);
  if (!git) {
    const root = await resolveSource(from, dest);
    const commitSha = await readGitHeadSha(root);
    return {
      root,
      ...(commitSha ? { commitSha } : {}),
      isTemporary: false,
      cleanup: async () => {}
    };
  }

  if (options.pinnedSha && !GIT_SHA_PATTERN.test(options.pinnedSha)) {
    throw new Error(`Invalid pinned Git commit SHA '${options.pinnedSha}'.`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skanvil-git-"));
  try {
    if (options.pinnedSha) {
      await execFileAsync("git", ["clone", "--no-checkout", "--", git.url, tmpDir]);
      await execFileAsync("git", ["checkout", "--detach", options.pinnedSha], { cwd: tmpDir });
    } else {
      const args = ["clone", "--depth", "1", ...(git.ref ? ["--branch", git.ref] : []), "--", git.url, tmpDir];
      await execFileAsync("git", args);
    }
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    const detail = (error as Error & { stderr?: string }).stderr?.trim() || (error as Error).message;
    throw new Error(`Failed to clone Git source '${from}': ${detail}`);
  }

  const commitSha = await readGitHeadSha(tmpDir);
  return {
    root: tmpDir,
    sourceLabel: git.canonical,
    ...(commitSha ? { commitSha } : {}),
    ...(git.ref ? { gitRef: git.ref } : {}),
    isTemporary: true,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/**
 * Replaces `target` with a copy of `source`, or a link to it.
 */
async function place(
  source: string,
  target: string,
  mode: "copy" | "link",
  warnings: string[],
  rendered: string | null
): Promise<"copy" | "link"> {
  await fs.rm(target, { recursive: true, force: true });
  if (mode === "link" && rendered !== null) {
    warnings.push(`${path.basename(target)} has parameters, so it was copied rendered instead of linked`);
  } else if (mode === "link") {
    try {
      await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
      return "link";
    } catch (error) {
      warnings.push(`could not link ${path.basename(target)} (${(error as Error).message}); copied instead`);
    }
  }
  await fs.cp(source, target, { recursive: true });
  await fs.rm(path.join(target, EVALS_FILE), { force: true });
  if (rendered !== null) {
    await fs.writeFile(path.join(target, "SKILL.md"), rendered, "utf8");
    await fs.rm(path.join(target, PARAMS_FILE), { force: true });
  }
  return "copy";
}

interface Materialized {
  hash: string;
  rendered: string | null;
  stage1Tokens: number;
}

function stage1TokensFromContent(name: string, content: string): number {
  const parsed = SkillFile.parse(content);
  const effectiveName = parsed.getString("name") || name;
  const description = parsed.getString("description");
  return estimateTokens(description ? `${effectiveName}\n${description}` : effectiveName);
}

async function materialize(
  library: Library,
  name: string,
  definitions: ParamDefinitions | null,
  values: Record<string, string | boolean>
): Promise<Materialized> {
  const dir = library.skillPath(name);
  const raw = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
  if (!definitions) {
    return {
      hash: await hashDirectory(dir, EXCLUDED_SYNC_FILES),
      rendered: null,
      stage1Tokens: stage1TokensFromContent(name, raw)
    };
  }

  const rendered = renderTemplate(raw, resolveParamValues(definitions, values, name, true));
  const hash = createHash("sha256");
  for (const file of await listFiles(dir)) {
    if (EXCLUDED_SYNC_FILES.has(file)) continue;
    hash.update(file);
    hash.update("\0");
    hash.update(file === "SKILL.md" ? Buffer.from(rendered, "utf8") : await fs.readFile(path.join(dir, file)));
    hash.update("\0");
  }
  return {
    hash: hash.digest("hex").slice(0, 16),
    rendered,
    stage1Tokens: stage1TokensFromContent(name, rendered)
  };
}

async function readStage1TokensFromTargetOrLibrary(
  library: Library | null,
  targetDir: string,
  name: string
): Promise<number> {
  const candidates = [path.join(targetDir, name, "SKILL.md")];
  if (library) candidates.push(library.skillFilePath(name));
  for (const file of candidates) {
    try {
      return stage1TokensFromContent(name, await fs.readFile(file, "utf8"));
    } catch {
      // Try next location.
    }
  }
  return 0;
}

/**
 * Installs a library's publishable skills into the agent skill folders of a project.
 *
 * Which skills are synced:
 * - only categories with `validated: true`, so `_internal` skills are never published;
 * - skills with validation errors are skipped unless `force` is set;
 * - a target folder that already exists without manifest ownership, or belongs to another synced
 *   library in {@link MANIFEST_FILE}, is skipped and never overwritten.
 *
 * When `frozen: true`, the full plan is checked against `.skanvil-sync.json` first and throws without
 * modifying any files if any target would add, update, or remove skills (or lacks a manifest entry).
 *
 * @param library - Source library.
 * @param options - Destination, targets, filters, and optional `frozen` / `commitSha` lock options.
 * @returns One result per target, in the order given.
 * @throws Error when a category filter is unknown, the library README cannot be read, or `frozen` detects drift.
 */
export async function syncSkills(library: Library, options: SyncOptions): Promise<TargetResult[]> {
  const requestedMode = options.mode ?? library.config.sync.mode;
  const linkForcedToCopy = Boolean(options.forbidLinkReason && requestedMode === "link");
  const mode = linkForcedToCopy ? "copy" : requestedMode;
  const statusFilter = options.statuses?.length
    ? options.statuses.map((value) => {
        const normalized = value.trim().toLowerCase();
        if (!(SKILL_STATUSES as readonly string[]).includes(normalized)) {
          throw new Error(`Invalid status '${value}'. Allowed values: ${SKILL_STATUSES.join(", ")}.`);
        }
        return normalized;
      })
    : null;
  const filtered = Boolean(options.categories?.length || options.skills?.length || statusFilter?.length);
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
  const failingSkipped = new Set<string>();
  const candidates: string[] = [];
  for (const folder of await library.listSkillFolders()) {
    const category = library.categories.fromFolder(folder);
    if (!category.validated) continue;
    if (categoryFilter && !categoryFilter.includes(category.id)) continue;
    if (options.skills?.length && !options.skills.includes(folder)) continue;
    if (!(await library.hasSkill(folder))) continue;

    let status = "";
    let replacedBy = "";
    try {
      const skill = await library.readSkillRendered(folder).catch(() => library.readSkill(folder));
      status = skill.getString("metadata", "status");
      replacedBy = skill.getString("metadata", "replaced-by");
    } catch {
      // Malformed SKILL.md is caught below if failing validation.
    }

    if (statusFilter && !statusFilter.includes(status)) continue;
    if (!statusFilter && status === "deprecated" && !options.includeDeprecated) {
      skipped.push({
        skill: folder,
        reason: replacedBy
          ? `deprecated (replaced by ${replacedBy}; use --include-deprecated)`
          : "deprecated (use --include-deprecated)"
      });
      continue;
    }
    if (failing.has(folder) && !options.force) {
      failingSkipped.add(folder);
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

  const definitions = new Map<string, ParamDefinitions | null>();
  for (const name of candidates) definitions.set(name, await library.readSkillParams(name));
  const declared = new Set([...definitions.values()].flatMap((defs) => Object.keys(defs ?? {})));
  if (options.params) {
    const unknown = Object.keys(options.params).filter((key) => !declared.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown parameter(s) ${unknown.join(", ")}: no synced skill declares them` +
          (declared.size ? ` (declared: ${[...declared].join(", ")})` : " (no synced skill has parameters)")
      );
    }
  }

  // Compute full diff plans across all targets before writing anything to disk.
  const cache = new Map<string, Materialized>();
  const planned = [];

  for (const target of options.targets) {
    const dir = resolveTarget(options.dest, target, { scope: options.scope, homeDir: options.homeDir });
    const sourceKey = options.sourceLabel ?? (path.relative(dir, library.root).split(path.sep).join("/") || ".");
    const manifest = (await readManifest(dir)) ?? emptyManifest();
    const hasOwnEntry = Object.prototype.hasOwnProperty.call(manifest.sources, sourceKey);
    const ownPrev = manifest.sources[sourceKey] ?? { source: sourceKey, skills: {} };
    const remembered = Object.fromEntries(Object.entries(ownPrev.params ?? {}).filter(([key]) => declared.has(key)));
    const values = options.params ?? remembered;
    const items = new Map<string, Materialized>();
    for (const name of candidates) {
      const key = `${name} ${JSON.stringify(values)}`;
      if (!cache.has(key)) cache.set(key, await materialize(library, name, definitions.get(name) ?? null, values));
      items.set(name, cache.get(key)!);
    }

    const foreignOwners = new Map<string, string>();
    for (const [otherKey, otherEntry] of Object.entries(manifest.sources)) {
      if (otherKey === sourceKey) continue;
      for (const skillName of Object.keys(otherEntry.skills)) {
        foreignOwners.set(skillName, otherKey);
      }
    }

    const result: TargetResult = {
      target,
      path: dir,
      added: [],
      updated: [],
      unchanged: [],
      removed: [],
      skipped: [...skipped],
      warnings: linkForcedToCopy && options.forbidLinkReason ? [options.forbidLinkReason] : [],
      params: declared.size ? values : {},
      alwaysLoadedTokens: 0
    };

    const actions: Array<{ name: string; kind: "write" | "keep" | "skip"; hash?: string; rendered?: string | null }> =
      [];
    for (const name of candidates) {
      const foreignOwner = foreignOwners.get(name);
      if (foreignOwner) {
        result.skipped.push({ skill: name, reason: `already managed by another library ('${foreignOwner}')` });
        actions.push({ name, kind: "skip" });
        continue;
      }

      const destination = path.join(dir, name);
      const previous = ownPrev.skills[name];
      const present = await exists(destination);
      const { hash, rendered } = items.get(name)!;

      if (present && !previous) {
        result.skipped.push({ skill: name, reason: `${destination} exists and is not managed by skanvil` });
        actions.push({ name, kind: "skip" });
        continue;
      }
      if (present && previous && previous.hash === hash && previous.mode === mode) {
        result.unchanged.push(name);
        actions.push({ name, kind: "keep" });
        continue;
      }
      (present ? result.updated : result.added).push(name);
      actions.push({ name, kind: "write", hash, rendered });
    }

    const removals: string[] = [];
    if (!filtered) {
      for (const name of Object.keys(ownPrev.skills)) {
        if (candidates.includes(name)) continue;
        if (failingSkipped.has(name)) continue;
        result.removed.push(name);
        removals.push(name);
      }
    }

    if (options.frozen) {
      if (!hasOwnEntry) {
        throw new Error(
          `Frozen sync failed: target '${target}' has no manifest entry for source '${sourceKey}' in ${MANIFEST_FILE}.`
        );
      }
      if (result.added.length > 0 || result.updated.length > 0 || result.removed.length > 0) {
        throw new Error(
          `Frozen sync failed for '${target}': pending changes (+${result.added.length} added, ~${result.updated.length} updated, -${result.removed.length} removed). Remove --frozen to apply updates.`
        );
      }
    }

    planned.push({ target, dir, sourceKey, manifest, ownPrev, values, items, result, actions, removals });
  }

  const results: TargetResult[] = [];
  for (const plan of planned) {
    const { dir, sourceKey, manifest, ownPrev, values, items, result, actions, removals } = plan;
    const nextOwnSkills: Record<string, InstalledSkillEntry> = filtered ? { ...ownPrev.skills } : {};

    if (!options.dryRun) await fs.mkdir(dir, { recursive: true });

    for (const action of actions) {
      if (action.kind === "keep") {
        nextOwnSkills[action.name] = ownPrev.skills[action.name];
      } else if (action.kind === "write") {
        const destination = path.join(dir, action.name);
        const actualMode = options.dryRun
          ? mode
          : await place(library.skillPath(action.name), destination, mode, result.warnings, action.rendered ?? null);
        nextOwnSkills[action.name] = { hash: action.hash!, mode: actualMode };
      }
    }

    if (!filtered) {
      for (const name of Object.keys(ownPrev.skills)) {
        if (candidates.includes(name)) continue;
        if (failingSkipped.has(name)) {
          nextOwnSkills[name] = ownPrev.skills[name];
        }
      }
      for (const name of removals) {
        if (!options.dryRun) await fs.rm(path.join(dir, name), { recursive: true, force: true });
      }
    }

    const nextSources: Record<string, ManifestSourceEntry> = { ...manifest.sources };
    if (Object.keys(nextOwnSkills).length > 0) {
      const effectiveSha = options.commitSha ?? ownPrev.commitSha;
      const effectiveRef = options.gitRef ?? ownPrev.ref;
      nextSources[sourceKey] = {
        source: sourceKey,
        ...(effectiveSha ? { commitSha: effectiveSha } : {}),
        ...(effectiveRef ? { ref: effectiveRef } : {}),
        skills: nextOwnSkills,
        ...(declared.size && Object.keys(values).length ? { params: values } : {})
      };
    } else {
      delete nextSources[sourceKey];
    }

    const next: ManifestV2 = {
      tool: "skanvil",
      manifestVersion: 2,
      version: packageVersion(),
      sources: nextSources
    };

    let alwaysLoadedTokens = 0;
    for (const [entryKey, entry] of Object.entries(nextSources)) {
      for (const name of Object.keys(entry.skills)) {
        const item = entryKey === sourceKey ? items.get(name) : undefined;
        alwaysLoadedTokens += item
          ? item.stage1Tokens
          : await readStage1TokensFromTargetOrLibrary(entryKey === sourceKey ? library : null, dir, name);
      }
    }
    result.alwaysLoadedTokens = alwaysLoadedTokens;

    if (!options.dryRun) {
      await fs.writeFile(path.join(dir, MANIFEST_FILE), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    }
    results.push(result);
  }
  return results;
}

/**
 * Inspects installed `.skanvil-sync.json` manifests across one or more target directories and
 * compares installed skill hashes and pinned Git commit SHAs against their upstream sources.
 *
 * @param dest - Project root (ignored for `"user"` scope).
 * @param options - Optional target filter, scope, home folder, and source filter.
 * @returns Drift report per `(target, source)` entry.
 */
export async function checkOutdatedSkills(dest: string, options: OutdatedOptions = {}): Promise<OutdatedReport> {
  const scope: TargetScope = options.scope ?? "project";
  const presets = scope === "user" ? USER_TARGET_PRESETS : TARGET_PRESETS;
  const candidateTargets = options.targets?.length ? options.targets : Object.keys(presets);
  const seenDirs = new Set<string>();
  const entries: OutdatedSourceEntry[] = [];

  for (const target of candidateTargets) {
    const targetDir = resolveTarget(dest, target, { scope, homeDir: options.homeDir });
    if (seenDirs.has(targetDir)) continue;
    seenDirs.add(targetDir);

    const manifest = await readManifest(targetDir);
    if (!manifest) continue;

    let installedAlwaysLoadedTokens = 0;
    for (const srcEntry of Object.values(manifest.sources)) {
      for (const skillName of Object.keys(srcEntry.skills)) {
        installedAlwaysLoadedTokens += await readStage1TokensFromTargetOrLibrary(null, targetDir, skillName);
      }
    }

    for (const [sourceKey, entry] of Object.entries(manifest.sources)) {
      if (options.sourceFilter && !sourceKey.includes(options.sourceFilter)) continue;

      let handle: ResolvedSourceHandle | null = null;
      try {
        const isGit = Boolean(parseGitSource(sourceKey));
        if (isGit) {
          handle = await resolveSourceHandle(sourceKey, dest);
        } else {
          const relativeToTarget = path.resolve(targetDir, sourceKey);
          if (await exists(path.join(relativeToTarget, "skills"))) {
            const sha = await readGitHeadSha(relativeToTarget);
            handle = {
              root: relativeToTarget,
              ...(sha ? { commitSha: sha } : {}),
              isTemporary: false,
              cleanup: async () => {}
            };
          } else {
            handle = await resolveSourceHandle(sourceKey, dest);
          }
        }

        const lib = await Library.open(handle.root);
        const [dryResult] = await syncSkills(lib, {
          dest,
          targets: [target],
          scope,
          homeDir: options.homeDir,
          dryRun: true,
          sourceLabel: sourceKey,
          forbidLinkReason: handle.isTemporary ? "temporary Git source" : undefined,
          params: entry.params
        });

        const hasChanges =
          dryResult.added.length > 0 ||
          dryResult.updated.length > 0 ||
          dryResult.removed.length > 0 ||
          Boolean(entry.commitSha && handle.commitSha && entry.commitSha !== handle.commitSha);

        entries.push({
          target,
          targetPath: targetDir,
          source: sourceKey,
          status: hasChanges ? "outdated" : "up-to-date",
          ...(entry.commitSha ? { installedCommitSha: entry.commitSha } : {}),
          ...(handle.commitSha ? { latestCommitSha: handle.commitSha } : {}),
          added: dryResult.added,
          updated: dryResult.updated,
          removed: dryResult.removed,
          unchangedCount: dryResult.unchanged.length,
          installedAlwaysLoadedTokens,
          latestAlwaysLoadedTokens: dryResult.alwaysLoadedTokens,
          stage1TokenDelta: dryResult.alwaysLoadedTokens - installedAlwaysLoadedTokens
        });
      } catch (error) {
        entries.push({
          target,
          targetPath: targetDir,
          source: sourceKey,
          status: "error",
          ...(entry.commitSha ? { installedCommitSha: entry.commitSha } : {}),
          added: [],
          updated: [],
          removed: [],
          unchangedCount: 0,
          installedAlwaysLoadedTokens,
          latestAlwaysLoadedTokens: installedAlwaysLoadedTokens,
          stage1TokenDelta: 0,
          error: (error as Error).message
        });
      } finally {
        if (handle) await handle.cleanup();
      }
    }
  }

  return {
    dest: path.resolve(dest),
    scope,
    entries,
    outdatedCount: entries.filter((item) => item.status === "outdated").length,
    errorCount: entries.filter((item) => item.status === "error").length
  };
}
