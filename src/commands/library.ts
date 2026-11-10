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
import { doctor } from "../core/doctor.js";
import { createLibrary } from "../core/init.js";
import { rebuildIndex } from "../core/reindex.js";
import { syncSkills, type TargetResult } from "../core/sync.js";
import { resolveSource } from "../core/sync.js";
import { Library } from "../core/library.js";
import { ejectSkillTemplate } from "../core/templates.js";
import { formatDiagnostic, validateLibrary } from "../core/validate.js";
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
    agentSkill: options.agentSkill
  });

  out.info(`Created library '${result.name}' in ${displayPath(result.target)}`);
  for (const installed of result.agentSkill) {
    out.info(`Installed the skanvil agent skill in ${path.relative(result.target, installed.path)}`);
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
}

/**
 * `skanvil validate`: prints the diagnostics, or with `--json` prints
 * `{ ok, diagnostics, count, errors, warnings }`.
 *
 * @param options - Parsed CLI options.
 * @returns 1 when there are errors (or warnings with `--strict`), otherwise 0.
 */
export async function validateCommand(options: ValidateOptions): Promise<number> {
  const library = await openLibrary(options);
  const result = await validateLibrary(library, { skill: options.skill });
  const blocking = result.errors + (options.strict ? result.warnings : 0);
  if (options.json) {
    console.log(JSON.stringify({ ok: blocking === 0, ...result }, null, 2));
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
  const result = await doctor(library, { fix: options.fix });
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
    scope: options.global ? "user" : "project"
  });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      if (result.status === "skipped") out.warn(`${result.target}: skipped (${result.reason})`);
      else out.success(`${result.target}: ${result.status} ${displayPath(result.path)}`);
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
  /** `--global`: install into the user's home folders instead of a project. */
  global?: boolean;
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
  const root = options.from ? await resolveSource(options.from, destination) : resolveRoot(options);
  const library = await Library.open(root);

  let targets = splitList(options.target);
  if (targets.length === 0) targets = library.config.sync.targets.length ? library.config.sync.targets : ["claude"];
  const mode = options.link ? "link" : options.copy ? "copy" : library.config.sync.mode;

  const results = await syncSkills(library, {
    dest: destination,
    targets,
    mode,
    dryRun: options.dryRun,
    force: options.force,
    categories: splitList(options.category),
    skills: splitList(options.skill),
    scope: options.global ? "user" : "project"
  });

  if (options.json) {
    console.log(JSON.stringify({ dryRun: Boolean(options.dryRun), mode, results }, null, 2));
    return 0;
  }

  const prefix = options.dryRun ? "(dry run) " : "";
  const summary = (result: TargetResult) =>
    `${result.added.length} added, ${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.removed.length} removed`;
  for (const result of results) {
    out.info(`${prefix}${result.target} -> ${displayPath(result.path)}: ${summary(result)}`);
    for (const name of result.added) out.print(`   + ${name}`);
    for (const name of result.updated) out.print(`   ~ ${name}`);
    for (const name of result.removed) out.print(`   - ${name}`);
    for (const entry of result.skipped) out.warn(`   skipped ${entry.skill}: ${entry.reason}`);
    for (const warning of result.warnings) out.warn(`   ${warning}`);
  }
  return 0;
}
