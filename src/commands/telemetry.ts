/**
 * CLI handlers for `skanvil telemetry`: CI snapshots, usage emission, offline queue flushing,
 * and non-blocking agent hooks (`claude`, `cursor`, `gemini`).
 *
 * @module
 */
import path from "node:path";

import { loadConfig } from "../core/config.js";
import {
  buildLibrarySnapshotEvent,
  buildSkillInvokedEvent,
  flushTelemetryQueue,
  resolveTelemetrySettings,
  sendTelemetryEvents,
  type ResolvedTelemetrySettings
} from "../core/telemetry.js";
import { installTelemetryHooks, parseAgentHookPayload } from "../core/telemetry-hooks.js";
import { Output } from "../util/output.js";
import { displayPath } from "../util/paths.js";
import { openLibrary, resolveRoot, type CommonOptions } from "./shared.js";

/** Common connection overrides for telemetry commands. */
export interface TelemetryConnectionOptions extends CommonOptions {
  /** `--endpoint`: base URL of `skanvil-hub`. */
  endpoint?: string;
  /** `--api-key`: Bearer ingestion key. */
  apiKey?: string;
  /** `--dry-run`: preview payload without sending or modifying disk. */
  dryRun?: boolean;
  /** `false` with `--no-queue`: do not buffer failed deliveries locally. */
  queue?: boolean;
}

/** Options of `skanvil telemetry emit`. */
export interface TelemetryEmitCommandOptions extends TelemetryConnectionOptions {
  /** `--skill`: skill folder name. */
  skill: string;
  /** `--library`: owning library name. */
  library?: string;
  /** `--agent`: agent name (`claude`, `cursor`, `gemini`, ...). */
  agent?: string;
  /** `--model`: model name. */
  model?: string;
  /** `--outcome`: `success`, `error`, `friction`, or `unknown`. */
  outcome?: "success" | "error" | "friction" | "unknown";
  /** `--duration-ms`: execution duration in milliseconds. */
  durationMs?: string | number;
  /** `--tool-calls`: tool call count. */
  toolCalls?: string | number;
  /** `--failed-tool-calls`: failed tool call count. */
  failedToolCalls?: string | number;
}

/** Options of `skanvil telemetry hook`. */
export interface TelemetryHookCommandOptions {
  /** `--agent`: `claude`, `cursor`, or `gemini`. */
  agent: string;
  /** `--endpoint`: base URL of `skanvil-hub`. */
  endpoint?: string;
  /** `--api-key`: Bearer ingestion key. */
  apiKey?: string;
}

/** Options of `skanvil telemetry install-hooks`. */
export interface TelemetryInstallHooksCommandOptions extends CommonOptions {
  /** `--target`: agent preset(s) (`claude`, `cursor`, `gemini`). */
  target?: string[];
  /** `--global`: write into user home settings instead of project folder. */
  global?: boolean;
  /** `--dry-run`: preview without modifying settings files. */
  dryRun?: boolean;
}

async function resolveOptionalSettings(
  root: string | undefined,
  options: TelemetryConnectionOptions
): Promise<ResolvedTelemetrySettings> {
  let config;
  if (root) {
    config = await loadConfig(root).catch(() => undefined);
  }
  return resolveTelemetrySettings(config, {
    endpoint: options.endpoint,
    apiKey: options.apiKey
  });
}

/**
 * `skanvil telemetry snapshot`: collects library budgets, validation counts, trigger check
 * outcomes, and skill metadata and sends a `library.snapshot` event to `skanvil-hub`.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code (`0` when sent, dry-run, opted-out, or queued; `1` on failed strict send with `--no-queue`).
 */
