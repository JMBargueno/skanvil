/**
 * `skanvil import`: bulk-imports existing skill folders into a skanvil library.
 *
 * Supports external agent folders (such as `.claude/skills/` or `.cursor/skills/`) as well as
 * single skill directories containing a `SKILL.md`, normalising frontmatter, applying category
 * prefixes, updating the README index, and rolling back on failure.
 *
 * @module
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { exists } from "../util/fs.js";
import type { Category } from "./config.js";
import { toKebabCase, toTitleCase } from "./naming.js";
import { rebuildIndex } from "./reindex.js";
import { SkillFile } from "./skill.js";
import { applyCategory, convertToolsField, toLibrary, type LibraryRef } from "./skills.js";
import { MANIFEST_FILE } from "./sync.js";

/** Options of {@link importSkills}. */
export interface ImportSkillsOptions {
  /** Target category id or alias (applies its prefix and metadata). Defaults to the folder's inferred or default category. */
  type?: string;
  /** Import only skills matching these source folder or frontmatter names. */
  skills?: string[];
  /** Preview what would be imported or skipped without writing any files. @defaultValue `false` */
  dryRun?: boolean;
  /** Replace existing library skill folders with the same resolved name. @defaultValue `false` */
  overwrite?: boolean;
}

/** Per-skill outcome returned inside {@link ImportSkillsResult}. */
export interface ImportedSkillItem {
  /** Relative source folder name (`.` when `sourceDir` itself is a single skill directory). */
  source: string;
  /** Resolved skill folder name in the destination library. */
  target: string;
  /** Resolved category id. */
  type: string;
  /** Outcome status for this skill. */
  status: "imported" | "overwritten" | "skipped";
  /** Reason the skill was skipped, when `status === "skipped"`. */
  reason?: string;
  /** Normalizations applied to `SKILL.md` during import. */
  changes: string[];
}

/** Result of {@link importSkills}. */
export interface ImportSkillsResult {
  /** Absolute source directory scanned. */
  sourceDir: string;
  /** Whether disk writes were skipped. */
  dryRun: boolean;
  /** Skills imported or overwritten (planned when `dryRun: true`). */
  imported: ImportedSkillItem[];
  /** Skills skipped because they already existed or pointed at the target itself. */
  skipped: ImportedSkillItem[];
}

interface DiscoveredSkill {
  sourceLabel: string;
  sourcePath: string;
  folderName: string;
}

interface PlannedImport {
  item: ImportedSkillItem;
  sourcePath: string;
  targetPath: string;
  content: string;
  existed: boolean;
}

