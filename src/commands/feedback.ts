/**
 * CLI handlers for `skanvil feedback`: summarizing and promoting `.skanvil-feedback.jsonl` reports.
 *
 * Every handler returns the process exit code: 0 on success, 1 on failure.
 *
 * @module
 */
import path from "node:path";

import { promoteFeedback, summarizeFeedback } from "../core/feedback.js";
import { buildFeedbackEvents, resolveTelemetrySettings, sendTelemetryEvents } from "../core/telemetry.js";
import { Output } from "../util/output.js";
import { displayPath } from "../util/paths.js";
import { openLibrary, type CommonOptions } from "./shared.js";

/** Options of `skanvil feedback list`. */
export interface FeedbackListCommandOptions extends CommonOptions {
  /** `--file`: path to feedback JSONL file. */
  file?: string;
  /** `--skill`: filter entries by skill folder name. */
  skill?: string;
}

/**
 * `skanvil feedback list`: summarizes grouped friction entries from `.skanvil-feedback.jsonl`.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code (`0`).
 */
export async function feedbackListCommand(options: FeedbackListCommandOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("feedback", options.json);
  const file = options.file ? path.resolve(options.file) : undefined;
  const summary = await summarizeFeedback(library, { file, skill: options.skill });

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  if (summary.invalidLines.length > 0) {
    out.warn(`${summary.invalidLines.length} malformed line(s) in ${displayPath(summary.file)} were ignored.`);
  }
  if (summary.totalEntries === 0) {
    out.info(`No feedback entries found in ${displayPath(summary.file)}.`);
    return 0;
  }

  for (const group of summary.groups) {
    const suffix = group.suggestedEvalCases > 0 ? ` [${group.suggestedEvalCases} eval case(s)]` : "";
    out.print(` - ${group.skill} (x${group.count}, ${group.step}): ${group.symptom}${suffix}`);
    if (group.proposedFixes.length > 0) {
      out.print(`     fix: ${group.proposedFixes[0]}`);
    }
  }
  out.info(
    `Listed ${summary.uniqueGroups} unique issue(s) from ${summary.totalEntries} entry/entries in ${displayPath(summary.file)}.`
  );
  return 0;
}

/** Options of `skanvil feedback promote`. */
export interface FeedbackPromoteCommandOptions extends CommonOptions {
  /** `--file`: path to feedback JSONL file. */
  file?: string;
  /** `--skill`: only promote entries for one skill. */
  skill?: string;
  /** `--dry-run`: preview changes without writing. */
  dryRun?: boolean;
  /** `--prune`: remove promoted entries from the feedback JSONL log. */
  prune?: boolean;
}

/**
 * `skanvil feedback promote`: promotes `suggestedEvalCase` entries from `.skanvil-feedback.jsonl`
 * into target skill `evals.json` files.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code (`0`).
 */
export async function feedbackPromoteCommand(options: FeedbackPromoteCommandOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("feedback", options.json);
  const file = options.file ? path.resolve(options.file) : undefined;
  const result = await promoteFeedback(library, {
    file,
    skill: options.skill,
    dryRun: options.dryRun,
    prune: options.prune
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const prefix = result.dryRun ? "(dry run) " : "";
  for (const item of result.promoted) {
    out.print(`   + ${item.skill}/${item.id} -> ${item.file}`);
  }
  for (const entry of result.skipped) {
    out.warn(`   skipped line ${entry.line} (${entry.skill}): ${entry.reason}`);
  }
  if (result.invalidLines.length > 0) {
    out.warn(`${result.invalidLines.length} malformed line(s) in ${displayPath(result.file)} were ignored.`);
  }
  const pruneNote = result.prunedLines > 0 ? `; pruned ${result.prunedLines} line(s) from log` : "";
  out.success(`${prefix}Promoted ${result.promoted.length} case(s), skipped ${result.skipped.length}${pruneNote}.`);
  return 0;
}

/** Options of `skanvil feedback push`. */
export interface FeedbackPushCommandOptions extends CommonOptions {
  /** `--file`: path to feedback JSONL file. */
  file?: string;
  /** `--skill`: only push entries for one skill. */
  skill?: string;
  /** `--endpoint`: base URL of `skanvil-hub`. */
  endpoint?: string;
  /** `--api-key`: Bearer ingestion key. */
  apiKey?: string;
  /** `--dry-run`: preview redacted events without sending. */
  dryRun?: boolean;
  /** `false` with `--no-queue`: fail immediately instead of queueing offline. */
  queue?: boolean;
}

/**
 * `skanvil feedback push`: uploads sanitized feedback reports from `.skanvil-feedback.jsonl` to
 * a self-hosted `skanvil-hub` instance.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code (`0` on success/empty/queued; `1` on failed strict push with `--no-queue`).
 */
export async function feedbackPushCommand(options: FeedbackPushCommandOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("feedback", options.json);
  const file = options.file ? path.resolve(options.file) : undefined;
  const { events, invalidLines, file: logFile } = await buildFeedbackEvents(library, { file, skill: options.skill });
  const settings = resolveTelemetrySettings(library.config, {
    endpoint: options.endpoint,
    apiKey: options.apiKey
  });

  if (events.length === 0) {
    const empty = { file: logFile, sent: 0, queued: 0, invalidLines, events: [] };
    if (options.json) console.log(JSON.stringify(empty, null, 2));
    else out.info(`No feedback entries to push in ${displayPath(logFile)}.`);
    return 0;
  }

  const result = await sendTelemetryEvents(events, settings, {
    dryRun: options.dryRun,
    queueOnFailure: options.queue !== false,
    throwOnFailure: options.queue === false && !options.dryRun
  });

  if (options.json) {
    console.log(JSON.stringify({ file: logFile, invalidLines, ...result }, null, 2));
    return 0;
  }
  if (invalidLines.length > 0) {
    out.warn(`${invalidLines.length} malformed line(s) in ${displayPath(logFile)} were ignored.`);
  }
  if (result.skippedReason) {
    out.info(`Skipped feedback push (${result.skippedReason}).`);
    return 0;
  }
  if (result.dryRun) {
    out.info(`(dry run) ${events.length} redacted feedback event(s) ready to push.`);
    return 0;
  }
  if (result.queued > 0) {
    out.warn(`Queued ${result.queued} feedback event(s) to ${displayPath(settings.queueFile)} (${result.error}).`);
    return 0;
  }
  out.success(`Pushed ${result.sent} feedback event(s) to ${settings.endpoint}.`);
  return 0;
}
