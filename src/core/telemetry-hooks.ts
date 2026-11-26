/**
 * Agent hook parsing and idempotent hook configuration installer (`claude`, `cursor`, `gemini`).
 *
 * Parses `PostToolUse` / `afterFileRead` / `AfterTool` JSON payloads on stdin to detect when an
 * agent reads or activates a synced skill, resolves owning library metadata from `.skanvil-sync.json`,
 * and merges hook entries safely into agent configuration files without clobbering existing rules.
 *
 * @module
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SkillFile } from "./skill.js";
import { MANIFEST_FILE, type TargetScope } from "./sync.js";
import { estimateTokens } from "./text.js";

/** Coding agents supported by `skanvil telemetry install-hooks` and `skanvil telemetry hook`. */
export const HOOK_AGENTS = ["claude", "cursor", "gemini"] as const;

/** Agent identifier supported by telemetry hooks. */
export type HookInstallTarget = (typeof HOOK_AGENTS)[number];

/** Parsed signal extracted from an agent hook stdin payload. */
export interface ParsedHookSignal {
  /** Agent that triggered the hook (`claude`, `cursor`, or `gemini`). */
  agent: HookInstallTarget;
  /** Detected skill folder name. */
  skill: string;
  /** Owning library name inferred from `.skanvil-sync.json`, or `"local"`. */
  library: string;
  /** Model identifier when reported by the agent payload. */
  model?: string;
  /** Session or conversation ID when reported by the agent payload. */
  sessionId?: string;
  /** Workspace directory path for privacy-safe hashing. */
  projectPath?: string;
  /** Inferred outcome (`"error"` when tool response reports error, else `"success"`). */
  outcome: "success" | "error";
  /** Estimated Stage-1 tokens (`name` + `description`) if the target `SKILL.md` is readable on disk. */
  stage1Tokens?: number;
}

/** Options of {@link installTelemetryHooks}. */
export interface InstallHooksOptions {
  /** Target agents (`claude`, `cursor`, `gemini`). */
  targets: readonly string[];
  /** Project root (ignored when `scope === "user"`). @defaultValue `process.cwd()` */
  dest?: string;
  /** Install in project config or user home config. @defaultValue `"project"` */
  scope?: TargetScope;
  /** Override home directory for `"user"` scope. @defaultValue `os.homedir()` */
  homeDir?: string;
  /** Preview changes without modifying config files. @defaultValue `false` */
  dryRun?: boolean;
}

/** Per-target result returned inside {@link InstallHooksResult}. */
export interface HookInstallItem {
  /** Target agent name. */
  agent: HookInstallTarget;
  /** Absolute path to the agent configuration file. */
  file: string;
  /** Result status for this target. */
  status: "installed" | "already-configured";
}

/** Outcome of {@link installTelemetryHooks}. */
export interface InstallHooksResult {
  dryRun: boolean;
  scope: TargetScope;
  results: HookInstallItem[];
}

const HOOK_COMMANDS: Record<HookInstallTarget, string> = {
  claude: "npx --no-install skanvil telemetry hook --agent claude",
  cursor: "npx --no-install skanvil telemetry hook --agent cursor",
  gemini: "npx --no-install skanvil telemetry hook --agent gemini"
};

const SKILL_FILE_PATH_PATTERN = /(?:^|\/)([^/]+)\/SKILL\.md$/i;
const VALID_SKILL_NAME_PATTERN = /^[a-z0-9_][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLibraryLabel(rawSource: string): string {
  const cleaned = rawSource.trim();
  if (!cleaned) return "local";
  if (
    cleaned.startsWith("github:") ||
    cleaned.startsWith("git+") ||
    cleaned.includes("://") ||
    cleaned.startsWith("git@")
  ) {
    return cleaned.split("#")[0];
  }
  const base = path.posix.basename(cleaned.replace(/\\/g, "/"));
  return base && base !== "." && base !== ".." ? base : "local";
}

async function resolveLibraryFromManifestDir(skillsDir: string, skillName: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(skillsDir, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isRecord(parsed) || parsed.tool !== "skanvil") return null;

    if (parsed.manifestVersion === 2 && isRecord(parsed.sources)) {
      for (const [key, entry] of Object.entries(parsed.sources)) {
        if (
          isRecord(entry) &&
          isRecord(entry.skills) &&
          Object.prototype.hasOwnProperty.call(entry.skills, skillName)
        ) {
          const sourceStr = typeof entry.source === "string" ? entry.source : key;
          return normalizeLibraryLabel(sourceStr);
        }
      }
    }
    if (isRecord(parsed.skills) && Object.prototype.hasOwnProperty.call(parsed.skills, skillName)) {
      return typeof parsed.source === "string" ? normalizeLibraryLabel(parsed.source) : "local";
    }
  } catch {
    // Missing or unreadable manifest falls back to local.
  }
  return null;
}

