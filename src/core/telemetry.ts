/**
 * Opt-in self-hosted telemetry client, event schemas, redaction, offline queue, and event builders.
 *
 * Uses built-in `fetch` and `node:crypto` with zero external dependencies. Never transmits prompts,
 * skill bodies, or secrets, and respects `DO_NOT_TRACK=1` / `SKANVIL_NO_TELEMETRY=1`.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { packageVersion } from "../util/paths.js";
import { DEFAULT_TELEMETRY_TIMEOUT_MS, type ResolvedConfig } from "./config.js";
import { checkTriggerRouting } from "./evals.js";
import { FEEDBACK_FILE, readFeedbackLog, type InvalidFeedbackLine } from "./feedback.js";
import type { Library } from "./library.js";
import { toLibrary, type LibraryRef } from "./skills.js";
import { analyzeLibraryStats } from "./stats.js";
import type { TargetResult, TargetScope } from "./sync.js";
import { validateLibrary } from "./validate.js";

const execFileAsync = promisify(execFile);

/** Version of the telemetry event envelope schema. */
export const TELEMETRY_SCHEMA_VERSION = 1;

/** Maximum events sent in a single `POST /v1/events` request. */
const MAX_BATCH_SIZE = 200;

const IsoTimestampSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "timestamp must be a valid ISO-8601 date");

const EnvelopeFields = {
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  eventId: z.string().min(1),
  timestamp: IsoTimestampSchema,
  library: z.string().min(1),
  skanvilVersion: z.string().min(1)
};

/** Skill entry captured inside a {@link LibrarySnapshotEvent}. */
export const SnapshotSkillSchema = z
  .object({
    name: z.string().min(1),
    category: z.string().min(1),
    status: z.string().optional(),
    owner: z.string().optional(),
    replacedBy: z.string().optional(),
    stage1Tokens: z.number().int().nonnegative(),
    bodyLines: z.number().int().nonnegative(),
    bodyTokens: z.number().int().nonnegative(),
    resourceFiles: z.number().int().nonnegative(),
    unreferencedFiles: z.number().int().nonnegative(),
    evalCases: z.number().int().nonnegative(),
    evalTriggers: z.number().int().nonnegative(),
    valid: z.boolean()
  })
  .strict();

/** Periodic or CI snapshot of a skill library's catalog, token budgets, validation and evals. */
export const LibrarySnapshotEventSchema = z
  .object({
    ...EnvelopeFields,
    type: z.literal("library.snapshot"),
    projectHash: z.string().min(1).optional(),
    gitSha: z.string().min(1).optional(),
    gitBranch: z.string().min(1).optional(),
    totals: z
      .object({
        skills: z.number().int().nonnegative(),
        alwaysLoadedTokens: z.number().int().nonnegative(),
        bodyTokens: z.number().int().nonnegative(),
        bodyLines: z.number().int().nonnegative(),
        resourceFiles: z.number().int().nonnegative(),
        resourceTokens: z.number().int().nonnegative(),
        unreferencedFiles: z.number().int().nonnegative()
      })
      .strict(),
    validation: z
      .object({
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative()
      })
      .strict(),
    evals: z
      .object({
        totalTriggers: z.number().int().nonnegative(),
        passedTriggers: z.number().int().nonnegative(),
        failedTriggers: z.number().int().nonnegative()
      })
      .strict(),
    skills: z.array(SnapshotSkillSchema)
  })
  .strict();

/** Sync execution summary emitted when installing skills into an agent folder. */
export const SyncAppliedEventSchema = z
  .object({
    ...EnvelopeFields,
    type: z.literal("sync.applied"),
    projectHash: z.string().min(1),
    target: z.string().min(1),
    scope: z.enum(["project", "user"]),
    mode: z.enum(["copy", "link"]),
    added: z.array(z.string()),
    updated: z.array(z.string()),
    unchanged: z.array(z.string()),
    removed: z.array(z.string()),
    skipped: z.array(z.object({ skill: z.string(), reason: z.string() }).strict()),
    installedSkills: z.array(z.string()),
    alwaysLoadedTokens: z.number().int().nonnegative()
  })
  .strict();

