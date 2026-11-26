/**
 * Agent hook parsing, session timing/tool tracking, transcript ingestion, and idempotent hook
 * configuration installation (`claude`, `cursor`, `gemini`, `copilot`, `windsurf`, `codex`, `opencode`).
 *
 * Parses tool-use and session-end JSON payloads on stdin to measure skill activations, session
 * durations, and tool call counts, resolves owning library metadata from `.skanvil-sync.json`,
 * and merges hook entries safely into agent configuration files without clobbering existing rules.
 *
 * @module
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { packageVersion } from "../util/paths.js";
import { SkillFile } from "./skill.js";
import { MANIFEST_FILE, type TargetScope } from "./sync.js";
import { TELEMETRY_SCHEMA_VERSION, hashIdentifier, type SkillInvokedEvent } from "./telemetry.js";
import { estimateTokens } from "./text.js";

/** Coding agents supported by `skanvil telemetry install-hooks` and `skanvil telemetry hook`. */
export const HOOK_AGENTS = ["claude", "cursor", "gemini", "copilot", "windsurf", "codex", "opencode"] as const;

/** Agent identifier supported by telemetry hooks. */
export type HookInstallTarget = (typeof HOOK_AGENTS)[number];

/** Parsed signal extracted from an agent hook stdin payload. */
export interface ParsedHookSignal {
  /** Agent that triggered the hook. */
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
  /** Inferred outcome (`"error"` when any tool failure occurred, else `"success"`). */
  outcome: "success" | "error";
  /** Session or turn duration in milliseconds when tracked across start/end hooks. */
  durationMs?: number;
  /** Total tool calls observed during the tracked session. */
  toolCalls?: number;
  /** Failed tool calls observed during the tracked session. */
  failedToolCalls?: number;
  /** Estimated Stage-1 tokens (`name` + `description`) if the target `SKILL.md` is readable on disk. */
  stage1Tokens?: number;
}

