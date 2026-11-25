/**
 * Execution friction log parsing and promotion of `suggestedEvalCase` entries into `evals.json`.
 *
 * Reads `.skanvil-feedback.jsonl` produced by the `skanvil-feedback` agent skill, groups duplicate
 * symptoms, and promotes validated evaluation cases into target skill suites.
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";

import { fromLf, splitEol } from "../util/eol.js";
import { parseEvals, type EvalCase, type EvalSplit, type SkillEvals } from "./evals.js";
import { toLibrary, type LibraryRef } from "./skills.js";
import { resolveParamValues, type ParamValues } from "./params.js";

/** Default JSONL file where agents log skill execution friction reports. */
export const FEEDBACK_FILE = ".skanvil-feedback.jsonl";

/** Candidate evaluation case proposed inside a feedback log entry. */
export interface FeedbackSuggestedEvalCase {
  /** Kebab-case identifier for `evals.json`. */
  id: string;
  /** User prompt reproducing the reported scenario. */
  prompt: string;
  /** One or more rubric expectations. */
  expected: string | string[];
  /** Optional parameter values for parametrized skills (`params.json`). */
  params?: ParamValues;
  /** Optional required substrings. */
  mustContain?: string[];
  /** Optional forbidden substrings. */
  mustNotContain?: string[];
  /** Optional dataset split tag (`train` or `eval`). */
  split?: EvalSplit;
}

/** One valid parsed entry from `.skanvil-feedback.jsonl`. */
export interface FeedbackEntry {
  /** ISO-8601 timestamp recorded by the agent, when present. */
  timestamp?: string;
  /** Skill folder name that caused the friction. */
  skill: string;
  /** Step number or section heading involved. */
  step: string;
  /** Concise description of the observed failure or confusion. */
  symptom: string;
  /** Concrete fix proposed by the agent, when present. */
  proposedFix?: string;
  /** Optional regression test case candidate for `evals.json`. */
  suggestedEvalCase?: FeedbackSuggestedEvalCase;
  /** 1-based line number inside the source JSONL file. */
  rawLine?: number;
}

/** Malformed or schema-invalid line encountered while reading a feedback log. */
export interface InvalidFeedbackLine {
  /** 1-based line number. */
  line: number;
  /** Raw text of the offending line. */
  raw: string;
  /** Human-readable parse or validation error. */
  error: string;
}

/** Outcome of {@link readFeedbackLog}. */
export interface FeedbackReadResult {
  /** Resolved path of the JSONL file. */
  file: string;
  /** Successfully parsed feedback entries. */
  entries: FeedbackEntry[];
  /** Lines that could not be parsed or missed required fields. */
  invalidLines: InvalidFeedbackLine[];
}

/** Aggregated group of friction reports sharing `(skill, step, symptom)`. */
export interface FeedbackGroup {
  /** Skill folder name. */
  skill: string;
  /** Normalized representative step string. */
  step: string;
  /** Normalized representative symptom string. */
  symptom: string;
  /** Number of log entries in this group. */
  count: number;
  /** Most recent ISO timestamp among grouped entries, when any. */
  latestTimestamp?: string;
  /** Unique proposed fixes collected across occurrences. */
  proposedFixes: string[];
  /** Count of grouped entries carrying a `suggestedEvalCase`. */
  suggestedEvalCases: number;
}

/** Options of {@link summarizeFeedback}. */
export interface SummarizeFeedbackOptions {
  /** JSONL log path (relative paths resolve against the library root). @defaultValue `".skanvil-feedback.jsonl"` */
  file?: string;
  /** Only include entries for this skill folder. */
  skill?: string;
}

/** Result of {@link summarizeFeedback}. */
export interface FeedbackSummary {
  /** Resolved path of the JSONL file. */
  file: string;
  /** Total valid matching entries. */
  totalEntries: number;
  /** Number of grouped unique issues. */
  uniqueGroups: number;
  /** Malformed lines encountered while reading the log. */
  invalidLines: InvalidFeedbackLine[];
  /** Grouped friction reports ordered by count descending, then skill name. */
  groups: FeedbackGroup[];
}

/** Options of {@link promoteFeedback}. */
export interface PromoteFeedbackOptions {
  /** JSONL log path (relative paths resolve against the library root). @defaultValue `".skanvil-feedback.jsonl"` */
  file?: string;
  /** Only promote entries for this skill folder. */
  skill?: string;
  /** Preview promotions without modifying `evals.json` or the feedback log. @defaultValue `false` */
  dryRun?: boolean;
  /** Remove promoted lines from the JSONL log while keeping skipped/other/invalid lines intact. @defaultValue `false` */
  prune?: boolean;
}

