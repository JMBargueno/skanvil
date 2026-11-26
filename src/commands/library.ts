/**
 * CLI handlers for library-level commands: `init`, `validate`, `index`, `doctor`,
 * `templates eject`, `install-skill` and `sync`.
 *
 * Every handler returns the process exit code: 0 on success, 1 on failure.
 *
 * @module
 */
import path from "node:path";

import { installAgentSkill } from "../core/agent-skill.js";
import { buildLibrary } from "../core/build.js";
import { diffLibrary, formatDiffMarkdown } from "../core/diff.js";
import { doctor } from "../core/doctor.js";
import { parseParamPairs } from "../core/params.js";
import { createLibrary } from "../core/init.js";
import { rebuildIndex } from "../core/reindex.js";
import { analyzeLibraryStats } from "../core/stats.js";
import { resolveSourceHandle, syncSkills, type TargetResult } from "../core/sync.js";
import {
  buildSyncAppliedEvents,
  isTelemetryOptedOut,
  libraryDisplayName,
  resolveTelemetrySettings,
  sendTelemetryEvents
} from "../core/telemetry.js";
import { Library } from "../core/library.js";
import { ejectSkillTemplate } from "../core/templates.js";
import { formatDiagnostic, validateLibrary } from "../core/validate.js";
import { formatGitHubAnnotations, formatSarif, type ValidateOutputFormat } from "../core/validate-format.js";
import { Output } from "../util/output.js";
import { displayPath } from "../util/paths.js";
import { openLibrary, printValidation, resolveRoot, type CommonOptions } from "./shared.js";

/** Options of `skanvil init` (see `CreateLibraryOptions` in core/init.ts). */
export interface InitOptions extends CommonOptions {
  /** `--name`. */
  name?: string;
  /** `--scope`. */
  scope?: string;
  /** `--description`. */
  description?: string;
  /** `--profile`. */
  profile?: string;
  /** `false` with `--no-git`. */
  git?: boolean;
  /** `--eject-templates`. */
  ejectTemplates?: boolean;
  /** `false` with `--no-agent-skill`. */
  agentSkill?: boolean;
  /** `false` with `--no-feedback`. */
  feedback?: boolean;
  /** `--target` values: default sync targets, also used for the agent skill. */
  target?: string[];
}

/**
 * `skanvil init [dir]`: creates a library in `dir`, or in `--cwd` / the current folder.
 *
 * @param dir - Destination folder from the positional argument.
 * @param options - Parsed CLI options.
 * @returns Exit code.
 */
export async function initCommand(dir: string | undefined, options: InitOptions): Promise<number> {
  const out = new Output("init", options.json);
  const target = dir ? path.resolve(dir) : resolveRoot(options);
  const result = await createLibrary(target, {
    name: options.name,
    scope: options.scope,
    description: options.description,
    profile: options.profile,
    git: options.git !== false,
    ejectTemplates: options.ejectTemplates,
    agentSkill: options.agentSkill,
    feedbackSkill: options.feedback,
    syncTargets: splitList(options.target).length > 0 ? splitList(options.target) : undefined
  });

  out.info(`Created library '${result.name}' in ${displayPath(result.target)}`);
  for (const installed of result.agentSkill) {
    out.info(`Installed the ${installed.skill} agent skill in ${path.relative(result.target, installed.path)}`);
  }
  if (options.git !== false && !result.gitInitialized) {
    out.warn("Could not run 'git init'. Is git installed?");
  }
  out.info("Next: cd into the folder, run 'npm install' and then 'skanvil add'.");
  out.data(result);
  return 0;
}

/** Options of `skanvil validate`. */
export interface ValidateOptions extends CommonOptions {
  /** `--strict`: warnings also fail. */
  strict?: boolean;
  /** `--skill`: only report one skill. */
  skill?: string;
  /** `--format`: `text`, `github`, `sarif`, or `json`. */
  format?: ValidateOutputFormat | string;
}

/**
 * `skanvil validate`: prints the diagnostics in text, GitHub Actions annotation, SARIF 2.1.0,
 * or JSON (`{ ok, diagnostics, count, errors, warnings }`) format.
 *
 * @param options - Parsed CLI options.
 * @returns 1 when there are errors (or warnings with `--strict`), otherwise 0.
 */