async function readStage1Tokens(filePath: string, fallbackName: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = SkillFile.parse(raw);
    const name = parsed.getString("name") || fallbackName;
    const description = parsed.getString("description");
    return estimateTokens(description ? `${name}\n${description}` : name);
  } catch {
    return undefined;
  }
}

function asHookAgent(value: string): HookInstallTarget {
  const normalized = value.trim().toLowerCase() as HookInstallTarget;
  if (!(HOOK_AGENTS as readonly string[]).includes(normalized)) {
    throw new Error(`Unsupported hook agent '${value}'. Allowed values: ${HOOK_AGENTS.join(", ")}.`);
  }
  return normalized;
}

/**
 * Parses a JSON hook stdin payload from `claude`, `cursor`, or `gemini` and extracts a skill
 * invocation signal if the tool read a skill's `SKILL.md` or activated a named skill.
 *
 * @param agent - Hook source (`claude`, `cursor`, or `gemini`).
 * @param rawStdin - Raw JSON payload received on stdin.
 * @param fallbackCwd - Fallback workspace directory if not included in the payload.
 * @returns Parsed invocation metadata, or `null` when the hook event does not relate to a skill.
 */
export async function parseAgentHookPayload(
  agent: HookInstallTarget | string,
  rawStdin: string,
  fallbackCwd?: string
): Promise<ParsedHookSignal | null> {
  const normalizedAgent = asHookAgent(agent);
  const trimmed = rawStdin.trim();
  if (!trimmed) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;

  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const toolResponse = isRecord(payload.tool_response) ? payload.tool_response : {};
  const workspaceRoots = Array.isArray(payload.workspace_roots)
    ? payload.workspace_roots.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  const projectPath =
    (typeof payload.cwd === "string" && payload.cwd.trim()) || workspaceRoots[0] || fallbackCwd?.trim() || undefined;

  const sessionId =
    (typeof payload.session_id === "string" && payload.session_id.trim()) ||
    (typeof payload.conversation_id === "string" && payload.conversation_id.trim()) ||
    undefined;

  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : undefined;
  const outcome: "success" | "error" = toolResponse.isError === true || toolResponse.error ? "error" : "success";

  const filePathCandidate =
    (typeof toolInput.file_path === "string" && toolInput.file_path) ||
    (typeof toolInput.path === "string" && toolInput.path) ||
    (typeof payload.file_path === "string" && payload.file_path) ||
    (typeof payload.path === "string" && payload.path) ||
    "";

  if (filePathCandidate) {
    const posixPath = filePathCandidate.replace(/\\/g, "/");
    // Require skills/ segment anywhere above `<skill>/SKILL.md` so project docs aren't miscounted.
    const hasSkillsSegment = /(?:^|\/)skills\/[^/]+\/SKILL\.md$/i.test(posixPath);
    const match = hasSkillsSegment ? posixPath.match(SKILL_FILE_PATH_PATTERN) : null;
    if (match) {
      const folderName = match[1];
      if (!VALID_SKILL_NAME_PATTERN.test(folderName)) return null;
      const skillsDir = path.dirname(path.dirname(filePathCandidate));
      const library = (await resolveLibraryFromManifestDir(skillsDir, folderName)) ?? "local";
      const stage1Tokens = await readStage1Tokens(filePathCandidate, folderName);
      return {
        agent: normalizedAgent,
        skill: folderName,
        library,
        ...(model ? { model } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(projectPath ? { projectPath } : {}),
        outcome,
        ...(stage1Tokens !== undefined ? { stage1Tokens } : {})
      };
    }
  }

  const directSkill =
    (typeof toolInput.skill === "string" && toolInput.skill.trim()) ||
    (typeof toolInput.name === "string" &&
      typeof payload.tool_name === "string" &&
      /skill/i.test(payload.tool_name) &&
      toolInput.name.trim()) ||
    "";

  if (directSkill && VALID_SKILL_NAME_PATTERN.test(directSkill)) {
    let library = "local";
    let stage1Tokens: number | undefined;
    if (projectPath) {
      for (const rel of [
        ".claude/skills",
        ".cursor/skills",
        ".gemini/skills",
        ".agents/skills",
        ".github/skills",
        "skills"
      ]) {
        const dir = path.join(projectPath, rel);
        const foundLib = await resolveLibraryFromManifestDir(dir, directSkill);
        if (foundLib) library = foundLib;
        const candidateFile = path.join(dir, directSkill, "SKILL.md");
        const tokens = await readStage1Tokens(candidateFile, directSkill);
        if (tokens !== undefined) {
          stage1Tokens = tokens;
          break;
        }
      }
    }
    return {
      agent: normalizedAgent,
      skill: directSkill,
      library,
      ...(model ? { model } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(projectPath ? { projectPath } : {}),
      outcome,
      ...(stage1Tokens !== undefined ? { stage1Tokens } : {})
    };
  }

  return null;
}

function resolveHookConfigPath(agent: HookInstallTarget, dest: string, scope: TargetScope, homeDir: string): string {
  const base = scope === "user" ? homeDir : path.resolve(dest);
  if (agent === "claude") return path.join(base, ".claude", "settings.json");
  if (agent === "cursor") return path.join(base, ".cursor", "hooks.json");
  return path.join(base, ".gemini", "settings.json");
}

function containsTelemetryHook(node: unknown): boolean {
  if (typeof node === "string") return node.includes("skanvil telemetry hook");
  if (Array.isArray(node)) return node.some(containsTelemetryHook);
  if (isRecord(node)) return Object.values(node).some(containsTelemetryHook);
  return false;
}

function mergeHookConfig(
  agent: HookInstallTarget,
  existing: Record<string, unknown>
): {
  updated: Record<string, unknown>;
  alreadyConfigured: boolean;
} {
  const command = HOOK_COMMANDS[agent];
  const hooksMap = isRecord(existing.hooks) ? { ...existing.hooks } : {};

  if (agent === "claude") {
    const list = Array.isArray(hooksMap.PostToolUse) ? [...hooksMap.PostToolUse] : [];
    if (containsTelemetryHook(list)) return { updated: existing, alreadyConfigured: true };
    list.push({
      matcher: "Read|Skill",
      hooks: [{ type: "command", command }]
    });
    hooksMap.PostToolUse = list;
    return { updated: { ...existing, hooks: hooksMap }, alreadyConfigured: false };
  }

  if (agent === "cursor") {
    const list = Array.isArray(hooksMap.afterFileRead) ? [...hooksMap.afterFileRead] : [];
    if (containsTelemetryHook(list)) return { updated: existing, alreadyConfigured: true };
    list.push({ command });
    hooksMap.afterFileRead = list;
    const version = typeof existing.version === "number" ? existing.version : 1;
    return { updated: { version, ...existing, hooks: hooksMap }, alreadyConfigured: false };
  }

  // Gemini CLI AfterTool configuration
  const list = Array.isArray(hooksMap.AfterTool) ? [...hooksMap.AfterTool] : [];
  if (containsTelemetryHook(list)) return { updated: existing, alreadyConfigured: true };
  list.push({
    matcher: "read_file|activate_skill",
    hooks: [{ name: "skanvil-telemetry", type: "command", command }]
  });
  hooksMap.AfterTool = list;
  return { updated: { ...existing, hooks: hooksMap }, alreadyConfigured: false };
}

/**
 * Installs idempotent, non-blocking telemetry hooks into `claude`, `cursor`, and/or `gemini`
 * agent configuration files while preserving all existing settings.
 *
 * @param options - Agents, destination folder, scope (`project` or `user`), and `dryRun`.
 * @returns Per-agent installation result.
 * @throws Error when an unsupported agent is given, no valid target is provided, or an existing
 *   configuration file contains malformed JSON.
 */
export async function installTelemetryHooks(options: InstallHooksOptions): Promise<InstallHooksResult> {
  const agents = [...new Set(options.targets.map(asHookAgent))];
  if (agents.length === 0) {
    throw new Error(`Select at least one hook target (${HOOK_AGENTS.join(", ")}).`);
  }

  const scope: TargetScope = options.scope ?? "project";
  const dest = path.resolve(options.dest ?? process.cwd());
  const homeDir = options.homeDir ?? os.homedir();
  const dryRun = Boolean(options.dryRun);

  // Plan and validate every existing JSON file before writing anything.
  const plans: { item: HookInstallItem; nextJson?: string }[] = [];
  for (const agent of agents) {
    const file = resolveHookConfigPath(agent, dest, scope, homeDir);
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        throw new Error(`Expected JSON object in ${file}.`);
      }
      existing = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Cannot read ${file}: ${(error as Error).message}`);
      }
    }

    const merged = mergeHookConfig(agent, existing);
    plans.push({
      item: {
        agent,
        file,
        status: merged.alreadyConfigured ? "already-configured" : "installed"
      },
      ...(merged.alreadyConfigured ? {} : { nextJson: `${JSON.stringify(merged.updated, null, 2)}\n` })
    });
  }

  if (!dryRun) {
    for (const plan of plans) {
      if (plan.nextJson === undefined) continue;
      await fs.mkdir(path.dirname(plan.item.file), { recursive: true });
      await fs.writeFile(plan.item.file, plan.nextJson, "utf8");
    }
  }

  return {
    dryRun,
    scope,
    results: plans.map((plan) => plan.item)
  };
}
