/**
 * Declarative evaluation suites (`evals.json`): schema parsing, offline BM25 trigger routing checks,
 * and dataset export (JSON and Promptfoo, with optional ablation variants).
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { Library } from "./library.js";
import { KEBAB_CASE_PATTERN } from "./naming.js";
import { type ParamValues } from "./params.js";
import type { SkillFile } from "./skill.js";
import { jaccardSimilarity, tokenizeForSimilarity } from "./text.js";

/** File declaring a skill's trigger prompts and evaluation cases, next to its `SKILL.md`. */
export const EVALS_FILE = "evals.json";

/** Allowed dataset split tags for avoiding prompt overfitting. */
export const EVAL_SPLITS = ["train", "eval"] as const;

/** Dataset split tag (`train` or `eval`). */
export type EvalSplit = (typeof EVAL_SPLITS)[number];

const TriggerItemSchema = z.union([
  z.string().min(1),
  z
    .object({
      prompt: z.string().min(1),
      split: z.enum(EVAL_SPLITS).optional(),
      note: z.string().optional()
    })
    .strict()
]);

const EvalCaseSchema = z
  .object({
    id: z.string().regex(KEBAB_CASE_PATTERN, "case id must be strict kebab-case"),
    prompt: z.string().min(1),
    params: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
    expected: z.array(z.string().min(1)).min(1),
    mustContain: z.array(z.string().min(1)).optional(),
    mustNotContain: z.array(z.string().min(1)).optional(),
    split: z.enum(EVAL_SPLITS).optional()
  })
  .strict();

/** Zod schema of `evals.json`. */
export const EvalsFileSchema = z
  .object({
    triggers: z
      .object({
        shouldTrigger: z.array(TriggerItemSchema).optional(),
        shouldNotTrigger: z.array(TriggerItemSchema).optional()
      })
      .strict()
      .optional(),
    cases: z.array(EvalCaseSchema).optional()
  })
  .strict();

/** Normalized trigger test prompt inside `evals.json`. */
export interface TriggerEntry {
  /** User prompt to route against the library's skill descriptions. */
  prompt: string;
  /** Optional split tag (`train` or `eval`). */
  split?: EvalSplit;
  /** Optional human note explaining why the prompt should or should not trigger. */
  note?: string;
}

/** One golden evaluation case in `evals.json`. */
export interface EvalCase {
  /** Kebab-case identifier, unique within the skill. */
  id: string;
  /** User prompt for the evaluation scenario. */
  prompt: string;
  /** Optional parameter overrides for parametrized skills (`params.json`). */
  params?: ParamValues;
  /** Expected outcomes / rubric criteria. */
  expected: string[];
  /** Substrings that must appear in the evaluated output. */
  mustContain?: string[];
  /** Substrings that must not appear in the evaluated output. */
  mustNotContain?: string[];
  /** Optional split tag (`train` or `eval`). */
  split?: EvalSplit;
}

/** Parsed and normalized `evals.json` content. */
export interface SkillEvals {
  /** Positive and negative trigger routing prompts. */
  triggers?: {
    shouldTrigger: TriggerEntry[];
    shouldNotTrigger: TriggerEntry[];
  };
  /** End-to-end golden evaluation cases. */
  cases?: EvalCase[];
}

function normalizeTrigger(entry: z.infer<typeof TriggerItemSchema>): TriggerEntry {
  if (typeof entry === "string") return { prompt: entry };
  return {
    prompt: entry.prompt,
    ...(entry.split ? { split: entry.split } : {}),
    ...(entry.note ? { note: entry.note } : {})
  };
}

/**
 * Parses and validates the content of an `evals.json` file.
 *
 * @param text - File content.
 * @returns Normalized evaluation definitions.
 * @throws Error when the JSON is invalid, fails {@link EvalsFileSchema}, or has duplicated case ids.
 */
export function parseEvals(text: string): SkillEvals {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${EVALS_FILE} is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = EvalsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`invalid ${EVALS_FILE}: ${issues.slice(0, 3).join("; ")}`);
  }

  const cases = parsed.data.cases;
  if (cases) {
    const seen = new Set<string>();
    for (const item of cases) {
      if (seen.has(item.id)) {
        throw new Error(`invalid ${EVALS_FILE}: duplicated case id '${item.id}'`);
      }
      seen.add(item.id);
    }
  }

  return {
    ...(parsed.data.triggers
      ? {
          triggers: {
            shouldTrigger: (parsed.data.triggers.shouldTrigger ?? []).map(normalizeTrigger),
            shouldNotTrigger: (parsed.data.triggers.shouldNotTrigger ?? []).map(normalizeTrigger)
          }
        }
      : {}),
    ...(cases ? { cases } : {})
  };
}

