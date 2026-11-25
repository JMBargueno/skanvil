/**
 * `skanvil diff`: compares the working library against a Git ref to measure Stage-1 token deltas,
 * parameter schema changes, new validation diagnostics, and offline trigger routing regressions.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { listFiles } from "../util/fs.js";
import { checkTriggerRouting } from "./evals.js";
import { Library } from "./library.js";
import type { ParamDefinitions } from "./params.js";
import { toLibrary, type LibraryRef } from "./skills.js";
import { analyzeLibraryStats } from "./stats.js";
import { validateLibrary, type DiagnosticSeverity } from "./validate.js";

const execFileAsync = promisify(execFile);

/** Options of {@link diffLibrary}. */
export interface DiffOptions {
  /** Git ref to compare against (for example `HEAD`, `origin/main`, or a commit/tag). @defaultValue `"HEAD"` */
  baseRef?: string;
}

/** Per-skill change summary inside {@link LibraryDiffResult}. */
export interface SkillDiffEntry {
  /** Skill folder name. */
  skill: string;
  /** Change status compared to `baseRef`. */
  status: "added" | "removed" | "modified";
  /** Estimated Stage-1 always-loaded tokens at `baseRef` (`0` when newly added). */
  baseStage1Tokens: number;
  /** Estimated Stage-1 always-loaded tokens in the current working tree (`0` when removed). */
  currentStage1Tokens: number;
  /** Net change in Stage-1 tokens (`currentStage1Tokens - baseStage1Tokens`). */
  stage1TokenDelta: number;
  /** `SKILL.md` line count at `baseRef` (`0` when newly added). */
  baseLines: number;
  /** `SKILL.md` line count in the current working tree (`0` when removed). */
  currentLines: number;
  /** Net line count delta (`currentLines - baseLines`). */
  lineDelta: number;
  /** Change in `metadata.status`, when modified. */
  statusChange?: { from: string; to: string };
  /** Change in `metadata.owner`, when modified. */
  ownerChange?: { from: string; to: string };
  /** Change in `metadata.replaced-by`, when modified. */
  replacedByChange?: { from: string; to: string };
  /** Human-readable summaries of added, removed, or modified `params.json` keys. */
  paramChanges: string[];
}

/** A validation diagnostic present in the working library that was absent at `baseRef`. */
export interface ValidationRegression {
  /** Rule id from `RULES`. */
  rule: string;
  /** Effective severity. */
  severity: DiagnosticSeverity;
  /** Skill folder concerned, when skill-scoped. */
  skill?: string;
  /** Diagnostic message without skill prefix. */
  message: string;
}

/** An offline trigger check that fails now while passing (or absent) at `baseRef`. */
export interface TriggerRegression {
  /** Skill owning the trigger prompt. */
  skill: string;
  /** Positive (`shouldTrigger`) or negative (`shouldNotTrigger`) expectation. */
  kind: "shouldTrigger" | "shouldNotTrigger";
  /** Failing prompt text. */
  prompt: string;
  /** Routing failure explanation. */
  reason?: string;
}

/** Complete diff report produced by {@link diffLibrary}. */
export interface LibraryDiffResult {
  /** Git ref compared against. */
  baseRef: string;
  /** Validated skills newly added since `baseRef`. */
  added: SkillDiffEntry[];
  /** Validated skills removed since `baseRef`. */
  removed: SkillDiffEntry[];
  /** Validated skills present in both states whose directory content changed. */
  modified: SkillDiffEntry[];
  /** Number of validated skills whose directory content is unchanged. */
  unchangedCount: number;
  /** Total Stage-1 always-loaded token comparison across validated skills. */
  stage1Tokens: {
    base: number;
    current: number;
    delta: number;
    budget?: number;
  };
  /** Validation diagnostics newly introduced since `baseRef`. */
  newDiagnostics: ValidationRegression[];
  /** Number of base diagnostics resolved in the current working tree. */
  resolvedDiagnosticsCount: number;
  /** Offline trigger checks failing now that passed or did not exist at `baseRef`. */
  triggerRegressions: TriggerRegression[];
}

interface SkillSnapshot {
  hash: string;
  stage1Tokens: number;
  lines: number;
  status: string;
  owner: string;
  replacedBy: string;
  params: ParamDefinitions | null;
}