/** Agent skill invocation telemetry (from agent hooks or CLI automation). */
export const SkillInvokedEventSchema = z
  .object({
    ...EnvelopeFields,
    type: z.literal("skill.invoked"),
    skill: z.string().min(1),
    agent: z.string().min(1),
    model: z.string().optional(),
    projectHash: z.string().optional(),
    sessionHash: z.string().optional(),
    skillVersion: z.string().optional(),
    owner: z.string().optional(),
    outcome: z.enum(["success", "error", "friction", "unknown"]),
    durationMs: z.number().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    failedToolCalls: z.number().int().nonnegative().optional(),
    stage1Tokens: z.number().int().nonnegative().optional(),
    source: z.enum(["hook", "cli", "manual", "transcript"]).optional()
  })
  .strict();

/** Friction report derived from `.skanvil-feedback.jsonl` with secrets and local paths redacted. */
export const SkillFeedbackEventSchema = z
  .object({
    ...EnvelopeFields,
    type: z.literal("skill.feedback"),
    skill: z.string().min(1),
    step: z.string().min(1),
    symptom: z.string().min(1),
    proposedFix: z.string().optional(),
    hasSuggestedEvalCase: z.boolean(),
    projectHash: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    reportedAt: z.string().optional()
  })
  .strict();

/** Discriminated union of all skanvil v1 telemetry events. */
export const TelemetryEventSchema = z.discriminatedUnion("type", [
  LibrarySnapshotEventSchema,
  SyncAppliedEventSchema,
  SkillInvokedEventSchema,
  SkillFeedbackEventSchema
]);

/** Ingestion batch accepted by `POST /v1/events`. */
export const TelemetryBatchSchema = z
  .object({
    events: z.array(TelemetryEventSchema).min(1).max(500)
  })
  .strict();

export type LibrarySnapshotEvent = z.infer<typeof LibrarySnapshotEventSchema>;
export type SyncAppliedEvent = z.infer<typeof SyncAppliedEventSchema>;
export type SkillInvokedEvent = z.infer<typeof SkillInvokedEventSchema>;
export type SkillFeedbackEvent = z.infer<typeof SkillFeedbackEventSchema>;
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/** Resolved telemetry connection settings (never persisted with secrets). */
export interface ResolvedTelemetrySettings {
  enabled: boolean;
  endpoint?: string;
  apiKey?: string;
  timeoutMs: number;
  queueFile: string;
}

/** CLI/programmatic overrides accepted by {@link resolveTelemetrySettings}. */
export interface TelemetrySettingsOverrides {
  enabled?: boolean;
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  queueFile?: string;
}

/** Result of {@link sendTelemetryEvents}. */
export interface TelemetrySendResult {
  sent: number;
  queued: number;
  dryRun: boolean;
  skippedReason?: string;
  error?: string;
  events: TelemetryEvent[];
}

/** Result of {@link flushTelemetryQueue}. */
export interface TelemetryFlushResult extends TelemetrySendResult {
  remaining: number;
  invalidLines: number;
}

/** Options of {@link buildLibrarySnapshotEvent}. */
export interface SnapshotBuildOptions {
  /** Override git commit SHA (auto-detected via `git rev-parse` when omitted). */
  gitSha?: string;
  /** Override git branch name (auto-detected via `git rev-parse` when omitted). */
  gitBranch?: string;
}

/** Options of {@link buildSkillInvokedEvent}. */
export interface BuildSkillInvokedOptions {
  skill: string;
  library?: string;
  agent?: string;
  model?: string;
  projectPath?: string;
  projectHash?: string;
  sessionId?: string;
  sessionHash?: string;
  skillVersion?: string;
  owner?: string;
  outcome?: "success" | "error" | "friction" | "unknown";
  durationMs?: number;
  toolCalls?: number;
  failedToolCalls?: number;
  stage1Tokens?: number;
  source?: "hook" | "cli" | "manual" | "transcript";
  timestamp?: string;
}