/** Options of {@link installTelemetryHooks}. */
export interface InstallHooksOptions {
  /** Target agents (`claude`, `cursor`, `gemini`, `copilot`, `windsurf`, `codex`, `opencode`). */
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

/** Options of {@link parseTranscriptFile} and {@link ingestTranscriptsPath}. */
export interface TranscriptParseOptions {
  /** Agent label stored on extracted events. @defaultValue `"claude"` */
  agent?: string;
  /** Default library name when `.skanvil-sync.json` does not identify an owner. @defaultValue `"local"` */
  library?: string;
  /** Default project workspace path for hashed attribution. */
  projectPath?: string;
}

interface SessionState {
  skill: string;
  library: string;
  agent: HookInstallTarget;
  model?: string;
  sessionId: string;
  projectPath?: string;
  startedAt: number;
  toolCalls: number;
  failedToolCalls: number;
  stage1Tokens?: number;
}

const HOOK_COMMANDS: Record<HookInstallTarget, string> = {
  claude: "npx --no-install skanvil telemetry hook --agent claude",
  cursor: "npx --no-install skanvil telemetry hook --agent cursor",
  gemini: "npx --no-install skanvil telemetry hook --agent gemini",
  copilot: "npx --no-install skanvil telemetry hook --agent copilot",
  windsurf: "npx --no-install skanvil telemetry hook --agent windsurf",
  codex: "npx --no-install skanvil telemetry hook --agent codex",
  opencode: "npx --no-install skanvil telemetry hook --agent opencode"
};

const SKILL_FILE_PATH_PATTERN = /(?:^|\/)([^/]+)\/SKILL\.md$/i;
const VALID_SKILL_NAME_PATTERN = /^[a-z0-9_][a-z0-9-]*$/;
const SESSION_END_EVENTS = new Set(["stop", "subagentstop", "sessionend", "session_end", "post_cascade_response"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function defaultTelemetrySessionsDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".skanvil", "sessions");
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

function extractSessionId(payload: Record<string, unknown>): string | undefined {
  for (const key of ["session_id", "conversation_id", "sessionId", "cascade_id"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function extractProjectPath(payload: Record<string, unknown>, fallbackCwd?: string): string | undefined {
  const workspaceRoots = Array.isArray(payload.workspace_roots)
    ? payload.workspace_roots.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return (
    (typeof payload.cwd === "string" && payload.cwd.trim()) || workspaceRoots[0] || fallbackCwd?.trim() || undefined
  );
}

function isErrorToolPayload(payload: Record<string, unknown>): boolean {
  const toolResponse = isRecord(payload.tool_response) ? payload.tool_response : {};
  return toolResponse.isError === true || Boolean(toolResponse.error) || payload.is_error === true;
}

function isSessionEndPayload(payload: Record<string, unknown>): boolean {
  for (const key of ["hook_event_name", "event", "eventName", "hookEvent"]) {
    const raw = payload[key];
    if (
      typeof raw === "string" &&
      SESSION_END_EVENTS.has(
        raw
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, "")
      )
    ) {
      return true;
    }
    if (typeof raw === "string" && SESSION_END_EVENTS.has(raw.trim().toLowerCase())) {
      return true;
    }
  }
  return payload.stop_hook_active === true && !isRecord(payload.tool_input);
}

async function resolveSkillFromPayload(
  normalizedAgent: HookInstallTarget,
  payload: Record<string, unknown>,
  fallbackCwd?: string
): Promise<ParsedHookSignal | null> {
  const toolInput = isRecord(payload.tool_input)
    ? payload.tool_input
    : isRecord(payload.toolArgs)
      ? payload.toolArgs
      : {};
  const projectPath = extractProjectPath(payload, fallbackCwd);
  const sessionId = extractSessionId(payload);
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : undefined;
  const outcome: "success" | "error" = isErrorToolPayload(payload) ? "error" : "success";

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
        ".windsurf/skills",
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

/**
 * Parses a JSON hook stdin payload from a supported coding agent and extracts a skill invocation
 * signal if the tool read a skill's `SKILL.md` or activated a named skill.
 *
 * @param agent - Hook source (`claude`, `cursor`, `gemini`, `copilot`, `windsurf`, `codex`, `opencode`).
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
  return resolveSkillFromPayload(normalizedAgent, payload, fallbackCwd);
}

function sessionFilePath(sessionsDir: string, agent: HookInstallTarget, sessionId: string): string {
  const key = createHash("sha256").update(`${agent}\0${sessionId}`).digest("hex").slice(0, 24);
  return path.join(sessionsDir, `${key}.json`);
}

/**
 * Stateful hook processor used by `skanvil telemetry hook`:
 * - For stateless payloads (without `session_id`), emits a `ParsedHookSignal` immediately.
 * - For payloads with `session_id`, tracks skill activation, tool call counts, and failures until
 *   the matching `Stop` / `SessionEnd` hook fires, then returns the completed signal with `durationMs`.
 *
 * @param agent - Hook source agent identifier.
 * @param rawStdin - Raw JSON payload from stdin.
 * @param options - Optional fallback workspace, custom sessions folder, and timestamp override.
 * @returns Signal ready for telemetry emission, or `null` when buffered for session completion or unrelated.
 */
export async function processAgentHookPayload(
  agent: HookInstallTarget | string,
  rawStdin: string,
  options: { fallbackCwd?: string; sessionsDir?: string; now?: number } = {}
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

  const now = options.now ?? Date.now();
  const sessionsDir = options.sessionsDir ?? defaultTelemetrySessionsDir();
  const sessionId = extractSessionId(payload);

  if (isSessionEndPayload(payload) && sessionId) {
    const file = sessionFilePath(sessionsDir, normalizedAgent, sessionId);
    try {
      const state = JSON.parse(await fs.readFile(file, "utf8")) as SessionState;
      await fs.rm(file, { force: true }).catch(() => undefined);
      return {
        agent: state.agent,
        skill: state.skill,
        library: state.library,
        ...(state.model ? { model: state.model } : {}),
        sessionId: state.sessionId,
        ...(state.projectPath ? { projectPath: state.projectPath } : {}),
        outcome: state.failedToolCalls > 0 ? "error" : "success",
        durationMs: Math.max(0, now - state.startedAt),
        toolCalls: state.toolCalls,
        failedToolCalls: state.failedToolCalls,
        ...(state.stage1Tokens !== undefined ? { stage1Tokens: state.stage1Tokens } : {})
      };
    } catch {
      return null;
    }
  }

  const signal = await resolveSkillFromPayload(normalizedAgent, payload, options.fallbackCwd);
  if (!sessionId) {
    return signal;
  }

  const file = sessionFilePath(sessionsDir, normalizedAgent, sessionId);
  const failedIncrement = isErrorToolPayload(payload) ? 1 : 0;

  let existing: SessionState | null = null;
  try {
    existing = JSON.parse(await fs.readFile(file, "utf8")) as SessionState;
  } catch {
    existing = null;
  }

  if (signal) {
    const nextState: SessionState = {
      skill: existing?.skill ?? signal.skill,
      library: existing?.library ?? signal.library,
      agent: normalizedAgent,
      ...(signal.model || existing?.model ? { model: signal.model ?? existing?.model } : {}),
      sessionId,
      ...(signal.projectPath || existing?.projectPath
        ? { projectPath: signal.projectPath ?? existing?.projectPath }
        : {}),
      startedAt: existing?.startedAt ?? now,
      toolCalls: (existing?.toolCalls ?? 0) + 1,
      failedToolCalls: (existing?.failedToolCalls ?? 0) + failedIncrement,
      ...(signal.stage1Tokens !== undefined || existing?.stage1Tokens !== undefined
        ? { stage1Tokens: signal.stage1Tokens ?? existing?.stage1Tokens }
        : {})
    };
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(nextState), "utf8");
    return null;
  }

  if (existing) {
    existing.toolCalls += 1;
    existing.failedToolCalls += failedIncrement;
    await fs.writeFile(file, JSON.stringify(existing), "utf8");
  }

  return null;
}

/**
 * Extracts skill invocation telemetry events (with duration and tool call metrics) from a JSONL
 * coding-agent session transcript file.
 *
 * @param filePath - Path to a `.jsonl` transcript file.
 * @param options - Agent, default library, and project path overrides.
 * @returns Deduplicated `skill.invoked` telemetry events (`source: "transcript"`).
 */
export async function parseTranscriptFile(
  filePath: string,
  options: TranscriptParseOptions = {}
): Promise<SkillInvokedEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  const agent = options.agent?.trim().toLowerCase() || "claude";
  const defaultLibrary = options.library?.trim() || "local";

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = 0;
  let toolCalls = 0;
  let failedToolCalls = 0;
  let model: string | undefined;
  let sessionId = path.basename(filePath, path.extname(filePath));
  let projectPath = options.projectPath;
  const detectedSkills = new Map<string, { library: string; stage1Tokens?: number }>();

  const inspectToolUse = async (name: unknown, input: unknown) => {
    toolCalls += 1;
    if (!isRecord(input)) return;
    const synthPayload: Record<string, unknown> = {
      tool_name: typeof name === "string" ? name : "",
      tool_input: input,
      ...(projectPath ? { cwd: projectPath } : {})
    };
    const signal = await resolveSkillFromPayload(
      (HOOK_AGENTS as readonly string[]).includes(agent) ? (agent as HookInstallTarget) : "claude",
      synthPayload,
      projectPath
    );
    if (signal && !detectedSkills.has(signal.skill)) {
      detectedSkills.set(signal.skill, {
        library: signal.library !== "local" ? signal.library : defaultLibrary,
        stage1Tokens: signal.stage1Tokens
      });
    }
  };

  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    for (const key of ["timestamp", "created_at", "ts"]) {
      const val = entry[key];
      if (typeof val === "string" && !Number.isNaN(Date.parse(val))) {
        const ms = Date.parse(val);
        minTs = Math.min(minTs, ms);
        maxTs = Math.max(maxTs, ms);
      } else if (typeof val === "number" && Number.isFinite(val)) {
        minTs = Math.min(minTs, val);
        maxTs = Math.max(maxTs, val);
      }
    }

    if (typeof entry.sessionId === "string" && entry.sessionId.trim()) sessionId = entry.sessionId.trim();
    else if (typeof entry.session_id === "string" && entry.session_id.trim()) sessionId = entry.session_id.trim();

    if (!projectPath && typeof entry.cwd === "string" && entry.cwd.trim()) projectPath = entry.cwd.trim();
    if (!model && typeof entry.model === "string" && entry.model.trim()) model = entry.model.trim();

    if (typeof entry.tool_name === "string" || isRecord(entry.tool_input)) {
      await inspectToolUse(entry.tool_name, entry.tool_input);
    }
    if (isErrorToolPayload(entry)) failedToolCalls += 1;

    const msg = isRecord(entry.message) ? entry.message : isRecord(entry.content) ? entry : null;
    if (msg) {
      if (!model && typeof msg.model === "string" && msg.model.trim()) model = msg.model.trim();
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_use") {
          await inspectToolUse(block.name, block.input);
        } else if (block.type === "tool_result" && block.is_error === true) {
          failedToolCalls += 1;
        }
      }
    }
  }