export async function validateCommand(options: ValidateOptions): Promise<number> {
  if (options.json && options.format && options.format !== "json") {
    throw new Error("Do not combine --json with --format.");
  }
  const format = (options.format ?? (options.json ? "json" : "text")).trim();
  if (format !== "text" && format !== "github" && format !== "sarif" && format !== "json") {
    throw new Error(`Invalid validate format '${format}'. Use 'text', 'github', 'sarif' or 'json'.`);
  }

  const library = await openLibrary(options);
  const result = await validateLibrary(library, { skill: options.skill });
  const blocking = result.errors + (options.strict ? result.warnings : 0);

  if (format === "json") {
    console.log(JSON.stringify({ ok: blocking === 0, ...result }, null, 2));
  } else if (format === "github") {
    process.stdout.write(formatGitHubAnnotations(result, library));
  } else if (format === "sarif") {
    process.stdout.write(formatSarif(result, library));
  } else {
    printValidation(new Output("validate"), result, options.strict);
  }
  return blocking > 0 ? 1 : 0;
}

/** Options of `skanvil index`. */
export interface IndexOptions extends CommonOptions {
  /** `--check`: compare only, do not write. */
  check?: boolean;
}

/**
 * `skanvil index`: regenerates the README index with {@link rebuildIndex}.
 *
 * @param options - Parsed CLI options.
 * @returns With `--check`, 1 when the index is out of date. Otherwise 0.
 */
export async function indexCommand(options: IndexOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("index", options.json);
  const readme = await library.readReadme();
  const text = await rebuildIndex(library, readme.text);
  const changed = text !== readme.text;

  if (options.check) {
    out.data({ upToDate: !changed });
    if (changed) {
      out.error(`${library.config.readme} index is out of date. Run 'skanvil index' to regenerate it.`);
      return 1;
    }
    out.success(`${library.config.readme} index is up to date.`);
    return 0;
  }

  if (changed) await library.writeReadme({ text, eol: readme.eol });
  out.data({ updated: changed });
  out.success(changed ? `Regenerated the index in ${library.config.readme}.` : "Index already up to date.");
  return 0;
}

/** Options of `skanvil doctor`. */
export interface DoctorOptions extends CommonOptions {
  /** `--fix`: apply repairs. */
  fix?: boolean;
  /** `--scaffold-sections`: insert stubs for missing required sections (requires `--fix`). */
  scaffoldSections?: boolean;
}

/**
 * `skanvil doctor`.
 * - Without `--fix`: lists the problems and marks the fixable ones.
 * - With `--fix`: repairs them and re-validates.
 *
 * @param options - Parsed CLI options.
 * @returns 1 when errors remain, otherwise 0.
 */
export async function doctorCommand(options: DoctorOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("doctor", options.json);
  const result = await doctor(library, { fix: options.fix, scaffoldSections: options.scaffoldSections });
  const final = result.after ?? result.before;

  if (options.json) {
    console.log(JSON.stringify({ ok: final.errors === 0, fixes: result.fixes, ...final }, null, 2));
    return final.errors > 0 ? 1 : 0;
  }

  if (!options.fix) {
    for (const diagnostic of result.before.diagnostics) {
      const tag = diagnostic.fixable ? " (fixable)" : "";
      const line = ` - ${formatDiagnostic(diagnostic)} [${diagnostic.rule}]${tag}`;
      if (diagnostic.severity === "error") out.error(line);
      else out.warn(line);
    }
    const fixable = result.before.diagnostics.filter((diagnostic) => diagnostic.fixable).length;
    if (result.before.diagnostics.length === 0) out.success("Nothing to fix.");
    else if (fixable > 0) out.info(`${fixable} problem(s) can be fixed automatically: run 'skanvil doctor --fix'.`);
    return result.before.errors > 0 ? 1 : 0;
  }

  for (const fix of result.fixes) out.info(`fixed: ${fix}`);
  if (result.fixes.length === 0) out.info("No automatic fixes applied.");
  return printValidation(out, final) > 0 ? 1 : 0;
}

/** Options of `skanvil templates eject`. */
export interface EjectOptions extends CommonOptions {
  /** `--category`: eject as a category-specific template. */
  category?: string;
  /** `--force`: overwrite an existing template folder. */
  force?: boolean;
}

/**
 * `skanvil templates eject`: copies the built-in skill template into the library.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code.
 */
export async function ejectCommand(options: EjectOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("templates", options.json);
  const target = await ejectSkillTemplate(library, options.category, options.force);
  out.success(`Skill template copied to ${displayPath(target)}. Edit it; 'skanvil add' will use it from now on.`);
  out.data({ target });
  return 0;
}