/**
 * Reads and validates a skill folder's `evals.json`.
 *
 * @param skillDir - Absolute skill folder.
 * @returns The parsed definitions, or `null` when the skill has no `evals.json`.
 * @throws Error when `evals.json` exists but is invalid (see {@link parseEvals}).
 */
export async function readEvals(skillDir: string): Promise<SkillEvals | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(skillDir, EVALS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseEvals(text);
}

/** Options of {@link checkTriggerRouting}. */
export interface TriggerCheckOptions {
  /** Only check triggers defined on this skill folder. */
  skill?: string;
  /** Only check prompts belonging to this split (`train` or `eval`). */
  split?: EvalSplit;
}

/** Outcome of evaluating one trigger prompt against the library catalog. */
export interface TriggerCheckItem {
  /** Skill that owns the trigger entry. */
  skill: string;
  /** Positive (`shouldTrigger`) or negative (`shouldNotTrigger`) expectation. */
  kind: "shouldTrigger" | "shouldNotTrigger";
  /** Evaluated prompt text. */
  prompt: string;
  /** Split tag, if declared on the trigger entry. */
  split?: EvalSplit;
  /** Whether the routing check passed. */
  passed: boolean;
  /** 1-based BM25 rank of the owning skill (`null` when score is 0 or skill is not routable). */
  expectedRank: number | null;
  /** Highest-scoring skill for this prompt (`null` when all scores are 0). */
  topSkill: string | null;
  /** BM25 score of `topSkill`. */
  topScore: number;
  /** BM25 score of the owning skill. */
  targetScore: number;
  /** Human-readable explanation when `passed` is `false`. */
  reason?: string;
}

/** Split-level pass/fail counters. */
export interface SplitSummary {
  total: number;
  passed: number;
  failed: number;
}

/** Result of {@link checkTriggerRouting}. */
export interface TriggerCheckResult {
  total: number;
  passed: number;
  failed: number;
  bySplit: Record<EvalSplit | "unspecified", SplitSummary>;
  results: TriggerCheckItem[];
}

interface IndexedSkillDoc {
  name: string;
  description: string;
  tokens: string[];
  tf: Map<string, number>;
  length: number;
}

async function indexRoutableSkills(
  library: Library,
  options: { evalsSkill?: string; loadEvals?: boolean } = {}
): Promise<{ docs: IndexedSkillDoc[]; evalsBySkill: Map<string, SkillEvals> }> {
  const folders = await library.listSkillFolders();
  const docs: IndexedSkillDoc[] = [];
  const evalsBySkill = new Map<string, SkillEvals>();

  for (const folder of folders) {
    const category = library.categories.fromFolder(folder);
    if (!category.validated || !(await library.hasSkill(folder))) continue;

    let skill: SkillFile;
    try {
      skill = await library.readSkillRendered(folder);
    } catch {
      skill = await library.readSkill(folder);
    }

    if (options.loadEvals) {
      const evals = await library.readSkillEvals(folder);
      if (evals && (!options.evalsSkill || options.evalsSkill === folder)) {
        evalsBySkill.set(folder, evals);
      }
    }

    if (skill.getString("metadata", "status") === "deprecated") continue;
    const effectiveName = skill.getString("name") || folder;
    const description = skill.getString("description");
    const tokens = tokenizeForSimilarity(`${effectiveName.replace(/-/g, " ")} ${description}`);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    docs.push({ name: folder, description, tokens, tf, length: tokens.length });
  }

  return { docs, evalsBySkill };
}

function assertValidSplit(split: string | undefined): asserts split is EvalSplit | undefined {
  if (split !== undefined && split !== "train" && split !== "eval") {
    throw new Error(`Invalid split '${split}'. Allowed values: train, eval.`);
  }
}

