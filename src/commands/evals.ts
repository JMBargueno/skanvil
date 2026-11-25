/**
 * CLI handlers for `skanvil eval`: offline trigger routing checks and evaluation dataset export.
 *
 * Every handler returns the process exit code: 0 on success, 1 on failure.
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  checkTriggerRouting,
  exportEvalDataset,
  routePrompt,
  type EvalExportFormat,
  type EvalSplit
} from "../core/evals.js";
import { Output } from "../util/output.js";
import { displayPath } from "../util/paths.js";
import { openLibrary, type CommonOptions } from "./shared.js";

/** Options of `skanvil eval triggers`. */
export interface EvalTriggersCommandOptions extends CommonOptions {
  /** `--skill`: only check triggers belonging to one skill. */
  skill?: string;
  /** `--split`: only check prompts tagged with `train` or `eval`. */
  split?: EvalSplit;
  /** `--strict`: exit 1 when any trigger check fails. */
  strict?: boolean;
}

/**
 * `skanvil eval triggers`: checks declared `shouldTrigger` / `shouldNotTrigger` prompts against
 * the library's descriptions using offline BM25 routing.
 *
 * @param options - Parsed CLI options.
 * @returns 1 when `strict` is set and any trigger check fails, otherwise 0.
 */
export async function evalTriggersCommand(options: EvalTriggersCommandOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("eval", options.json);
  const result = await checkTriggerRouting(library, { skill: options.skill, split: options.split });

  if (options.json) {
    console.log(JSON.stringify({ ok: result.failed === 0, ...result }, null, 2));
    return options.strict && result.failed > 0 ? 1 : 0;
  }

  if (result.total === 0) {
    out.info("No trigger prompts found in evals.json.");
    return 0;
  }

  for (const item of result.results) {
    if (item.passed) continue;
    const tag = item.split ? ` (${item.split})` : "";
    out.error(` - ${item.skill} [${item.kind}${tag}]: "${item.prompt}" -> ${item.reason}`);
  }

  const splits = (["train", "eval"] as const)
    .filter((key) => result.bySplit[key].total > 0)
    .map((key) => `${key}: ${result.bySplit[key].passed}/${result.bySplit[key].total}`);
  const splitNote = splits.length > 0 ? ` (${splits.join(", ")})` : "";

  if (result.failed === 0) {
    out.success(`Passed ${result.passed}/${result.total} trigger check(s)${splitNote}.`);
  } else {
    out.warn(`${result.failed} of ${result.total} trigger check(s) failed${splitNote}.`);
  }
  return options.strict && result.failed > 0 ? 1 : 0;
}

/** Options of `skanvil eval export`. */
export interface EvalExportCommandOptions {
  /** Library root (`-C, --cwd`). */
  cwd?: string;
  /** `--format`: `json` or `promptfoo`. */
  format?: EvalExportFormat;
  /** `--ablation`: include both `with-skill` and `without-skill` baseline variants. */
  ablation?: boolean;
  /** `--skill`: only export one skill. */
  skill?: string;
  /** `--split`: only export items tagged with `train` or `eval`. */
  split?: EvalSplit;
  /** `--out`: destination file (prints to stdout when omitted). */
  out?: string;
}

/**
 * `skanvil eval export`: exports golden cases and triggers as JSON or a Promptfoo test suite.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code (`0`).
 */
export async function evalExportCommand(options: EvalExportCommandOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("eval");
  const result = await exportEvalDataset(library, {
    format: options.format,
    ablation: options.ablation,
    skill: options.skill,
    split: options.split
  });

  if (options.out) {
    const destination = path.resolve(options.out);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, result.content, "utf8");
    out.success(
      `Exported ${result.caseCount} case(s) and ${result.triggerCount} trigger(s) from ${result.skillCount} skill(s) to ${displayPath(destination)} (${result.format}${result.ablation ? ", ablation" : ""}).`
    );
  } else {
    process.stdout.write(result.content);
  }
  return 0;
}

/** Options of `skanvil eval route`. */
export interface EvalRouteCommandOptions extends CommonOptions {
  /** `--top`: maximum matching skills to display (default: `5`). */
  top?: string | number;
}

/**
 * `skanvil eval route "<prompt>"`: simulates Stage-1 BM25 trigger routing for a user prompt.
 *
 * @param prompt - User prompt to test against skill descriptions.
 * @param options - Parsed CLI options.
 * @returns Exit code (`0`).
 */
export async function evalRouteCommand(prompt: string, options: EvalRouteCommandOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("eval", options.json);
  const top = options.top !== undefined ? Number(options.top) : undefined;
  const result = await routePrompt(library, prompt, { top });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (result.totalSkills === 0) {
    out.info("No routable skills found in the library.");
    return 0;
  }
  if (result.candidates.length === 0) {
    out.warn(
      `No lexical match among ${result.totalSkills} routable skill(s) for tokens: ${result.queryTokens.join(", ") || "(none)"}.`
    );
    return 0;
  }

  for (const candidate of result.candidates) {
    out.print(
      `  #${candidate.rank} ${candidate.skill} (score ${candidate.score.toFixed(2)}, matched: ${candidate.matchedTokens.join(", ")})`
    );
    if (candidate.description) {
      out.print(`     ${candidate.description}`);
    }
  }
  out.info(`Matched ${result.candidates.length} of ${result.totalSkills} routable skill(s).`);
  return 0;
}