/** One evaluation case promoted into `evals.json`. */
export interface PromotedCase {
  /** Owning skill folder. */
  skill: string;
  /** Case identifier added to `evals.json`. */
  id: string;
  /** Triggering evaluation prompt. */
  prompt: string;
  /** Relative posix path of the updated `evals.json`. */
  file: string;
}

/** One log entry skipped during {@link promoteFeedback}. */
export interface SkippedFeedback {
  /** 1-based line number in the JSONL file. */
  line: number;
  /** Skill folder named in the entry. */
  skill: string;
  /** Reason the entry was not promoted. */
  reason: string;
}

/** Result of {@link promoteFeedback}. */
export interface PromoteFeedbackResult {
  /** Resolved path of the JSONL file. */
  file: string;
  /** Whether writes were skipped. */
  dryRun: boolean;
  /** Cases added (or planned in `dryRun`) into skill `evals.json` files. */
  promoted: PromotedCase[];
  /** Matching entries skipped with reasons. */
  skipped: SkippedFeedback[];
  /** Malformed lines preserved in the log. */
  invalidLines: InvalidFeedbackLine[];
  /** Number of lines removed from the JSONL file (`0` when `dryRun` or `prune` is false). */
  prunedLines: number;
}

interface ParsedFeedbackFile extends FeedbackReadResult {
  exists: boolean;
  eol: "\n" | "\r\n";
  lines: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTextKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveFeedbackPath(baseDir: string, file?: string): string {
  return path.resolve(baseDir, file || FEEDBACK_FILE);
}

async function parseFeedbackFile(filePath: string): Promise<ParsedFeedbackFile> {
  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { file: resolved, exists: false, eol: "\n", lines: [], entries: [], invalidLines: [] };
    }
    throw error;
  }

  const { text, eol } = splitEol(raw);
  const lines = text.split("\n");
  const entries: FeedbackEntry[] = [];
  const invalidLines: InvalidFeedbackLine[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    if (!lineText.trim()) continue;
    const lineNumber = i + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(lineText);
    } catch (error) {
      invalidLines.push({ line: lineNumber, raw: lineText, error: (error as Error).message });
      continue;
    }

    if (!isPlainObject(parsed)) {
      invalidLines.push({ line: lineNumber, raw: lineText, error: "entry must be a JSON object" });
      continue;
    }

    const skill = typeof parsed.skill === "string" ? parsed.skill.trim() : "";
    const step = typeof parsed.step === "string" ? parsed.step.trim() : "";
    const symptom = typeof parsed.symptom === "string" ? parsed.symptom.trim() : "";
    if (!skill || !step || !symptom) {
      invalidLines.push({
        line: lineNumber,
        raw: lineText,
        error: "missing required non-empty string field(s): skill, step, symptom"
      });
      continue;
    }

    const entry: FeedbackEntry = { skill, step, symptom, rawLine: lineNumber };
    if (typeof parsed.timestamp === "string" && parsed.timestamp.trim()) {
      entry.timestamp = parsed.timestamp.trim();
    }
    if (typeof parsed.proposedFix === "string" && parsed.proposedFix.trim()) {
      entry.proposedFix = parsed.proposedFix.trim();
    }
    if (parsed.suggestedEvalCase !== undefined) {
      entry.suggestedEvalCase = parsed.suggestedEvalCase as FeedbackSuggestedEvalCase;
    }
    entries.push(entry);
  }

  return { file: resolved, exists: true, eol, lines, entries, invalidLines };
}

/**
 * Reads and parses a `.skanvil-feedback.jsonl` log file without aborting on malformed lines.
 *
 * @param filePath - Path to the JSONL log file.
 * @returns Parsed entries and line-level parse diagnostics. Missing files return empty arrays.
 * @throws Error when an existing file cannot be read due to I/O permissions.
 *
 * @example
 * ```ts
 * const log = await readFeedbackLog("./.skanvil-feedback.jsonl");
 * console.log(log.entries.length, log.invalidLines.length);
 * ```
 */
export async function readFeedbackLog(filePath: string): Promise<FeedbackReadResult> {
  const parsed = await parseFeedbackFile(filePath);
  return { file: parsed.file, entries: parsed.entries, invalidLines: parsed.invalidLines };
}