  if (detectedSkills.size === 0) return [];
  const durationMs = Number.isFinite(minTs) && maxTs >= minTs ? maxTs - minTs : undefined;
  const timestamp = maxTs > 0 ? new Date(maxTs).toISOString() : new Date().toISOString();
  const projectHash = projectPath ? hashIdentifier(path.resolve(projectPath)) : undefined;
  const sessionHash = hashIdentifier(`${agent}:${sessionId}`);
  const outcome: "success" | "error" = failedToolCalls > 0 ? "error" : "success";
  const version = packageVersion();

  const events: SkillInvokedEvent[] = [];
  for (const [skill, meta] of detectedSkills.entries()) {
    const eventIdHash = createHash("sha256").update(`${filePath}\0${sessionId}\0${skill}`).digest("hex").slice(0, 24);
    events.push({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: `tr_${eventIdHash}`,
      timestamp,
      type: "skill.invoked",
      library: meta.library,
      skanvilVersion: version,
      skill,
      agent,
      ...(model ? { model } : {}),
      ...(projectHash ? { projectHash } : {}),
      sessionHash,
      outcome,
      ...(durationMs !== undefined ? { durationMs } : {}),
      toolCalls,
      failedToolCalls,
      ...(meta.stage1Tokens !== undefined ? { stage1Tokens: meta.stage1Tokens } : {}),
      source: "transcript"
    });
  }
  return events;
}