/** Options of `skanvil install-skill`. */
export interface InstallSkillOptions extends CommonOptions {
  /** `--target` values (repeatable, comma-separated allowed). @defaultValue `["claude"]` */
  target?: string[];
  /** `--force`: replace a foreign `skanvil` folder, or reinstall the same version. */
  force?: boolean;
  /** `--global`: install into the user's home folders instead of a project. */
  global?: boolean;
  /** `false` with `--no-feedback`. */
  feedback?: boolean;
}

/**
 * Resolves the destination of `sync` / `install-skill`.
 *
 * @throws Error when a destination is given together with `--global`.
 */
function destinationFor(dest: string | undefined, global: boolean | undefined): string {
  if (global && dest) {
    throw new Error("Do not pass a destination together with --global: global installs go to your home folder.");
  }
  return path.resolve(dest || process.cwd());
}

/**
 * `skanvil install-skill [dest]`: installs or updates the `skanvil` agent skill in a project,
 * so coding agents there know how to use the CLI.
 *
 * @param dest - Project folder (default: the current directory).
 * @param options - Parsed CLI options.
 * @returns 1 when any target was skipped, otherwise 0.
 * @see {@link installAgentSkill}
 */
export async function installSkillCommand(dest: string | undefined, options: InstallSkillOptions): Promise<number> {
  const out = new Output("install-skill", options.json);
  const targets = splitList(options.target);
  const results = await installAgentSkill({
    dest: destinationFor(dest, options.global),
    targets: targets.length > 0 ? targets : ["claude"],
    force: options.force,
    scope: options.global ? "user" : "project",
    includeFeedback: options.feedback
  });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      if (result.status === "skipped") out.warn(`${result.target} (${result.skill}): skipped (${result.reason})`);
      else out.success(`${result.target} (${result.skill}): ${result.status} ${displayPath(result.path)}`);
    }
  }
  return results.some((result) => result.status === "skipped") ? 1 : 0;
}

/** Options of `skanvil sync`. Repeatable options arrive as arrays. */
export interface SyncCommandOptions extends CommonOptions {
  /** `--from`: library folder or installed npm package. */
  from?: string;
  /** `--target` values (repeatable, comma-separated allowed). */
  target?: string[];
  /** `--link`. */
  link?: boolean;
  /** `--copy` (overrides `sync.mode: "link"`). */
  copy?: boolean;
  /** `--dry-run`. */
  dryRun?: boolean;
  /** `--force`: also sync invalid skills. */
  force?: boolean;
  /** `--category` values. */
  category?: string[];
  /** `--skill` values. */
  skill?: string[];
  /** `--status` values. */
  status?: string[];
  /** `--include-deprecated`: include skills with `metadata.status: "deprecated"`. */
  includeDeprecated?: boolean;
  /** `--global`: install into the user's home folders instead of a project. */
  global?: boolean;
  /** `--param name=value` entries (repeatable). */
  param?: string[];
}

/** Flattens repeatable and comma-separated option values (`["a,b", "c"]` becomes `["a", "b", "c"]`). */
function splitList(values?: string[]): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * `skanvil sync [dest]`: installs skills into `dest` (default: the current folder).
 *
 * Targets come from the first source that provides any:
 * 1. `--target`;
 * 2. `sync.targets` in the library config;
 * 3. `claude`.
 *
 * @param dest - Project folder from the positional argument.
 * @param options - Parsed CLI options.
 * @returns Exit code.
 * @see {@link syncSkills}
 */