/**
 * Summarizes and deduplicates agent friction reports from `.skanvil-feedback.jsonl`.
 *
 * Entries sharing the same normalized `(skill, step, symptom)` tuple are grouped together with
 * occurrence counts, latest timestamps, and unique proposed fixes.
 *
 * @param ref - Library or library root.
 * @param options - Optional log file override and skill filter.
 * @returns Aggregated feedback summary.
 * @throws Error when the library cannot be opened or the log file cannot be read.
 *
 * @example
 * ```ts
 * const summary = await summarizeFeedback("./my-skills");
 * for (const group of summary.groups) console.log(group.skill, group.count, group.symptom);
 * ```
 */
export async function summarizeFeedback(
  ref: LibraryRef,
  options: SummarizeFeedbackOptions = {}
): Promise<FeedbackSummary> {
  const library = await toLibrary(ref);
  const parsed = await parseFeedbackFile(resolveFeedbackPath(library.root, options.file));
  const filtered = options.skill ? parsed.entries.filter((entry) => entry.skill === options.skill) : parsed.entries;

  const grouped = new Map<string, FeedbackGroup & { fixSet: Set<string> }>();
  for (const entry of filtered) {
    const key = `${entry.skill}\0${normalizeTextKey(entry.step)}\0${normalizeTextKey(entry.symptom)}`;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = {
        skill: entry.skill,
        step: entry.step,
        symptom: entry.symptom,
        count: 0,
        proposedFixes: [],
        suggestedEvalCases: 0,
        fixSet: new Set()
      };
      grouped.set(key, bucket);
    }
    bucket.count += 1;
    if (entry.timestamp && (!bucket.latestTimestamp || entry.timestamp > bucket.latestTimestamp)) {
      bucket.latestTimestamp = entry.timestamp;
    }
    if (entry.proposedFix && !bucket.fixSet.has(entry.proposedFix)) {
      bucket.fixSet.add(entry.proposedFix);
      bucket.proposedFixes.push(entry.proposedFix);
    }
    if (entry.suggestedEvalCase !== undefined) {
      bucket.suggestedEvalCases += 1;
    }
  }

  const groups: FeedbackGroup[] = [...grouped.values()]
    .map(({ fixSet: _fixSet, ...rest }) => rest)
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill) || a.step.localeCompare(b.step));

  return {
    file: parsed.file,
    totalEntries: filtered.length,
    uniqueGroups: groups.length,
    invalidLines: parsed.invalidLines,
    groups
  };
}

function normalizeCandidateCase(raw: unknown): EvalCase {
  if (!isPlainObject(raw)) {
    throw new Error("suggestedEvalCase must be a JSON object");
  }
  const expected = typeof raw.expected === "string" ? (raw.expected.trim() ? [raw.expected.trim()] : []) : raw.expected;
  const candidate = { ...raw, expected };
  const parsed = parseEvals(JSON.stringify({ cases: [candidate] }));
  return parsed.cases![0];
}

/**
 * Promotes validated `suggestedEvalCase` entries from `.skanvil-feedback.jsonl` into each
 * skill's `evals.json` suite, creating `evals.json` when absent and avoiding duplicate cases.
 *
 * @remarks
 * - Validates every target skill's existing `evals.json`, `params.json`, and all candidate cases
 *   before writing any file to disk.
 * - Rolls back touched `evals.json` files if a write fails mid-batch.
 * - With `prune: true`, removes only the lines that were promoted, keeping skipped, malformed,
 *   and other skills' entries untouched.
 *
 * @param ref - Library or library root.
 * @param options - Log path, skill filter, `dryRun` and `prune` switches.
 * @returns Promoted cases, skipped entries with reasons, invalid log lines, and pruned line count.
 * @throws Error when an existing `evals.json` or `params.json` is malformed or writing fails.
 *
 * @example
 * ```ts
 * const result = await promoteFeedback("./my-skills", { prune: true });
 * console.log(`Promoted ${result.promoted.length} regression case(s).`);
 * ```
 */