/**
 * Returns `true` when telemetry is globally disabled via `DO_NOT_TRACK` or `SKANVIL_NO_TELEMETRY`.
 *
 * @param env - Environment map. @defaultValue `process.env`
 */
export function isTelemetryOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  const isTruthy = (value?: string) => value === "1" || value?.toLowerCase() === "true";
  return isTruthy(env.DO_NOT_TRACK) || isTruthy(env.SKANVIL_NO_TELEMETRY);
}

/**
 * Computes a short, irreversible SHA-256 hash (`sha256:<16 hex chars>`) for identifiers such as
 * local workspace paths or agent session IDs.
 *
 * @param value - Sensitive or local identifier string.
 * @returns Prefixed truncated digest safe for telemetry payloads.
 */
export function hashIdentifier(value: string): string {
  const digest = createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
  return `sha256:${digest}`;
}

/**
 * Returns the canonical library identifier (`@scope/name`, `name`, or folder basename).
 *
 * @param library - Open library instance.
 * @returns Library display identifier.
 */
export function libraryDisplayName(library: Library): string {
  const name = library.config.name || path.basename(library.root);
  return library.config.scope ? `@${library.config.scope}/${name}` : name;
}

/**
 * Returns the default local JSONL queue path used when telemetry delivery fails offline.
 *
 * @param homeDir - Override user home directory. @defaultValue `os.homedir()`
 */
export function defaultTelemetryQueuePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".skanvil", "telemetry-queue.jsonl");
}

/**
 * Redacts hardcoded credentials and personal home directory paths from free-text feedback fields
 * before transmitting telemetry events.
 *
 * @param text - Input text such as a friction symptom or proposed fix.
 * @returns Sanitized text safe for centralized analytics storage.
 */
export function redactTelemetryText(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g, "<redacted-private-key>")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, "<redacted-token>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, "<redacted-token>")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted-aws-key>")
    .replace(/\bxox[baprs]-[0-9A-Za-z-]{15,}\b/g, "<redacted-token>")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "<redacted-key>")
    .replace(/\b(?:sk-proj-|sk-ant-api\d+-|sk_live_)[A-Za-z0-9_-]{20,}\b/g, "<redacted-key>")
    .replace(/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, "Authorization: Bearer <redacted>")
    .replace(/(\/Users\/|\/home\/)([A-Za-z0-9._-]+)/g, "$1<user>")
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)([A-Za-z0-9._-]+)/gi, "$1<user>");
}

/**
 * Resolves effective telemetry settings from `.skanvilrc.json`, environment variables, and explicit overrides.
 *
 * @param config - Resolved library config (optional outside a library repository).
 * @param overrides - Explicit CLI flags or programmatic options.
 * @param env - Environment variables. @defaultValue `process.env`
 * @returns Resolved telemetry configuration ready for {@link sendTelemetryEvents}.
 */
export function resolveTelemetrySettings(
  config?: ResolvedConfig,
  overrides: TelemetrySettingsOverrides = {},
  env: NodeJS.ProcessEnv = process.env
): ResolvedTelemetrySettings {
  const endpointRaw = overrides.endpoint?.trim() || env.SKANVIL_TELEMETRY_URL?.trim() || config?.telemetry.endpoint;
  const endpoint = endpointRaw ? endpointRaw.replace(/\/+$/, "") : undefined;
  const apiKey = overrides.apiKey?.trim() || env.SKANVIL_TELEMETRY_KEY?.trim() || undefined;
  const envEnabled =
    env.SKANVIL_TELEMETRY_ENABLED === "1" || env.SKANVIL_TELEMETRY_ENABLED?.toLowerCase() === "true"
      ? true
      : env.SKANVIL_TELEMETRY_ENABLED === "0" || env.SKANVIL_TELEMETRY_ENABLED?.toLowerCase() === "false"
        ? false
        : undefined;
  const enabled =
    overrides.enabled ??
    (overrides.endpoint ? true : undefined) ??
    envEnabled ??
    (env.SKANVIL_TELEMETRY_URL ? true : undefined) ??
    config?.telemetry.enabled ??
    false;
  const timeoutMs = overrides.timeoutMs ?? config?.telemetry.timeoutMs ?? DEFAULT_TELEMETRY_TIMEOUT_MS;
  const queueFile = overrides.queueFile?.trim() || env.SKANVIL_TELEMETRY_QUEUE?.trim() || defaultTelemetryQueuePath();

  return {
    enabled,
    ...(endpoint ? { endpoint } : {}),
    ...(apiKey ? { apiKey } : {}),
    timeoutMs,
    queueFile
  };
}

