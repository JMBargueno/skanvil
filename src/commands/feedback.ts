/**
 * CLI handlers for `skanvil feedback`: summarizing and promoting `.skanvil-feedback.jsonl` reports.
 *
 * Every handler returns the process exit code: 0 on success, 1 on failure.
 *
 * @module
 */
import path from "node:path";

import { promoteFeedback, summarizeFeedback } from "../core/feedback.js";
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