export async function syncCommand(dest: string | undefined, options: SyncCommandOptions): Promise<number> {
  const out = new Output("sync", options.json);
  const destination = destinationFor(dest, options.global);
  const handle = options.from
    ? await resolveSourceHandle(options.from, destination)
    : { root: resolveRoot(options), isTemporary: false, cleanup: async () => {} };

  try {
    const library = await Library.open(handle.root);

    let targets = splitList(options.target);
    if (targets.length === 0) targets = library.config.sync.targets.length ? library.config.sync.targets : ["claude"];
    const requestedMode = options.link ? "link" : options.copy ? "copy" : library.config.sync.mode;
    const forbidLinkReason = handle.isTemporary ? "temporary Git source cannot be linked; copied instead" : undefined;
    const effectiveMode = forbidLinkReason && requestedMode === "link" ? "copy" : requestedMode;

    const results = await syncSkills(library, {
      dest: destination,
      targets,
      mode: requestedMode,
      dryRun: options.dryRun,
      force: options.force,
      categories: splitList(options.category),
      skills: splitList(options.skill),
      statuses: splitList(options.status),
      includeDeprecated: options.includeDeprecated,
      scope: options.global ? "user" : "project",
      sourceLabel: handle.sourceLabel,
      forbidLinkReason,
      params: options.param?.length ? parseParamPairs(options.param) : undefined
    });

    if (options.json) {
      console.log(JSON.stringify({ dryRun: Boolean(options.dryRun), mode: effectiveMode, results }, null, 2));
    } else {
      const prefix = options.dryRun ? "(dry run) " : "";
      const summary = (result: TargetResult) =>
        `${result.added.length} added, ${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.removed.length} removed (~${result.alwaysLoadedTokens} always-loaded tokens)`;
      for (const result of results) {
        out.info(`${prefix}${result.target} -> ${displayPath(result.path)}: ${summary(result)}`);
        for (const name of result.added) out.print(`   + ${name}`);
        for (const name of result.updated) out.print(`   ~ ${name}`);
        for (const name of result.removed) out.print(`   - ${name}`);
        for (const entry of result.skipped) out.warn(`   skipped ${entry.skill}: ${entry.reason}`);
        for (const warning of result.warnings) out.warn(`   ${warning}`);
      }
    }

    if (!options.dryRun && !isTelemetryOptedOut()) {
      const telemetry = resolveTelemetrySettings(library.config);
      if (telemetry.enabled && telemetry.endpoint) {
        try {
          const libName = library.config.name
            ? libraryDisplayName(library)
            : handle.sourceLabel || libraryDisplayName(library);
          const syncEvents = buildSyncAppliedEvents(library, results, {
            dest: destination,
            mode: effectiveMode,
            scope: options.global ? "user" : "project",
            libraryName: libName
          });
          await sendTelemetryEvents(syncEvents, telemetry, { queueOnFailure: true });
        } catch {
          // Opt-in telemetry must never break `skanvil sync`.
        }
      }
    }
    return 0;
  } finally {
    await handle.cleanup();
  }
}

/** Options of `skanvil stats`. */
export interface StatsCommandOptions extends CommonOptions {
  /** `--category`: only include skills of this category. */
  category?: string;
  /** `--skill`: only inspect one skill. */
  skill?: string;
  /** `--sort`: sort order (`tokens`, `lines` or `name`). */
  sort?: "tokens" | "lines" | "name";
}

/**
 * `skanvil stats`: prints 3-stage context-budget metrics (`name` + `description`, `SKILL.md`
 * body, and `references/` / `scripts/` / `assets/`).
 *
 * @param options - Parsed CLI options.
 * @returns Exit code (`0` on success).
 */