function assertValidEndpoint(endpoint: string | undefined): string {
  if (!endpoint) {
    throw new Error(
      "Telemetry endpoint is not configured. Pass --endpoint <url>, set SKANVIL_TELEMETRY_URL, or configure telemetry.endpoint in .skanvilrc.json."
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid telemetry endpoint URL '${endpoint}'.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Telemetry endpoint must use http:// or https:// (got '${parsed.protocol}').`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

async function readGitMeta(root: string): Promise<{ gitSha?: string; gitBranch?: string }> {
  try {
    const [shaOut, branchOut] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).catch(() => null),
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).catch(() => null)
    ]);
    const gitSha = shaOut?.stdout.trim() || undefined;
    const rawBranch = branchOut?.stdout.trim();
    const gitBranch = rawBranch && rawBranch !== "HEAD" ? rawBranch : undefined;
    return { ...(gitSha ? { gitSha } : {}), ...(gitBranch ? { gitBranch } : {}) };
  } catch {
    return {};
  }
}

/**
 * Collects a sanitized snapshot of the library's 3-stage budgets, validation counts, trigger check
 * results, and per-skill metadata for `skanvil telemetry snapshot`.
 *
 * @param ref - Library or library root path.
 * @param options - Optional git SHA / branch overrides.
 * @returns Ready-to-send {@link LibrarySnapshotEvent}.
 */
export async function buildLibrarySnapshotEvent(
  ref: LibraryRef,
  options: SnapshotBuildOptions = {}
): Promise<LibrarySnapshotEvent> {
  const library = await toLibrary(ref);
  const [stats, validation, triggers, gitMeta] = await Promise.all([
    analyzeLibraryStats(library),
    validateLibrary(library),
    checkTriggerRouting(library),
    options.gitSha || options.gitBranch
      ? Promise.resolve({} as { gitSha?: string; gitBranch?: string })
      : readGitMeta(library.root)
  ]);

  const errorsBySkill = new Set(
    validation.diagnostics
      .filter((diag) => diag.severity === "error" && diag.skill && !diag.rule.startsWith("readme-"))
      .map((diag) => diag.skill!)
  );

  const skills: LibrarySnapshotEvent["skills"] = [];
  for (const item of stats.skills) {
    let owner = "";
    let replacedBy = "";
    let evalCases = 0;
    let evalTriggers = 0;

    try {
      const skill = await library.readSkillRendered(item.name).catch(() => library.readSkill(item.name));
      owner = skill.getString("metadata", "owner");
      replacedBy = skill.getString("metadata", "replaced-by");
    } catch {
      // Leave optional frontmatter metadata blank if unreadable.
    }
    try {
      const evals = await library.readSkillEvals(item.name);
      if (evals) {
        evalCases = evals.cases?.length ?? 0;
        evalTriggers = (evals.triggers?.shouldTrigger.length ?? 0) + (evals.triggers?.shouldNotTrigger.length ?? 0);
      }
    } catch {
      // Malformed evals.json is captured in validation errors.
    }

    skills.push({
      name: item.name,
      category: item.category,
      ...(item.status ? { status: item.status } : {}),
      ...(owner ? { owner } : {}),
      ...(replacedBy ? { replacedBy } : {}),
      stage1Tokens: item.alwaysLoaded.estimatedTokens,
      bodyLines: item.body.lines,
      bodyTokens: item.body.estimatedTokens,
      resourceFiles: item.resources.files,
      unreferencedFiles: item.resources.unreferencedFiles.length,
      evalCases,
      evalTriggers,
      valid: !errorsBySkill.has(item.name)
    });
  }

  const gitSha = options.gitSha ?? gitMeta.gitSha;
  const gitBranch = options.gitBranch ?? gitMeta.gitBranch;

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "library.snapshot",
    library: libraryDisplayName(library),
    skanvilVersion: packageVersion(),
    projectHash: hashIdentifier(library.root),
    ...(gitSha ? { gitSha } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    totals: {
      skills: stats.count,
      alwaysLoadedTokens: stats.totals.alwaysLoadedTokens,
      bodyTokens: stats.totals.bodyTokens,
      bodyLines: stats.totals.bodyLines,
      resourceFiles: stats.totals.resourceFiles,
      resourceTokens: stats.totals.resourceTokens,
      unreferencedFiles: stats.totals.unreferencedFiles
    },
    validation: {
      errors: validation.errors,
      warnings: validation.warnings
    },
    evals: {
      totalTriggers: triggers.total,
      passedTriggers: triggers.passed,
      failedTriggers: triggers.failed
    },
    skills
  };
}