export async function telemetrySnapshotCommand(options: TelemetryConnectionOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("telemetry", options.json);
  const settings = resolveTelemetrySettings(library.config, {
    endpoint: options.endpoint,
    apiKey: options.apiKey
  });
  const event = await buildLibrarySnapshotEvent(library);
  const result = await sendTelemetryEvents([event], settings, {
    dryRun: options.dryRun,
    queueOnFailure: options.queue !== false,
    throwOnFailure: options.queue === false && !options.dryRun
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.error && options.queue === false ? 1 : 0;
  }

  if (result.skippedReason) {
    out.info(`Skipped snapshot (${result.skippedReason}).`);
    return 0;
  }
  if (result.dryRun) {
    out.info(
      `(dry run) Snapshot for ${event.library}: ${event.totals.skills} skill(s), ~${event.totals.alwaysLoadedTokens} Stage-1 tokens.`
    );
    return 0;
  }
  if (result.queued > 0) {
    out.warn(`Queued ${result.queued} snapshot event to ${displayPath(settings.queueFile)} (${result.error}).`);
    return 0;
  }
  out.success(
    `Sent snapshot for ${event.library} (${event.totals.skills} skill(s), ~${event.totals.alwaysLoadedTokens} Stage-1 tokens) to ${settings.endpoint}.`
  );
  return 0;
}

/**
 * `skanvil telemetry emit`: sends a `skill.invoked` usage event manually or from scripts/workflows.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code (`0` on success/queued/dry-run).
 */
export async function telemetryEmitCommand(options: TelemetryEmitCommandOptions): Promise<number> {
  const root = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const out = new Output("telemetry", options.json);
  const settings = await resolveOptionalSettings(root, options);

  let inferredLibrary = options.library;
  if (!inferredLibrary) {
    const config = await loadConfig(root).catch(() => undefined);
    if (config?.name) inferredLibrary = config.scope ? `@${config.scope}/${config.name}` : config.name;
  }

  const parseIntOpt = (value: string | number | undefined, flag: string): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer.`);
    return parsed;
  };

  const event = buildSkillInvokedEvent({
    skill: options.skill,
    library: inferredLibrary,
    agent: options.agent,
    model: options.model,
    projectPath: root,
    outcome: options.outcome,
    durationMs: parseIntOpt(options.durationMs, "--duration-ms"),
    toolCalls: parseIntOpt(options.toolCalls, "--tool-calls"),
    failedToolCalls: parseIntOpt(options.failedToolCalls, "--failed-tool-calls"),
    source: "cli"
  });

  const result = await sendTelemetryEvents([event], settings, {
    dryRun: options.dryRun,
    queueOnFailure: options.queue !== false,
    throwOnFailure: options.queue === false && !options.dryRun
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.skippedReason) {
    out.info(`Skipped event (${result.skippedReason}).`);
    return 0;
  }
  if (result.dryRun) {
    out.info(`(dry run) Ready to send skill.invoked for ${event.skill} (${event.agent}).`);
    return 0;
  }
  if (result.queued > 0) {
    out.warn(`Queued event to ${displayPath(settings.queueFile)} (${result.error}).`);
    return 0;
  }
  out.success(`Sent skill.invoked for ${event.skill} (${event.agent}) to ${settings.endpoint}.`);
  return 0;
}

function readStdinBounded(timeoutMs = 1000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", finish);
      process.stdin.removeListener("error", finish);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", onData);
    process.stdin.once("end", finish);
    process.stdin.once("error", finish);
    process.stdin.resume();
  });
}

/**
 * `skanvil telemetry hook`: reads an agent hook JSON payload on stdin, detects synced/library skill
 * usage, and sends or queues a `skill.invoked` event. Always exits `0` so agents are never blocked.
 *
 * @param options - Agent type and optional endpoint overrides.
 * @returns Exit code (`0`).
 */
export async function telemetryHookCommand(options: TelemetryHookCommandOptions): Promise<number> {
  try {
    const stdinText = await readStdinBounded(800);
    const signal = await parseAgentHookPayload(options.agent, stdinText, process.cwd());
    if (!signal) return 0;

    const settings = await resolveOptionalSettings(signal.projectPath, options);
    const event = buildSkillInvokedEvent({
      skill: signal.skill,
      library: signal.library,
      agent: signal.agent,
      model: signal.model,
      projectPath: signal.projectPath,
      sessionId: signal.sessionId,
      outcome: signal.outcome,
      stage1Tokens: signal.stage1Tokens,
      source: "hook"
    });
    await sendTelemetryEvents([event], settings, { queueOnFailure: true });
  } catch {
    // Hooks must stay silent and non-blocking inside coding agents.
  }
  return 0;
}

/**
 * `skanvil telemetry push`: flushes buffered events from the local offline JSONL queue to `skanvil-hub`.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code (`0` when sent or queue empty; `1` if delivery failed).
 */
export async function telemetryPushCommand(options: TelemetryConnectionOptions): Promise<number> {
  const root = resolveRoot(options);
  const out = new Output("telemetry", options.json);
  const settings = await resolveOptionalSettings(root, options);
  const result = await flushTelemetryQueue(settings, { dryRun: options.dryRun });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.error ? 1 : 0;
  }
  if (result.skippedReason) {
    out.info(`Skipped queue push (${result.skippedReason}).`);
    return 0;
  }
  if (result.dryRun) {
    out.info(`(dry run) ${result.queued} queued event(s) ready in ${displayPath(settings.queueFile)}.`);
    return 0;
  }
  if (result.events.length === 0) {
    out.info("Telemetry queue is empty.");
    return 0;
  }
  if (result.error) {
    out.warn(`Sent ${result.sent}, ${result.remaining} remaining in queue (${result.error}).`);
    return 1;
  }
  out.success(`Flushed ${result.sent} queued event(s) to ${settings.endpoint}.`);
  return 0;
}

/**
 * `skanvil telemetry install-hooks`: configures non-blocking skill telemetry hooks for
 * `claude`, `cursor`, and/or `gemini`.
 *
 * @param dest - Optional project folder (ignored with `--global`).
 * @param options - Target agents, scope, and `dryRun`.
 * @returns Exit code (`0`).
 */
export async function telemetryInstallHooksCommand(
  dest: string | undefined,
  options: TelemetryInstallHooksCommandOptions
): Promise<number> {
  if (options.global && dest) {
    throw new Error("Do not pass a destination together with --global: global hooks go to your home folder.");
  }
  const out = new Output("telemetry", options.json);
  const targets = (options.target ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const result = await installTelemetryHooks({
    targets: targets.length > 0 ? targets : ["claude", "cursor", "gemini"],
    dest: dest ? path.resolve(dest) : process.cwd(),
    scope: options.global ? "user" : "project",
    dryRun: options.dryRun
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const prefix = result.dryRun ? "(dry run) " : "";
  for (const item of result.results) {
    out.print(`   ${item.agent}: ${item.status} (${displayPath(item.file)})`);
  }
  out.success(`${prefix}Processed telemetry hook configuration for ${result.results.length} agent(s).`);
  return 0;
}