export async function statsCommand(options: StatsCommandOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("stats", options.json);
  const result = await analyzeLibraryStats(library, {
    category: options.category,
    skill: options.skill,
    sort: options.sort
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.count === 0) {
    out.info("No validated skills found.");
    return 0;
  }

  const width = Math.max(5, ...result.skills.map((skill) => skill.name.length));
  out.print(
    `${"SKILL".padEnd(width)}  ${"STAGE 1".padStart(8)}  ${"LINES".padStart(5)}  ${"BODY TOK".padStart(8)}  ${"RESOURCES".padStart(12)}  ${"UNUSED".padStart(6)}`
  );
  for (const skill of result.skills) {
    const stage1 = `~${skill.alwaysLoaded.estimatedTokens}t`.padStart(8);
    const lines = String(skill.body.lines).padStart(5);
    const bodyTok = `~${skill.body.estimatedTokens}t`.padStart(8);
    const resources = `${skill.resources.files} (${skill.resources.estimatedTokens}t)`.padStart(12);
    const unused = String(skill.resources.unreferencedFiles.length).padStart(6);
    out.print(`${skill.name.padEnd(width)}  ${stage1}  ${lines}  ${bodyTok}  ${resources}  ${unused}`);
  }
  out.info(
    `Totals: ~${result.totals.alwaysLoadedTokens} always-loaded tokens, ${result.totals.bodyLines} lines (~${result.totals.bodyTokens} tokens), ${result.totals.resourceFiles} resource(s) (~${result.totals.resourceTokens} tokens) across ${result.count} skill(s).`
  );
  if (result.totals.unreferencedFiles > 0) {
    out.warn(
      `${result.totals.unreferencedFiles} unreferenced resource file(s) found; run 'skanvil validate' for details.`
    );
  }
  return 0;
}

/** Options of `skanvil build`. */
export interface BuildCommandOptions extends CommonOptions {
  /** `--out`: output folder relative to the library root. */
  out?: string;
  /** `--force`: build even with validation errors. */
  force?: boolean;
}

/**
 * `skanvil build`: generates the library's importable package (`dist/index.mjs`, `index.cjs` and
 * their type declarations) with one function per skill.
 *
 * @param options - Parsed CLI options.
 * @returns Exit code.
 * @see {@link buildLibrary}
 */
export async function buildCommand(options: BuildCommandOptions): Promise<number> {
  const library = await openLibrary(options);
  const out = new Output("build", options.json);
  const result = await buildLibrary(library, { outDir: options.out, force: options.force });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  out.success(`Built ${result.skills.length} skill(s) into ${displayPath(result.outDir)}`);
  for (const skill of result.skills) {
    const params = skill.params.length ? ` (params: ${skill.params.join(", ")})` : "";
    out.print(`   ${skill.exportName}  ${skill.name}${params}`);
  }
  return 0;
}

/** Options of `skanvil diff`. */
export interface DiffCommandOptions extends CommonOptions {
  /** `--format`: `text` or `markdown`. */
  format?: "text" | "markdown" | string;
}

/**
 * `skanvil diff [baseRef]`: compares the current library against a Git ref to show changed
 * skills, Stage-1 token deltas, new validation diagnostics, and trigger regressions.
 *
 * @param baseRef - Git ref to compare against (default: `HEAD`).
 * @param options - Parsed CLI options.
 * @returns Exit code (`0`).
 */
export async function diffCommand(baseRef: string | undefined, options: DiffCommandOptions): Promise<number> {
  if (options.json && options.format) {
    throw new Error("Do not combine --json with --format.");
  }
  const format = (options.format ?? "text").trim();
  if (format !== "text" && format !== "markdown") {
    throw new Error(`Invalid diff format '${format}'. Use 'text' or 'markdown'.`);
  }

  const library = await openLibrary(options);
  const out = new Output("diff", options.json);
  const diff = await diffLibrary(library, { baseRef });

  if (options.json) {
    console.log(JSON.stringify(diff, null, 2));
    return 0;
  }
  if (format === "markdown") {
    process.stdout.write(formatDiffMarkdown(diff));
    return 0;
  }

  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const budgetNote = diff.stage1Tokens.budget ? ` / ${diff.stage1Tokens.budget} budget` : "";
  out.info(
    `Comparing against ${diff.baseRef}: Stage-1 ~${diff.stage1Tokens.base} -> ~${diff.stage1Tokens.current} (${sign(diff.stage1Tokens.delta)}${budgetNote}), ${diff.added.length} added, ${diff.modified.length} modified, ${diff.removed.length} removed, ${diff.unchangedCount} unchanged.`
  );
  for (const entry of diff.added) {
    out.print(`   + ${entry.skill} (+${entry.stage1TokenDelta} Stage-1 tokens, ${entry.currentLines} lines)`);
  }
  for (const entry of diff.modified) {
    const notes = [
      `${sign(entry.stage1TokenDelta)} Stage-1 tokens`,
      `${sign(entry.lineDelta)} lines`,
      ...(entry.statusChange ? [`status ${entry.statusChange.from}->${entry.statusChange.to}`] : []),
      ...(entry.ownerChange ? [`owner ${entry.ownerChange.from}->${entry.ownerChange.to}`] : []),
      ...(entry.replacedByChange ? [`replaced-by ${entry.replacedByChange.from}->${entry.replacedByChange.to}`] : []),
      ...entry.paramChanges
    ];
    out.print(`   ~ ${entry.skill} (${notes.join(", ")})`);
  }
  for (const entry of diff.removed) {
    out.print(`   - ${entry.skill} (${sign(entry.stage1TokenDelta)} Stage-1 tokens)`);
  }
  for (const item of diff.newDiagnostics) {
    const label = item.skill ? `${item.skill}: ` : "";
    const msg = `   new [${item.rule}] ${label}${item.message}`;
    if (item.severity === "error") out.error(msg);
    else out.warn(msg);
  }
  for (const reg of diff.triggerRegressions) {
    out.warn(`   trigger regression [${reg.skill}/${reg.kind}]: "${reg.prompt}" (${reg.reason ?? "failed"})`);
  }
  return 0;
}