function buildBm25Index(docs: IndexedSkillDoc[]) {
  const N = docs.length;
  const avgdl = N > 0 ? docs.reduce((sum, doc) => sum + doc.length, 0) / N : 0;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set(doc.tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const k1 = 1.5;
  const b = 0.75;

  return (doc: IndexedSkillDoc, queryTokens: readonly string[]): number => {
    if (N === 0 || doc.length === 0) return 0;
    let score = 0;
    for (const token of queryTokens) {
      const tf = doc.tf.get(token) ?? 0;
      if (tf === 0) continue;
      const docFreq = df.get(token) ?? 0;
      // Non-negative Lucene-style IDF ensures small libraries (N=1..2) keep positive weights.
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      const denom = tf + k1 * (1 - b + b * (doc.length / (avgdl || 1)));
      score += idf * ((tf * (k1 + 1)) / denom);
    }
    return score;
  };
}

/**
 * Evaluates declared trigger prompts (`shouldTrigger` / `shouldNotTrigger`) across the library
 * using an offline Okapi BM25 lexical scorer over Stage-1 metadata (`name` + `description`).
 *
 * @remarks This catches missing keywords and inter-skill routing collisions deterministically with
 * zero network calls or LLM dependencies.
 *
 * @param library - Library to test.
 * @param options - Optional skill or split filter.
 * @returns Per-prompt routing diagnostics and split summaries.
 * @throws Error when `skill` does not exist, `split` is invalid, or an `evals.json` is malformed.
 */
export async function checkTriggerRouting(
  library: Library,
  options: TriggerCheckOptions = {}
): Promise<TriggerCheckResult> {
  if (options.skill) await library.requireSkill(options.skill);
  assertValidSplit(options.split);

  const { docs, evalsBySkill } = await indexRoutableSkills(library, {
    evalsSkill: options.skill,
    loadEvals: true
  });

  const scoreDoc = buildBm25Index(docs);
  const docByName = new Map(docs.map((doc) => [doc.name, doc]));
  const results: TriggerCheckItem[] = [];

  for (const [skillName, evals] of evalsBySkill) {
    const triggers = evals.triggers;
    if (!triggers) continue;

    const entries: { kind: "shouldTrigger" | "shouldNotTrigger"; entry: TriggerEntry }[] = [
      ...triggers.shouldTrigger.map((entry) => ({ kind: "shouldTrigger" as const, entry })),
      ...triggers.shouldNotTrigger.map((entry) => ({ kind: "shouldNotTrigger" as const, entry }))
    ];

    for (const { kind, entry } of entries) {
      if (options.split && entry.split !== options.split) continue;

      const queryTokens = tokenizeForSimilarity(entry.prompt);
      const scored = docs
        .map((doc) => ({ name: doc.name, score: scoreDoc(doc, queryTokens) }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

      const targetDoc = docByName.get(skillName);
      const targetScore = targetDoc ? scoreDoc(targetDoc, queryTokens) : 0;
      const topScore = scored[0]?.score ?? 0;
      const strictlyHigher = scored.filter((item) => item.score > targetScore);
      const tiedOthers = scored.filter((item) => item.name !== skillName && item.score === targetScore);
      const expectedRank = targetDoc && targetScore > 0 ? strictlyHigher.length + 1 : null;

      let topSkill: string | null = topScore > 0 ? scored[0].name : null;
      let passed = true;
      let reason: string | undefined;

      if (kind === "shouldTrigger") {
        if (!targetDoc) {
          passed = false;
          reason = "skill is deprecated or not routable";
        } else if (targetScore <= 0) {
          passed = false;
          reason = "no lexical match between prompt and skill name/description";
        } else if (strictlyHigher.length > 0) {
          passed = false;
          topSkill = strictlyHigher[0].name;
          reason = `ranked #${expectedRank} behind '${strictlyHigher[0].name}' (score ${strictlyHigher[0].score.toFixed(2)} vs ${targetScore.toFixed(2)})`;
        } else if (tiedOthers.length > 0) {
          passed = false;
          topSkill = tiedOthers[0].name;
          reason = `tied for #1 with '${tiedOthers[0].name}' (score ${targetScore.toFixed(2)})`;
        }
      } else if (targetDoc && targetScore > 0) {
        if (docs.length === 1) {
          const overlap = jaccardSimilarity(queryTokens, targetDoc.tokens);
          if (overlap >= 0.25) {
            passed = false;
            topSkill = skillName;
            reason = `matched single routable skill in library (${Math.round(overlap * 100)}% lexical overlap)`;
          }
        } else if (strictlyHigher.length === 0) {
          passed = false;
          topSkill = skillName;
          reason = `ranked #1 (score ${targetScore.toFixed(2)}) on a negative trigger prompt`;
        }
      }

      results.push({
        skill: skillName,
        kind,
        prompt: entry.prompt,
        ...(entry.split ? { split: entry.split } : {}),
        passed,
        expectedRank,
        topSkill,
        topScore: Number(topScore.toFixed(4)),
        targetScore: Number(targetScore.toFixed(4)),
        ...(reason ? { reason } : {})
      });
    }
  }

  const bySplit: Record<EvalSplit | "unspecified", SplitSummary> = {
    train: { total: 0, passed: 0, failed: 0 },
    eval: { total: 0, passed: 0, failed: 0 },
    unspecified: { total: 0, passed: 0, failed: 0 }
  };
  for (const item of results) {
    const bucket = bySplit[item.split ?? "unspecified"];
    bucket.total += 1;
    if (item.passed) bucket.passed += 1;
    else bucket.failed += 1;
  }

  const passed = results.filter((item) => item.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    bySplit,
    results
  };
}

/** Options of {@link routePrompt}. */
export interface RoutePromptOptions {
  /** Maximum number of matching candidate skills to return. @defaultValue `5` */
  top?: number;
}

/** Ranked skill match returned by {@link routePrompt}. */
export interface RouteCandidate {
  /** Matched skill folder name. */
  skill: string;
  /** 1-based rank among matching skills. */
  rank: number;
  /** Offline Okapi BM25 relevance score. */
  score: number;
  /** Normalized query tokens matched in the skill's Stage-1 metadata (`name` + `description`). */
  matchedTokens: string[];
  /** Stage-1 description of the skill. */
  description: string;
}

/** Result of {@link routePrompt}. */
export interface RoutePromptResult {
  /** Original prompt tested. */
  prompt: string;
  /** Unique normalized lexical tokens extracted from `prompt`. */
  queryTokens: string[];
  /** Number of routable (validated, non-deprecated) skills indexed in the library. */
  totalSkills: number;
  /** Ranked matching skills (`score > 0`), up to `top`. */
  candidates: RouteCandidate[];
}

/**
 * Simulates Stage-1 prompt routing across all validated, non-deprecated skills in a library
 * using the offline Okapi BM25 scorer over `name` and `description`.
 *
 * @param library - Library to route against.
 * @param prompt - Free-form user prompt to test.
 * @param options - Optional candidate limit (`top`).
 * @returns Extracted query tokens and top-ranked matching skills.
 * @throws Error when `prompt` is empty or `top` is not a positive integer.
 *
 * @example
 * ```ts
 * const routing = await routePrompt(lib, "Review React hooks and CSS accessibility", { top: 3 });
 * console.log(routing.candidates[0]?.skill);
 * ```
 */
export async function routePrompt(
  library: Library,
  prompt: string,
  options: RoutePromptOptions = {}
): Promise<RoutePromptResult> {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("Prompt cannot be empty.");
  }
  const top = options.top ?? 5;
  if (!Number.isInteger(top) || top < 1) {
    throw new Error("Option --top must be a positive integer.");
  }

  const queryTokens = tokenizeForSimilarity(prompt);
  const uniqueQueryTokens = [...new Set(queryTokens)];
  const { docs } = await indexRoutableSkills(library);
  const scoreDoc = buildBm25Index(docs);

  const candidates = docs
    .map((doc) => {
      const rawScore = scoreDoc(doc, queryTokens);
      return {
        skill: doc.name,
        rawScore,
        score: Number(rawScore.toFixed(4)),
        matchedTokens: uniqueQueryTokens.filter((token) => doc.tf.has(token)),
        description: doc.description
      };
    })
    .filter((entry) => entry.rawScore > 0)
    .sort((a, b) => b.rawScore - a.rawScore || a.skill.localeCompare(b.skill))
    .slice(0, top)
    .map((entry, index) => ({
      skill: entry.skill,
      rank: index + 1,
      score: entry.score,
      matchedTokens: entry.matchedTokens,
      description: entry.description
    }));

  return {
    prompt,
    queryTokens: uniqueQueryTokens,
    totalSkills: docs.length,
    candidates
  };
}

/** Supported export formats for {@link exportEvalDataset}. */
export type EvalExportFormat = "json" | "promptfoo";

/** Options of {@link exportEvalDataset}. */
export interface ExportEvalOptions {
  /** Output format (`json` or `promptfoo`). @defaultValue `"json"` */
  format?: EvalExportFormat;
  /** Include both `with-skill` and `without-skill` baseline variants for blind A/B ablation. @defaultValue `false` */
  ablation?: boolean;
  /** Export only this skill folder. */
  skill?: string;
  /** Export only items tagged with this split (`train` or `eval`). */
  split?: EvalSplit;
}

/** Result of {@link exportEvalDataset}. */
export interface ExportEvalResult {
  format: EvalExportFormat;
  ablation: boolean;
  skillCount: number;
  caseCount: number;
  triggerCount: number;
  /** Serialized JSON payload ready to write to disk or stdout. */
  content: string;
}

/**
 * Exports golden evaluation cases and triggers for external LLM runners such as Promptfoo.
 *
 * With `ablation: true`, every exported case pairs a `with-skill` variant (rendered `SKILL.md`)
 * against a `without-skill` baseline for blind judge evaluation.
 *
 * @param library - Source library.
 * @param options - Export format, ablation flag, and filters.
 * @returns Serialized evaluation dataset and counts.
 * @throws Error when `format` or `split` is invalid, `skill` is unknown, or `evals.json` / `params.json` is malformed.
 */
export async function exportEvalDataset(library: Library, options: ExportEvalOptions = {}): Promise<ExportEvalResult> {
  const format = options.format ?? "json";
  if (format !== "json" && format !== "promptfoo") {
    throw new Error(`Invalid eval export format '${format}'. Use 'json' or 'promptfoo'.`);
  }
  const ablation = Boolean(options.ablation);
  if (options.skill) await library.requireSkill(options.skill);
  assertValidSplit(options.split);

  const folders = await library.listSkillFolders();
  const exportedSkills = new Set<string>();
  const jsonCases: Record<string, unknown>[] = [];
  const jsonTriggers: Record<string, unknown>[] = [];
  const promptfooTests: Record<string, unknown>[] = [];

  for (const folder of folders) {
    const category = library.categories.fromFolder(folder);
    if (!category.validated || !(await library.hasSkill(folder))) continue;
    if (options.skill && folder !== options.skill) continue;

    const evals = await library.readSkillEvals(folder);
    if (!evals) continue;

    if (evals.triggers) {
      for (const entry of evals.triggers.shouldTrigger) {
        if (options.split && entry.split !== options.split) continue;
        exportedSkills.add(folder);
        jsonTriggers.push({ skill: folder, kind: "shouldTrigger", ...entry });
      }
      for (const entry of evals.triggers.shouldNotTrigger) {
        if (options.split && entry.split !== options.split) continue;
        exportedSkills.add(folder);
        jsonTriggers.push({ skill: folder, kind: "shouldNotTrigger", ...entry });
      }
    }

    for (const testCase of evals.cases ?? []) {
      if (options.split && testCase.split !== options.split) continue;
      exportedSkills.add(folder);
      const renderedSkill = (await library.readSkillRendered(folder, testCase.params ?? {})).toLfString();

      jsonCases.push({
        skill: folder,
        id: testCase.id,
        ...(testCase.split ? { split: testCase.split } : {}),
        ...(testCase.params ? { params: testCase.params } : {}),
        prompt: testCase.prompt,
        expected: testCase.expected,
        ...(testCase.mustContain ? { mustContain: testCase.mustContain } : {}),
        ...(testCase.mustNotContain ? { mustNotContain: testCase.mustNotContain } : {}),
        ...(ablation
          ? {
              variants: [
                { id: "with-skill", systemPrompt: renderedSkill },
                { id: "without-skill", systemPrompt: null }
              ]
            }
          : { skillContent: renderedSkill })
      });

      promptfooTests.push({
        description: `${folder}/${testCase.id}`,
        vars: {
          skill: folder,
          caseId: testCase.id,
          ...(testCase.split ? { split: testCase.split } : {}),
          prompt: testCase.prompt,
          skillContent: renderedSkill
        },
        assert: [
          ...testCase.expected.map((value) => ({ type: "llm-rubric", value })),
          ...(testCase.mustContain ?? []).map((value) => ({ type: "icontains", value })),
          ...(testCase.mustNotContain ?? []).map((value) => ({ type: "not-icontains", value }))
        ]
      });
    }
  }

  const payload =
    format === "promptfoo"
      ? {
          description: `${library.config.name ?? path.basename(library.root)} skill evaluation dataset`,
          prompts: ablation
            ? [
                {
                  id: "with-skill",
                  label: "With skill",
                  raw: "{{skillContent}}\n\n---\n\nUser request: {{prompt}}"
                },
                {
                  id: "without-skill",
                  label: "Baseline (without skill)",
                  raw: "User request: {{prompt}}"
                }
              ]
            : [
                {
                  id: "with-skill",
                  label: "With skill",
                  raw: "{{skillContent}}\n\n---\n\nUser request: {{prompt}}"
                }
              ],
          tests: promptfooTests
        }
      : {
          version: 1,
          ablation,
          triggers: jsonTriggers,
          cases: jsonCases
        };

  return {
    format,
    ablation,
    skillCount: exportedSkills.size,
    caseCount: jsonCases.length,
    triggerCount: jsonTriggers.length,
    content: `${JSON.stringify(payload, null, 2)}\n`
  };
}