/**
 * Reads either a single `.jsonl` transcript file or all `.jsonl` transcripts inside a folder.
 *
 * @param targetPath - File or directory path.
 * @param options - Agent, library, and project overrides.
 * @returns Files scanned and extracted `skill.invoked` events.
 */
export async function collectTranscriptEvents(
  targetPath: string,
  options: TranscriptParseOptions = {}
): Promise<{ filesScanned: number; events: SkillInvokedEvent[] }> {
  const resolved = path.resolve(targetPath);
  const stat = await fs.stat(resolved);
  const files: string[] = [];

  if (stat.isFile()) {
    files.push(resolved);
  } else if (stat.isDirectory()) {
    for (const entry of await fs.readdir(resolved, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(resolved, entry.name));
      }
    }
    files.sort((a, b) => a.localeCompare(b));
  }

  const events: SkillInvokedEvent[] = [];
  for (const file of files) {
    events.push(...(await parseTranscriptFile(file, options)));
  }
  return { filesScanned: files.length, events };
}

function resolveHookConfigPath(agent: HookInstallTarget, dest: string, scope: TargetScope, homeDir: string): string {
  const base = scope === "user" ? homeDir : path.resolve(dest);
  switch (agent) {
    case "claude":
      return path.join(base, ".claude", "settings.json");
    case "cursor":
      return path.join(base, ".cursor", "hooks.json");
    case "gemini":
      return path.join(base, ".gemini", "settings.json");
    case "copilot":
      return path.join(base, scope === "user" ? ".copilot" : ".github", "hooks", "skanvil-telemetry.json");
    case "windsurf":
      return path.join(base, scope === "user" ? path.join(".codeium", "windsurf") : ".windsurf", "hooks.json");
    case "codex":
      return path.join(base, ".codex", "hooks.json");
    case "opencode":
      return path.join(base, scope === "user" ? path.join(".config", "opencode") : ".opencode", "hooks.json");
  }
}