/**
 * Builds `sync.applied` telemetry events from {@link syncSkills} results.
 *
 * @param library - Source library synced from.
 * @param results - Sync results returned by `syncSkills`.
 * @param options - Destination root path, mode, and scope.
 * @returns One {@link SyncAppliedEvent} per synced target.
 */
export function buildSyncAppliedEvents(
  library: Library,
  results: TargetResult[],
  options: { dest: string; mode: "copy" | "link"; scope: TargetScope; libraryName?: string }
): SyncAppliedEvent[] {
  const projectHash = hashIdentifier(path.resolve(options.dest));
  const libraryName = options.libraryName || libraryDisplayName(library);
  const timestamp = new Date().toISOString();
  const version = packageVersion();

  return results.map((result) => ({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: randomUUID(),
    timestamp,
    type: "sync.applied",
    library: libraryName,
    skanvilVersion: version,
    projectHash,
    target: result.target,
    scope: options.scope,
    mode: options.mode,
    added: result.added,
    updated: result.updated,
    unchanged: result.unchanged,
    removed: result.removed,
    skipped: result.skipped,
    installedSkills: [...result.added, ...result.updated, ...result.unchanged].sort((a, b) => a.localeCompare(b)),
    alwaysLoadedTokens: result.alwaysLoadedTokens
  }));
}

/**
 * Builds a validated {@link SkillInvokedEvent} for CLI emission or agent hooks.
 *
 * @param options - Skill invocation attributes and metrics.
 * @returns Validated `skill.invoked` telemetry event.
 */
export function buildSkillInvokedEvent(options: BuildSkillInvokedOptions): SkillInvokedEvent {
  if (!options.skill.trim()) {
    throw new Error("Skill name is required for skill.invoked telemetry.");
  }
  const projectHash =
    options.projectHash ?? (options.projectPath ? hashIdentifier(path.resolve(options.projectPath)) : undefined);
  const sessionHash = options.sessionHash ?? (options.sessionId ? hashIdentifier(options.sessionId) : undefined);

  return SkillInvokedEventSchema.parse({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: randomUUID(),
    timestamp: options.timestamp ?? new Date().toISOString(),
    type: "skill.invoked",
    library: options.library?.trim() || "local",
    skanvilVersion: packageVersion(),
    skill: options.skill.trim(),
    agent: options.agent?.trim().toLowerCase() || "unknown",
    ...(options.model?.trim() ? { model: options.model.trim() } : {}),
    ...(projectHash ? { projectHash } : {}),
    ...(sessionHash ? { sessionHash } : {}),
    ...(options.skillVersion?.trim() ? { skillVersion: options.skillVersion.trim() } : {}),
    ...(options.owner?.trim() ? { owner: options.owner.trim() } : {}),
    outcome: options.outcome ?? "success",
    ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    ...(options.toolCalls !== undefined ? { toolCalls: options.toolCalls } : {}),
    ...(options.failedToolCalls !== undefined ? { failedToolCalls: options.failedToolCalls } : {}),
    ...(options.stage1Tokens !== undefined ? { stage1Tokens: options.stage1Tokens } : {}),
    ...(options.source ? { source: options.source } : {})
  });
}