export async function promoteFeedback(
  ref: LibraryRef,
  options: PromoteFeedbackOptions = {}
): Promise<PromoteFeedbackResult> {
  const library = await toLibrary(ref);
  const parsed = await parseFeedbackFile(resolveFeedbackPath(library.root, options.file));
  const dryRun = Boolean(options.dryRun);
  const prune = Boolean(options.prune);

  const promoted: PromotedCase[] = [];
  const skipped: SkippedFeedback[] = [];
  const promotedLines = new Set<number>();

  // Cache existing evals.json and params.json per skill so malformed files abort before writes.
  const skillStateCache = new Map<
    string,
    {
      evals: SkillEvals;
      params: Awaited<ReturnType<typeof library.readSkillParams>>;
      seenIds: Set<string>;
      seenPrompts: Set<string>;
      modified: boolean;
    }
  >();

  for (const entry of parsed.entries) {
    if (options.skill && entry.skill !== options.skill) continue;
    const line = entry.rawLine ?? 0;

    if (entry.suggestedEvalCase === undefined) {
      skipped.push({ line, skill: entry.skill, reason: "no suggestedEvalCase" });
      continue;
    }

    if (!(await library.hasSkill(entry.skill))) {
      skipped.push({ line, skill: entry.skill, reason: "skill not found in library" });
      continue;
    }

    let state = skillStateCache.get(entry.skill);
    if (!state) {
      const existingEvals = (await library.readSkillEvals(entry.skill)) ?? {};
      const existingCases = existingEvals.cases ?? [];
      const params = await library.readSkillParams(entry.skill);
      state = {
        evals: {
          ...(existingEvals.triggers ? { triggers: existingEvals.triggers } : {}),
          cases: [...existingCases]
        },
        params,
        seenIds: new Set(existingCases.map((item) => item.id)),
        seenPrompts: new Set(existingCases.map((item) => normalizeTextKey(item.prompt))),
        modified: false
      };
      skillStateCache.set(entry.skill, state);
    }

    let candidate: EvalCase;
    try {
      candidate = normalizeCandidateCase(entry.suggestedEvalCase);
      if (candidate.params) {
        resolveParamValues(state.params ?? {}, candidate.params, `${entry.skill} (feedback line ${line})`);
      }
    } catch (error) {
      skipped.push({ line, skill: entry.skill, reason: (error as Error).message });
      continue;
    }

    if (state.seenIds.has(candidate.id)) {
      skipped.push({ line, skill: entry.skill, reason: `duplicate case id '${candidate.id}'` });
      continue;
    }
    const promptKey = normalizeTextKey(candidate.prompt);
    if (state.seenPrompts.has(promptKey)) {
      skipped.push({ line, skill: entry.skill, reason: `duplicate prompt for case '${candidate.id}'` });
      continue;
    }

    state.evals.cases!.push(candidate);
    state.seenIds.add(candidate.id);
    state.seenPrompts.add(promptKey);
    state.modified = true;

    promoted.push({
      skill: entry.skill,
      id: candidate.id,
      prompt: candidate.prompt,
      file: `${library.skillsDirRef}/${entry.skill}/evals.json`
    });
    if (line > 0) promotedLines.add(line);
  }

  let prunedLines = 0;
  if (!dryRun) {
    const writes: { targetPath: string; nextContent: string; previousContent: string | null }[] = [];
    for (const [skillName, state] of skillStateCache) {
      if (!state.modified) continue;
      const targetPath = path.join(library.skillPath(skillName), "evals.json");
      let previousContent: string | null = null;
      try {
        previousContent = await fs.readFile(targetPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      writes.push({
        targetPath,
        nextContent: `${JSON.stringify(state.evals, null, 2)}\n`,
        previousContent
      });
    }

    const written: { targetPath: string; previousContent: string | null }[] = [];
    try {
      for (const write of writes) {
        await fs.writeFile(write.targetPath, write.nextContent, "utf8");
        written.push({ targetPath: write.targetPath, previousContent: write.previousContent });
      }
      if (prune && parsed.exists && promotedLines.size > 0) {
        const remaining = parsed.lines.filter((_, index) => !promotedLines.has(index + 1));
        prunedLines = promotedLines.size;
        const body = remaining.filter((line) => line.trim() !== "").join("\n");
        const output = body ? `${body}\n` : "";
        await fs.writeFile(parsed.file, fromLf(output, parsed.eol), "utf8");
      }
    } catch (error) {
      for (const entry of written) {
        if (entry.previousContent === null) {
          await fs.rm(entry.targetPath, { force: true }).catch(() => undefined);
        } else {
          await fs.writeFile(entry.targetPath, entry.previousContent, "utf8").catch(() => undefined);
        }
      }
      throw new Error(`Promote failed and was rolled back: ${(error as Error).message}`);
    }
  }

  return {
    file: parsed.file,
    dryRun,
    promoted,
    skipped,
    invalidLines: parsed.invalidLines,
    prunedLines
  };
}