function diffParams(base: ParamDefinitions | null, current: ParamDefinitions | null): string[] {
  const baseKeys = base ? Object.keys(base) : [];
  const curKeys = current ? Object.keys(current) : [];
  const all = [...new Set([...baseKeys, ...curKeys])].sort();
  const changes: string[] = [];

  for (const key of all) {
    const a = base?.[key];
    const b = current?.[key];
    if (!a && b) changes.push(`added param '${key}'`);
    else if (a && !b) changes.push(`removed param '${key}'`);
    else if (a && b && JSON.stringify(a) !== JSON.stringify(b)) changes.push(`changed param '${key}'`);
  }
  return changes;
}

async function hashNormalizedDirectory(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const rel of await listFiles(dir)) {
    const raw = await fs.readFile(path.join(dir, rel));
    const isBinary = raw.subarray(0, 8192).includes(0);
    const normalized = isBinary ? raw : Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    hash.update(rel);
    hash.update("\0");
    hash.update(normalized);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function collectSnapshots(library: Library): Promise<{
  totalStage1: number;
  skills: Map<string, SkillSnapshot>;
}> {
  const stats = await analyzeLibraryStats(library);
  const statsBySkill = new Map(stats.skills.map((item) => [item.name, item]));
  const skills = new Map<string, SkillSnapshot>();

  for (const folder of await library.listSkillFolders()) {
    if (!library.categories.fromFolder(folder).validated) continue;
    const skillDir = library.skillPath(folder);
    const hash = await hashNormalizedDirectory(skillDir).catch(() => "");
    const stat = statsBySkill.get(folder);

    let status = "";
    let owner = "";
    let replacedBy = "";
    try {
      const parsed = await library.readSkill(folder);
      status = parsed.getString("metadata", "status");
      owner = parsed.getString("metadata", "owner");
      replacedBy = parsed.getString("metadata", "replaced-by");
    } catch {
      // Malformed SKILL.md metadata stays empty.
    }

    let params: ParamDefinitions | null = null;
    try {
      params = await library.readSkillParams(folder);
    } catch {
      // Invalid params.json is reported through validateLibrary regressions.
    }

    skills.set(folder, {
      hash,
      stage1Tokens: stat?.alwaysLoaded.estimatedTokens ?? 0,
      lines: stat?.body.lines ?? 0,
      status,
      owner,
      replacedBy,
      params
    });
  }

  return { totalStage1: stats.totals.alwaysLoadedTokens, skills };
}

function diagnosticKey(item: { rule: string; severity: string; skill?: string; message: string }): string {
  return `${item.rule}\0${item.severity}\0${item.skill ?? ""}\0${item.message}`;
}

/**
 * Compares the current library working tree against a Git commit/branch/tag (`baseRef`),
 * reporting skill additions/removals/modifications, Stage-1 always-loaded token deltas, parameter
 * schema diffs, newly introduced validation issues, and trigger routing regressions.
 *
 * @param ref - Working library or root directory.
 * @param options - Optional Git ref (`baseRef`, default `"HEAD"`).
 * @returns Structured diff summary suitable for CLI display, JSON, or PR comment formatting.
 * @throws Error when the library is not inside a Git repository, `baseRef` is invalid or missing,
 *   or `baseRef` does not contain a valid library snapshot.
 *
 * @example
 * ```ts
 * const diff = await diffLibrary(".", { baseRef: "origin/main" });
 * console.log(formatDiffMarkdown(diff));
 * ```
 */
export async function diffLibrary(ref: LibraryRef, options: DiffOptions = {}): Promise<LibraryDiffResult> {
  const current = await toLibrary(ref);
  const baseRef = (options.baseRef ?? "HEAD").trim();
  if (!baseRef || baseRef.startsWith("-") || /\s/.test(baseRef)) {
    throw new Error(`Invalid Git ref '${options.baseRef ?? ""}'.`);
  }

  let repoRootRaw: string;
  try {
    const out = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: current.root });
    repoRootRaw = out.stdout.trim();
  } catch {
    throw new Error(`${current.root} is not inside a Git repository.`);
  }

  const repoRoot = await fs.realpath(repoRootRaw);
  const libRealRoot = await fs.realpath(current.root);
  const relPrefix = path.relative(repoRoot, libRealRoot).split(path.sep).join("/");
  if (relPrefix.startsWith("..")) {
    throw new Error(`Library ${current.root} is outside Git repository ${repoRoot}.`);
  }

  try {
    await execFileAsync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: repoRoot });
  } catch {
    throw new Error(`Cannot resolve Git ref '${baseRef}'.`);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skanvil-diff-"));
  const tmpIndex = path.join(tmpRoot, "index");
  const snapshotDir = path.join(tmpRoot, "snapshot");
  await fs.mkdir(snapshotDir);

  let baseLib: Library;
  try {
    const gitEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const treeRef = relPrefix ? `${baseRef}:${relPrefix}` : baseRef;
    try {
      await execFileAsync("git", ["read-tree", treeRef], { cwd: repoRoot, env: gitEnv });
      await execFileAsync(
        "git",
        ["-c", "core.autocrlf=false", "checkout-index", "-a", "-f", `--prefix=${snapshotDir.replace(/\\/g, "/")}/`],
        {
          cwd: repoRoot,
          env: gitEnv
        }
      );
    } catch (error) {
      const detail = (error as Error & { stderr?: string }).stderr?.trim() || (error as Error).message;
      throw new Error(`Could not snapshot library at '${baseRef}': ${detail}`);
    }

    baseLib = await Library.open(snapshotDir);

    const [baseSnap, curSnap, baseVal, curVal, baseEval, curEval] = await Promise.all([
      collectSnapshots(baseLib),
      collectSnapshots(current),
      validateLibrary(baseLib),
      validateLibrary(current),
      checkTriggerRouting(baseLib),
      checkTriggerRouting(current)
    ]);

    const added: SkillDiffEntry[] = [];
    const removed: SkillDiffEntry[] = [];
    const modified: SkillDiffEntry[] = [];
    let unchangedCount = 0;

    const allSkills = [...new Set([...baseSnap.skills.keys(), ...curSnap.skills.keys()])].sort((a, b) =>
      a.localeCompare(b)
    );
    for (const skill of allSkills) {
      const b = baseSnap.skills.get(skill);
      const c = curSnap.skills.get(skill);
      if (!b && c) {
        added.push({
          skill,
          status: "added",
          baseStage1Tokens: 0,
          currentStage1Tokens: c.stage1Tokens,
          stage1TokenDelta: c.stage1Tokens,
          baseLines: 0,
          currentLines: c.lines,
          lineDelta: c.lines,
          paramChanges: diffParams(null, c.params)
        });
      } else if (b && !c) {
        removed.push({
          skill,
          status: "removed",
          baseStage1Tokens: b.stage1Tokens,
          currentStage1Tokens: 0,
          stage1TokenDelta: -b.stage1Tokens,
          baseLines: b.lines,
          currentLines: 0,
          lineDelta: -b.lines,
          paramChanges: diffParams(b.params, null)
        });
      } else if (b && c) {
        if (b.hash === c.hash) {
          unchangedCount += 1;
          continue;
        }
        modified.push({
          skill,
          status: "modified",
          baseStage1Tokens: b.stage1Tokens,
          currentStage1Tokens: c.stage1Tokens,
          stage1TokenDelta: c.stage1Tokens - b.stage1Tokens,
          baseLines: b.lines,
          currentLines: c.lines,
          lineDelta: c.lines - b.lines,
          ...(b.status !== c.status
            ? { statusChange: { from: b.status || "(unset)", to: c.status || "(unset)" } }
            : {}),
          ...(b.owner !== c.owner ? { ownerChange: { from: b.owner || "(unset)", to: c.owner || "(unset)" } } : {}),
          ...(b.replacedBy !== c.replacedBy
            ? { replacedByChange: { from: b.replacedBy || "(unset)", to: c.replacedBy || "(unset)" } }
            : {}),
          paramChanges: diffParams(b.params, c.params)
        });
      }
    }

    const baseDiagKeys = new Set(baseVal.diagnostics.map(diagnosticKey));
    const curDiagKeys = new Set(curVal.diagnostics.map(diagnosticKey));
    const newDiagnostics: ValidationRegression[] = curVal.diagnostics
      .filter((d) => !baseDiagKeys.has(diagnosticKey(d)))
      .map((d) => ({
        rule: d.rule,
        severity: d.severity,
        ...(d.skill ? { skill: d.skill } : {}),
        message: d.message
      }));
    const resolvedDiagnosticsCount = baseVal.diagnostics.filter((d) => !curDiagKeys.has(diagnosticKey(d))).length;

    const baseTriggerPass = new Map<string, boolean>();
    for (const item of baseEval.results) {
      baseTriggerPass.set(`${item.skill}\0${item.kind}\0${item.prompt}`, item.passed);
    }
    const triggerRegressions: TriggerRegression[] = [];
    for (const item of curEval.results) {
      if (item.passed) continue;
      const key = `${item.skill}\0${item.kind}\0${item.prompt}`;
      const prev = baseTriggerPass.get(key);
      if (prev === undefined || prev === true) {
        triggerRegressions.push({
          skill: item.skill,
          kind: item.kind,
          prompt: item.prompt,
          ...(item.reason ? { reason: item.reason } : {})
        });
      }
    }

    return {
      baseRef,
      added,
      removed,
      modified,
      unchangedCount,
      stage1Tokens: {
        base: baseSnap.totalStage1,
        current: curSnap.totalStage1,
        delta: curSnap.totalStage1 - baseSnap.totalStage1,
        ...(current.config.validation.maxAlwaysLoadedTokens !== undefined
          ? { budget: current.config.validation.maxAlwaysLoadedTokens }
          : {})
      },
      newDiagnostics,
      resolvedDiagnosticsCount,
      triggerRegressions
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Formats a {@link LibraryDiffResult} as GitHub-flavored Markdown suitable for Pull Request comments.
 *
 * @param diff - Result returned by {@link diffLibrary}.
 * @returns Formatted Markdown report ending with a newline.
 */
export function formatDiffMarkdown(diff: LibraryDiffResult): string {
  const lines: string[] = [`## skanvil diff (${diff.baseRef})`, ""];
  const budgetNote = diff.stage1Tokens.budget ? ` / ${diff.stage1Tokens.budget} budget` : "";
  lines.push(
    `- **Stage-1 always-loaded tokens:** ~${diff.stage1Tokens.base} → ~${diff.stage1Tokens.current} (${formatSigned(diff.stage1Tokens.delta)}${budgetNote})`
  );
  lines.push(
    `- **Skills:** ${diff.added.length} added, ${diff.modified.length} modified, ${diff.removed.length} removed, ${diff.unchangedCount} unchanged`
  );
  if (diff.resolvedDiagnosticsCount > 0) {
    lines.push(`- **Resolved diagnostics:** ${diff.resolvedDiagnosticsCount}`);
  }
  lines.push("");

  const entries = [...diff.added, ...diff.modified, ...diff.removed];
  if (entries.length === 0) {
    lines.push("No skill changes detected.");
  } else {
    lines.push("| Skill | Change | Stage-1 Tokens | Lines | Details |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const entry of entries) {
      const details: string[] = [];
      if (entry.statusChange) details.push(`status: ${entry.statusChange.from} → ${entry.statusChange.to}`);
      if (entry.ownerChange) details.push(`owner: ${entry.ownerChange.from} → ${entry.ownerChange.to}`);
      if (entry.replacedByChange) {
        details.push(`replaced-by: ${entry.replacedByChange.from} → ${entry.replacedByChange.to}`);
      }
      details.push(...entry.paramChanges);
      lines.push(
        `| \`${entry.skill}\` | ${entry.status} | ~${entry.baseStage1Tokens} → ~${entry.currentStage1Tokens} (${formatSigned(entry.stage1TokenDelta)}) | ${entry.baseLines} → ${entry.currentLines} (${formatSigned(entry.lineDelta)}) | ${details.join("; ") || "-"} |`
      );
    }
  }

  if (diff.newDiagnostics.length > 0) {
    lines.push("", "### New Validation Diagnostics", "");
    for (const item of diff.newDiagnostics) {
      const prefix = item.skill ? `${item.skill}: ` : "";
      lines.push(`- **[${item.severity}] \`${item.rule}\`**: ${prefix}${item.message}`);
    }
  }

  if (diff.triggerRegressions.length > 0) {
    lines.push("", "### Trigger Routing Regressions", "");
    for (const reg of diff.triggerRegressions) {
      const note = reg.reason ? ` — ${reg.reason}` : "";
      lines.push(`- **\`${reg.skill}\`** (${reg.kind}): "${reg.prompt}"${note}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