async function discoverSourceSkills(sourceDir: string): Promise<DiscoveredSkill[]> {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(sourceDir);
  } catch {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Source path is not a directory: ${sourceDir}`);
  }

  if (await exists(path.join(sourceDir, "SKILL.md"))) {
    return [{ sourceLabel: ".", sourcePath: sourceDir, folderName: path.basename(sourceDir) }];
  }

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const found: DiscoveredSkill[] = [];
  for (const name of folders) {
    const dir = path.join(sourceDir, name);
    if (await exists(path.join(dir, "SKILL.md"))) {
      found.push({ sourceLabel: name, sourcePath: dir, folderName: name });
    }
  }
  if (found.length === 0) {
    throw new Error(`No skills (folders containing SKILL.md) found in ${sourceDir}.`);
  }
  return found;
}

function derivePreservedName(rawName: string): string {
  const trimmed = rawName.trim();
  if (trimmed.startsWith("_")) {
    const inner = toKebabCase(trimmed.slice(1));
    return inner ? `_${inner}` : "";
  }
  return toKebabCase(trimmed);
}

/**
 * Bulk-imports existing skills from an external directory (or single skill folder) into a library.
 *
 * @remarks
 * - Copies skill directories including `references/`, `scripts/`, `assets/`, `params.json`, and
 *   `evals.json`, while omitting sync manifests (`.skanvil-sync.json`).
 * - Normalises valid YAML frontmatter via {@link SkillFile}: aligns `name`, converts legacy `tools`
 *   to `allowed-tools`, applies missing category metadata/compatibility, and adds a `# Title` heading
 *   if absent.
 * - Transactional across the batch: computes all target names, checks collisions and README readability
 *   before writing, and rolls back created/overwritten folders and README edits on failure.
 *
 * @param ref - Destination library or root folder.
 * @param sourceDir - Folder containing skill subdirectories or a single `SKILL.md`.
 * @param options - Category override, skill filter, `dryRun`, and `overwrite`.
 * @returns Imported/overwritten items and skipped conflicts.
 * @throws Error when `sourceDir` is invalid, a requested `--skill` is missing, target names collide,
 *   the README cannot be read, or writes fail (after rolling back).
 *
 * @example
 * ```ts
 * const result = await importSkills("./my-skills", "../app/.claude/skills", { type: "front" });
 * console.log(result.imported.map((item) => item.target));
 * ```
 */
export async function importSkills(
  ref: LibraryRef,
  sourceDir: string,
  options: ImportSkillsOptions = {}
): Promise<ImportSkillsResult> {
  const library = await toLibrary(ref);
  const absSource = path.resolve(sourceDir);
  const dryRun = Boolean(options.dryRun);
  const overwrite = Boolean(options.overwrite);
  const explicitCategory: Category | null = options.type ? library.categories.resolve(options.type) : null;
  const discovered = await discoverSourceSkills(absSource);

  const parsedEntries: { src: DiscoveredSkill; skill: SkillFile; frontmatterName: string }[] = [];
  for (const src of discovered) {
    const skill = SkillFile.parse(await fs.readFile(path.join(src.sourcePath, "SKILL.md"), "utf8"));
    parsedEntries.push({ src, skill, frontmatterName: skill.getString("name") });
  }

  let selected = parsedEntries;
  if (options.skills?.length) {
    const requested = new Set(options.skills);
    selected = parsedEntries.filter(
      (entry) => requested.has(entry.src.folderName) || (entry.frontmatterName && requested.has(entry.frontmatterName))
    );
    for (const wanted of options.skills) {
      const matched = parsedEntries.some(
        (entry) => entry.src.folderName === wanted || entry.frontmatterName === wanted
      );
      if (!matched) {
        throw new Error(`Skill '${wanted}' not found in ${absSource}.`);
      }
    }
  }

  // Plan phase: validate names, detect collisions and verify README access before mutating disk.
  const planned: PlannedImport[] = [];
  const skipped: ImportedSkillItem[] = [];
  const seenTargets = new Set<string>();
  let needsReadme = false;

  for (const { src, skill } of selected) {
    const rawName = skill.getString("name") || src.folderName;
    const targetName = explicitCategory
      ? library.categories.buildName(explicitCategory.id, rawName)
      : derivePreservedName(rawName);
    if (!targetName || targetName === "_") {
      throw new Error(`Could not derive a valid skill name from '${src.sourcePath}'.`);
    }
    if (seenTargets.has(targetName)) {
      throw new Error(`Import collision: multiple source skills map to '${targetName}'.`);
    }
    seenTargets.add(targetName);

    const category = explicitCategory ?? library.categories.fromFolder(targetName);
    const targetPath = library.skillPath(targetName);
    if (path.resolve(src.sourcePath) === path.resolve(targetPath)) {
      skipped.push({
        source: src.sourceLabel,
        target: targetName,
        type: category.id,
        status: "skipped",
        reason: "source and destination are the same folder",
        changes: []
      });
      continue;
    }

    const existed = await exists(targetPath);
    if (existed && !overwrite) {
      skipped.push({
        source: src.sourceLabel,
        target: targetName,
        type: category.id,
        status: "skipped",
        reason: "already exists (use --overwrite)",
        changes: []
      });
      continue;
    }

    const changes: string[] = [];
    if (skill.isValidYaml) {
      if (skill.getString("name") !== targetName) {
        skill.set(["name"], targetName);
        changes.push(`set name to '${targetName}'`);
      }
      if (convertToolsField(skill)) {
        changes.push("converted tools to allowed-tools");
      }
      const hadAllMeta =
        Object.entries(category.metadata).every(([k, v]) => skill.getString("metadata", k) === v) &&
        (!category.compatibility || Boolean(skill.getString("compatibility")));
      applyCategory(skill, category);
      if (!hadAllMeta) changes.push(`applied category '${category.id}' metadata`);
      if (!skill.title) {
        const heading = toTitleCase(library.categories.stripPrefix(targetName).replace(/-/g, " ")) || targetName;
        skill.setTitle(heading);
        changes.push("added # Title heading");
      }
    }

    if (category.indexed) needsReadme = true;
    planned.push({
      item: {
        source: src.sourceLabel,
        target: targetName,
        type: category.id,
        status: existed ? "overwritten" : "imported",
        changes
      },
      sourcePath: src.sourcePath,
      targetPath,
      content: skill.toString(),
      existed
    });
  }

  const readme = planned.length > 0 && needsReadme ? await library.readReadme() : null;
  const originalReadme = readme ? { ...readme } : null;

  if (dryRun || planned.length === 0) {
    return {
      sourceDir: absSource,
      dryRun,
      imported: planned.map((entry) => entry.item),
      skipped
    };
  }

  // Write phase with full rollback across copied folders and README.
  const hasOverwrites = planned.some((entry) => entry.existed);
  const backupDir = hasOverwrites ? await fs.mkdtemp(path.join(os.tmpdir(), "skanvil-import-backup-")) : null;
  const createdPaths: string[] = [];
  const backedUp: { targetPath: string; backupPath: string }[] = [];

  try {
    await fs.mkdir(library.skillsDir, { recursive: true });
    for (const entry of planned) {
      if (entry.existed && backupDir) {
        const backupPath = path.join(backupDir, entry.item.target);
        await fs.cp(entry.targetPath, backupPath, { recursive: true });
        backedUp.push({ targetPath: entry.targetPath, backupPath });
        await fs.rm(entry.targetPath, { recursive: true, force: true });
      } else {
        createdPaths.push(entry.targetPath);
      }

      await fs.cp(entry.sourcePath, entry.targetPath, {
        recursive: true,
        filter: (srcPath) => path.basename(srcPath) !== MANIFEST_FILE
      });
      await fs.writeFile(path.join(entry.targetPath, "SKILL.md"), entry.content, "utf8");
    }

    if (readme) {
      const nextText = await rebuildIndex(library, readme.text);
      if (nextText !== readme.text) {
        await library.writeReadme({ text: nextText, eol: readme.eol });
      }
    }
  } catch (error) {
    for (const created of createdPaths) {
      await fs.rm(created, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const { targetPath, backupPath } of backedUp) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      await fs.cp(backupPath, targetPath, { recursive: true }).catch(() => undefined);
    }
    if (originalReadme) {
      await library.writeReadme(originalReadme).catch(() => undefined);
    }
    throw new Error(`Import failed and was rolled back: ${(error as Error).message}`);
  } finally {
    if (backupDir) await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    sourceDir: absSource,
    dryRun: false,
    imported: planned.map((entry) => entry.item),
    skipped
  };
}