/**
 * Converts `.skanvil-feedback.jsonl` entries into redacted, deduplicated {@link SkillFeedbackEvent} items.
 *
 * @param ref - Library or library root.
 * @param options - Optional log path override and skill filter.
 * @returns Feedback telemetry events and malformed source lines.
 */
export async function buildFeedbackEvents(
  ref: LibraryRef,
  options: { file?: string; skill?: string } = {}
): Promise<{ events: SkillFeedbackEvent[]; invalidLines: InvalidFeedbackLine[]; file: string }> {
  const library = await toLibrary(ref);
  const logPath = path.resolve(library.root, options.file || FEEDBACK_FILE);
  const read = await readFeedbackLog(logPath);
  const filtered = options.skill ? read.entries.filter((entry) => entry.skill === options.skill) : read.entries;
  const libraryName = libraryDisplayName(library);
  const projectHash = hashIdentifier(library.root);
  const version = packageVersion();
  const now = new Date().toISOString();

  const events: SkillFeedbackEvent[] = filtered.map((entry) => {
    const symptom = redactTelemetryText(entry.symptom);
    const proposedFix = entry.proposedFix ? redactTelemetryText(entry.proposedFix) : undefined;
    // Deterministic eventId allows repeatable `feedback push` without duplicating server rows.
    const eventHash = createHash("sha256")
      .update(
        `${libraryName}\0${entry.skill}\0${entry.step}\0${symptom}\0${entry.timestamp ?? ""}\0${entry.rawLine ?? 0}`
      )
      .digest("hex")
      .slice(0, 24);

    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: `fb_${eventHash}`,
      timestamp: entry.timestamp && !Number.isNaN(Date.parse(entry.timestamp)) ? entry.timestamp : now,
      type: "skill.feedback",
      library: libraryName,
      skanvilVersion: version,
      skill: entry.skill,
      step: entry.step,
      symptom,
      ...(proposedFix ? { proposedFix } : {}),
      hasSuggestedEvalCase: entry.suggestedEvalCase !== undefined,
      projectHash,
      ...(entry.timestamp ? { reportedAt: entry.timestamp } : {})
    };
  });

  return { events, invalidLines: read.invalidLines, file: read.file };
}

/**
 * Appends telemetry events to the offline JSONL retry queue.
 *
 * @param events - Events to queue.
 * @param queueFile - Queue JSONL path.
 */
export async function enqueueTelemetryEvents(
  events: readonly TelemetryEvent[],
  queueFile: string = defaultTelemetryQueuePath()
): Promise<void> {
  if (events.length === 0) return;
  await fs.mkdir(path.dirname(queueFile), { recursive: true });
  const payload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await fs.appendFile(queueFile, payload, "utf8");
}