function containsTelemetryHook(node: unknown): boolean {
  if (typeof node === "string") return node.includes("skanvil telemetry hook");
  if (Array.isArray(node)) return node.some(containsTelemetryHook);
  if (isRecord(node)) return Object.values(node).some(containsTelemetryHook);
  return false;
}

interface HookPresetSpec {
  includeVersion?: boolean;
  startKey: string;
  endKey: string;
  startEntry: (command: string) => Record<string, unknown>;
  endEntry: (command: string) => Record<string, unknown>;
}

const HOOK_SPECS: Record<HookInstallTarget, HookPresetSpec> = {
  claude: {
    startKey: "PostToolUse",
    endKey: "Stop",
    startEntry: (command) => ({ matcher: "Read|Skill", hooks: [{ type: "command", command }] }),
    endEntry: (command) => ({ hooks: [{ type: "command", command }] })
  },
  cursor: {
    includeVersion: true,
    startKey: "afterFileRead",
    endKey: "stop",
    startEntry: (command) => ({ command }),
    endEntry: (command) => ({ command })
  },
  gemini: {
    startKey: "AfterTool",
    endKey: "SessionEnd",
    startEntry: (command) => ({
      matcher: "read_file|activate_skill",
      hooks: [{ name: "skanvil-telemetry", type: "command", command }]
    }),
    endEntry: (command) => ({ hooks: [{ name: "skanvil-telemetry-end", type: "command", command }] })
  },
  copilot: {
    includeVersion: true,
    startKey: "postToolUse",
    endKey: "sessionEnd",
    startEntry: (command) => ({ type: "command", bash: command }),
    endEntry: (command) => ({ type: "command", bash: command })
  },
  windsurf: {
    startKey: "post_read_code",
    endKey: "post_cascade_response",
    startEntry: (command) => ({ command, show_output: false }),
    endEntry: (command) => ({ command, show_output: false })
  },
  codex: {
    startKey: "post_tool_use",
    endKey: "session_end",
    startEntry: (command) => ({ command }),
    endEntry: (command) => ({ command })
  },
  opencode: {
    startKey: "post_tool_use",
    endKey: "session_end",
    startEntry: (command) => ({ command }),
    endEntry: (command) => ({ command })
  }
};

function mergeHookConfig(
  agent: HookInstallTarget,
  existing: Record<string, unknown>
): {
  updated: Record<string, unknown>;
  alreadyConfigured: boolean;
} {
  const command = HOOK_COMMANDS[agent];
  const spec = HOOK_SPECS[agent];
  const hooksMap = isRecord(existing.hooks) ? { ...existing.hooks } : {};

  const rawStart = hooksMap[spec.startKey];
  const rawEnd = hooksMap[spec.endKey];
  const startList: unknown[] = Array.isArray(rawStart) ? [...rawStart] : [];
  const endList: unknown[] = Array.isArray(rawEnd) ? [...rawEnd] : [];

  const hasStart = containsTelemetryHook(startList);
  const hasEnd = containsTelemetryHook(endList);
  if (hasStart && hasEnd) {
    return { updated: existing, alreadyConfigured: true };
  }

  if (!hasStart) startList.push(spec.startEntry(command));
  if (!hasEnd) endList.push(spec.endEntry(command));
  hooksMap[spec.startKey] = startList;
  hooksMap[spec.endKey] = endList;

  if (spec.includeVersion) {
    const version = typeof existing.version === "number" ? existing.version : 1;
    return { updated: { version, ...existing, hooks: hooksMap }, alreadyConfigured: false };
  }
  return { updated: { ...existing, hooks: hooksMap }, alreadyConfigured: false };
}

/**
 * Installs idempotent, non-blocking telemetry hooks (covering both tool reads and session end
 * timing/tool counts) into agent configuration files while preserving all existing settings.
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
