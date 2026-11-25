/**
 * Context-budget analysis (`skanvil stats`): measures the 3 progressive-loading stages of every
 * skill in a library (`name` + `description`, `SKILL.md` body, and `references/` / `scripts/` /
 * `assets/`).
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";

import { listFiles } from "../util/fs.js";
import type { Library } from "./library.js";
import type { SkillFile } from "./skill.js";
import { estimateTokens } from "./text.js";
import { findUnusedResources } from "./validate.js";

const RESOURCE_PREFIX_PATTERN = /^(?:references|scripts|assets)\//;

/** Character and estimated token counts for a loading stage. */
export interface StageStats {
  /** UTF-8 character count (LF line endings for Markdown). */
  chars: number;
  /** Approximate token count (~4 chars/token). */
  estimatedTokens: number;
}

/** Stage-2 stats for `SKILL.md`. */
export interface BodyStats extends StageStats {
  /** Total lines in `SKILL.md` (LF). */
  lines: number;
}

/** Stage-3 stats for on-demand files under `references/`, `scripts/` and `assets/`. */
export interface ResourceStats extends StageStats {
  /** Number of non-hidden files under `references/`, `scripts/` and `assets/`. */
  files: number;
  /** Resource files never referenced from `SKILL.md`. */
  unreferencedFiles: string[];
}

/** Context-budget metrics for one skill. */
export interface SkillStats {
  /** Skill folder name. */
  name: string;
  /** Category id. */
  category: string;
  /** Optional `metadata.status` value when set. */
  status?: string;
  /** Stage 1 (always loaded): `name` + `description`. */
  alwaysLoaded: StageStats;
  /** Stage 2 (loaded when triggered): full `SKILL.md` (rendered with defaults). */
  body: BodyStats;
  /** Stage 3 (loaded on demand): text resources under `references/`, `scripts/` and `assets/`. */
  resources: ResourceStats;
  /** Total estimated tokens across Stage 2 (`SKILL.md`, which contains Stage 1) and Stage 3. */
  totalEstimatedTokens: number;
}

/** Options of {@link analyzeLibraryStats}. */
export interface StatsOptions {
  /** Only include skills of this category (id or alias). */
  category?: string;
  /** Only include this single skill folder. */
  skill?: string;
  /** Sort order for `skills`. @defaultValue `"name"` */
  sort?: "tokens" | "lines" | "name";
}

/** Library-wide summary produced by {@link analyzeLibraryStats}. */
export interface LibraryStats {
  /** Number of skills included in the report. */
  count: number;
  /** Aggregate totals across all included skills. */
  totals: {
    alwaysLoadedTokens: number;
    bodyTokens: number;
    bodyLines: number;
    resourceFiles: number;
    resourceTokens: number;
    unreferencedFiles: number;
  };
  /** Per-skill breakdown. */
  skills: SkillStats[];
}

function isTextBuffer(buffer: Buffer): boolean {
  return !buffer.includes(0) && Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer);
}

/**
 * Computes 3-stage context-budget metrics for validated skills in a library.
 *
 * Parametrized skills (`params.json`) are measured after rendering with their default values.
 *
 * @param library - Library to inspect.
 * @param options - Optional filters and sort order.
 * @returns Per-skill stats and aggregate totals.
 * @throws Error when `category` is unknown, `skill` does not exist, or `sort` is invalid.
 */
export async function analyzeLibraryStats(library: Library, options: StatsOptions = {}): Promise<LibraryStats> {
  const categoryFilter = options.category ? library.categories.resolve(options.category).id : null;
  if (options.skill) {
    await library.requireSkill(options.skill);
  }
  const sort = options.sort ?? "name";
  if (sort !== "tokens" && sort !== "lines" && sort !== "name") {
    throw new Error(`Invalid sort '${sort}'. Use one of: tokens, lines, name.`);
  }

  const folders = await library.listSkillFolders();
  const skills: SkillStats[] = [];

  for (const folder of folders) {
    const category = library.categories.fromFolder(folder);
    if (!options.skill && !category.validated) continue;
    if (categoryFilter && category.id !== categoryFilter) continue;
    if (options.skill && folder !== options.skill) continue;
    if (!(await library.hasSkill(folder))) continue;

    let skill: SkillFile;
    try {
      skill = await library.readSkillRendered(folder);
    } catch {
      skill = await library.readSkill(folder);
    }

    const lfContent = skill.toLfString();
    const effectiveName = skill.getString("name") || folder;
    const description = skill.getString("description");
    const stage1Text = description ? `${effectiveName}\n${description}` : effectiveName;
    const status = skill.getString("metadata", "status") || undefined;

    const skillDir = library.skillPath(folder);
    const allFiles = await listFiles(skillDir);
    const resourceFiles = allFiles.filter(
      (file) => RESOURCE_PREFIX_PATTERN.test(file) && !path.posix.basename(file).startsWith(".")
    );
    const unreferencedFiles = findUnusedResources(skill.body, new Set(allFiles));

    let resourceChars = 0;
    let resourceTokens = 0;
    for (const file of resourceFiles) {
      const buffer = await fs.readFile(path.join(skillDir, file));
      if (!isTextBuffer(buffer)) continue;
      const text = buffer.toString("utf8").replace(/\r\n/g, "\n");
      resourceChars += text.length;
      resourceTokens += estimateTokens(text);
    }

    const bodyTokens = estimateTokens(lfContent);
    const entry: SkillStats = {
      name: folder,
      category: category.id,
      ...(status ? { status } : {}),
      alwaysLoaded: {
        chars: stage1Text.length,
        estimatedTokens: estimateTokens(stage1Text)
      },
      body: {
        lines: lfContent.split("\n").length,
        chars: lfContent.length,
        estimatedTokens: bodyTokens
      },
      resources: {
        files: resourceFiles.length,
        chars: resourceChars,
        estimatedTokens: resourceTokens,
        unreferencedFiles
      },
      totalEstimatedTokens: bodyTokens + resourceTokens
    };
    skills.push(entry);
  }

  skills.sort((a, b) => {
    if (sort === "tokens") {
      return (
        b.alwaysLoaded.estimatedTokens - a.alwaysLoaded.estimatedTokens ||
        b.body.estimatedTokens - a.body.estimatedTokens ||
        a.name.localeCompare(b.name)
      );
    }
    if (sort === "lines") {
      return b.body.lines - a.body.lines || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
  });

  const totals = {
    alwaysLoadedTokens: skills.reduce((sum, item) => sum + item.alwaysLoaded.estimatedTokens, 0),
    bodyTokens: skills.reduce((sum, item) => sum + item.body.estimatedTokens, 0),
    bodyLines: skills.reduce((sum, item) => sum + item.body.lines, 0),
    resourceFiles: skills.reduce((sum, item) => sum + item.resources.files, 0),
    resourceTokens: skills.reduce((sum, item) => sum + item.resources.estimatedTokens, 0),
    unreferencedFiles: skills.reduce((sum, item) => sum + item.resources.unreferencedFiles.length, 0)
  };

  return { count: skills.length, totals, skills };
}