async function postBatch(
  events: readonly TelemetryEvent[],
  endpoint: string,
  settings: ResolvedTelemetrySettings
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;

  const response = await fetch(`${endpoint}/v1/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(settings.timeoutMs)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
}

/**
 * Sends telemetry events to `POST <endpoint>/v1/events`, chunking batches and falling back to the
 * local offline queue when delivery fails.
 *
 * @param events - Telemetry events to transmit.
 * @param settings - Resolved endpoint, API key, timeout, and queue file.
 * @param options - Control `dryRun`, offline queueing (`queueOnFailure`), and error propagation (`throwOnFailure`).
 * @returns Delivery counts and any failure message.
 */
export async function sendTelemetryEvents(
  events: readonly TelemetryEvent[],
  settings: ResolvedTelemetrySettings,
  options: { queueOnFailure?: boolean; dryRun?: boolean; throwOnFailure?: boolean } = {}
): Promise<TelemetrySendResult> {
  const list = [...events];
  if (isTelemetryOptedOut()) {
    return { sent: 0, queued: 0, dryRun: Boolean(options.dryRun), skippedReason: "opted-out", events: list };
  }
  if (options.dryRun) {
    return { sent: 0, queued: 0, dryRun: true, events: list };
  }
  if (list.length === 0) {
    return { sent: 0, queued: 0, dryRun: false, events: [] };
  }

  let endpoint: string;
  try {
    endpoint = assertValidEndpoint(settings.endpoint);
  } catch (error) {
    if (options.throwOnFailure) throw error;
    if (options.queueOnFailure !== false) {
      await enqueueTelemetryEvents(list, settings.queueFile);
      return {
        sent: 0,
        queued: list.length,
        dryRun: false,
        error: (error as Error).message,
        events: list
      };
    }
    return { sent: 0, queued: 0, dryRun: false, error: (error as Error).message, events: list };
  }

  let sent = 0;
  for (let i = 0; i < list.length; i += MAX_BATCH_SIZE) {
    const chunk = list.slice(i, i + MAX_BATCH_SIZE);
    try {
      await postBatch(chunk, endpoint, settings);
      sent += chunk.length;
    } catch (error) {
      const unsent = list.slice(i);
      const message = (error as Error).message;
      if (options.throwOnFailure) throw error;
      if (options.queueOnFailure !== false) {
        await enqueueTelemetryEvents(unsent, settings.queueFile);
        return { sent, queued: unsent.length, dryRun: false, error: message, events: list };
      }
      return { sent, queued: 0, dryRun: false, error: message, events: list };
    }
  }

  return { sent, queued: 0, dryRun: false, events: list };
}

/**
 * Reads buffered events from `settings.queueFile`, uploads them to the self-hosted hub, and
 * removes delivered entries from disk cleanly.
 *
 * @param settings - Resolved endpoint, API key, timeout, and queue file.
 * @param options - Preview without sending or modifying the queue when `dryRun: true`.
 * @returns Sent, remaining, and invalid line counts.
 */
export async function flushTelemetryQueue(
  settings: ResolvedTelemetrySettings,
  options: { dryRun?: boolean; throwOnFailure?: boolean } = {}
): Promise<TelemetryFlushResult> {
  if (isTelemetryOptedOut()) {
    return {
      sent: 0,
      queued: 0,
      remaining: 0,
      invalidLines: 0,
      dryRun: Boolean(options.dryRun),
      skippedReason: "opted-out",
      events: []
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(settings.queueFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { sent: 0, queued: 0, remaining: 0, invalidLines: 0, dryRun: Boolean(options.dryRun), events: [] };
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  const validEvents: TelemetryEvent[] = [];
  let invalidLines = 0;

  for (const line of lines) {
    try {
      const parsed = TelemetryEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) validEvents.push(parsed.data);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }

  if (options.dryRun) {
    return {
      sent: 0,
      queued: validEvents.length,
      remaining: validEvents.length,
      invalidLines,
      dryRun: true,
      events: validEvents
    };
  }

  if (validEvents.length === 0) {
    await fs.rm(settings.queueFile, { force: true }).catch(() => undefined);
    return { sent: 0, queued: 0, remaining: 0, invalidLines, dryRun: false, events: [] };
  }

  const endpoint = assertValidEndpoint(settings.endpoint);
  let sent = 0;
  let errorMsg: string | undefined;
  let remainingEvents: TelemetryEvent[] = [];

  for (let i = 0; i < validEvents.length; i += MAX_BATCH_SIZE) {
    const chunk = validEvents.slice(i, i + MAX_BATCH_SIZE);
    try {
      await postBatch(chunk, endpoint, settings);
      sent += chunk.length;
    } catch (error) {
      errorMsg = (error as Error).message;
      remainingEvents = validEvents.slice(i);
      break;
    }
  }

  if (remainingEvents.length === 0) {
    await fs.rm(settings.queueFile, { force: true }).catch(() => undefined);
  } else {
    const body = `${remainingEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await fs.mkdir(path.dirname(settings.queueFile), { recursive: true });
    await fs.writeFile(settings.queueFile, body, "utf8");
    if (options.throwOnFailure && errorMsg) {
      throw new Error(errorMsg);
    }
  }

  return {
    sent,
    queued: remainingEvents.length,
    remaining: remainingEvents.length,
    invalidLines,
    dryRun: false,
    ...(errorMsg ? { error: errorMsg } : {}),
    events: validEvents
  };
}

/** Per-skill analytics row returned by `GET /api/dashboard/skills` on `skanvil-hub`. */
export interface HubSkillAuditRow {
  library: string;
  skill: string;
  category: string | null;
  owner: string | null;
  status: string | null;
  replacedBy: string | null;
  stage1Tokens: number | null;
  invocations: number;
  frictionEvents: number;
  frictionRate: number | null;
  syncedProjects: number;
  lastUsedAt: string | null;
  isZombie: boolean;
}

/** Audit summary fetched from a self-hosted `skanvil-hub` instance. */
export interface HubAuditResult {
  endpoint: string;
  library: string | null;
  days: number;
  skills: HubSkillAuditRow[];
  zombies: HubSkillAuditRow[];
  wastedStage1Tokens: number;
  highFriction: HubSkillAuditRow[];
}

/**
 * Silently attempts to flush `~/.skanvil/telemetry-queue.jsonl` in the background of another
 * telemetry-emitting CLI command (`sync`, `telemetry snapshot`). Never throws.
 *
 * @param settings - Resolved telemetry settings.
 * @returns Flush result when a queue file existed and delivery ran, otherwise `null`.
 */
export async function tryAutoFlushTelemetryQueue(
  settings: ResolvedTelemetrySettings
): Promise<TelemetryFlushResult | null> {
  if (isTelemetryOptedOut() || !settings.endpoint) return null;
  try {
    await fs.access(settings.queueFile);
  } catch {
    return null;
  }
  try {
    return await flushTelemetryQueue({
      ...settings,
      timeoutMs: Math.min(settings.timeoutMs, 1000)
    });
  } catch {
    return null;
  }
}

/**
 * Fetches live skill analytics from `GET <endpoint>/api/dashboard/skills` and flags zombie skills
 * and high-friction skills for `skanvil telemetry audit` and `skanvil diff --from-hub`.
 *
 * @param settings - Resolved telemetry settings containing the hub `endpoint`.
 * @param options - Optional library filter, lookback days (`30`), and admin token (`SKANVIL_HUB_ADMIN_TOKEN`).
 * @returns Audit lists and wasted Stage-1 token estimates.
 * @throws Error when no endpoint is configured or the hub returns a non-OK status.
 */
export async function fetchHubSkillsAudit(
  settings: ResolvedTelemetrySettings,
  options: { library?: string; days?: number; adminToken?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<HubAuditResult> {
  const endpoint = assertValidEndpoint(settings.endpoint);
  const days = Math.max(1, Math.min(365, Math.round(options.days ?? 30)));
  const env = options.env ?? process.env;
  const token = options.adminToken?.trim() || env.SKANVIL_HUB_ADMIN_TOKEN?.trim() || settings.apiKey;
  const params = new URLSearchParams({ days: String(days) });
  if (options.library?.trim()) params.set("library", options.library.trim());

  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${endpoint}/api/dashboard/skills?${params.toString()}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(settings.timeoutMs)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} fetching hub audit${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const payload = (await response.json()) as { library?: string | null; days?: number; skills?: HubSkillAuditRow[] };
  const skills = Array.isArray(payload.skills) ? payload.skills : [];
  const zombies = skills.filter((item) => item.isZombie);
  const wastedStage1Tokens = zombies.reduce((sum, item) => sum + (item.stage1Tokens ?? 0), 0);
  const highFriction = skills.filter(
    (item) => item.frictionEvents >= 2 || (item.frictionRate !== null && item.frictionRate >= 0.25)
  );

  return {
    endpoint,
    library: payload.library ?? options.library ?? null,
    days: payload.days ?? days,
    skills,
    zombies,
    wastedStage1Tokens,
    highFriction
  };
}
