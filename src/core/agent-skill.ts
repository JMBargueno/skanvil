/**
 * The `skanvil` agent skill: a SKILL.md shipped with the package that teaches coding agents how to
 * use the CLI. `init` installs it into new libraries, and `install-skill` into any project.
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";

import { exists } from "../util/fs.js";
import { PACKAGE_ROOT, packageVersion } from "../util/paths.js";
import { SkillFile } from "./skill.js";
import { resolveTarget, type TargetScope } from "./sync.js";

/** Folder and frontmatter name of the agent skill. */
export const AGENT_SKILL_NAME = "skanvil";

/**
 * Frontmatter `metadata` key stamped on installed copies with the skanvil version that installed
 * them. Its presence marks a folder as managed by skanvil, so it may be updated.
 */
export const AGENT_SKILL_VERSION_KEY = "skanvil-version";

/** @returns Absolute path of the agent skill shipped with the package (`agent-skill/skanvil`). */
export function agentSkillSource(): string {
  return path.join(PACKAGE_ROOT, "agent-skill", AGENT_SKILL_NAME);
}

/** Options of {@link installAgentSkill}. */
export interface InstallAgentSkillOptions {
  /** Project root that receives the skill. */
  dest: string;
  /** Target presets (`claude`, `copilot`, `agents`, `codex`) or paths relative to `dest`. */
  targets: string[];
  /**
   * Replace an existing `skanvil` folder that skanvil did not install, and reinstall even when
   * the installed version is current. @defaultValue `false`
   */
  force?: boolean;
  /** Install into the project (`dest`) or the user's home folder (`--global`). @defaultValue `"project"` */
  scope?: TargetScope;
  /** Home folder for the `user` scope. @defaultValue `os.homedir()` */
  homeDir?: string;
}

/** Outcome of {@link installAgentSkill} for one target. */
export interface AgentSkillResult {
  /** Target as given. */
  target: string;
  /** Absolute path of the installed skill folder. */
  path: string;
  /**
   * What happened:
   * - `installed`: the skill was new in this target;
   * - `updated`: an older skanvil-installed copy was replaced;
   * - `unchanged`: the same version was already installed;
   * - `skipped`: a foreign folder exists and `force` is not set.
   */
  status: "installed" | "updated" | "unchanged" | "skipped";
  /** Explanation when `status` is `skipped`. */
  reason?: string;
}

async function installedVersion(dir: string): Promise<string | null> {
  try {
    const skill = SkillFile.parse(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"));
    return skill.getString("metadata", AGENT_SKILL_VERSION_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Installs or updates the `skanvil` agent skill in the agent skill folders of a project. The
 * installed `SKILL.md` is stamped with `metadata.skanvil-version`, so later runs know they own it.
 *
 * @remarks A `skanvil` folder without that stamp was written by someone else and is never
 * overwritten unless `force` is set.
 *
 * @param options - Destination, targets and scope.
 * @returns One result per target, in the order given.
 * @throws Error when a target is invalid (see {@link resolveTarget}); nothing is written then.
 *
 * @example
 * ```ts
 * const [result] = await installAgentSkill({ dest: ".", targets: ["claude"] });
 * result.status; // "installed" | "updated" | "unchanged" | "skipped"
 * ```
 */
export async function installAgentSkill(options: InstallAgentSkillOptions): Promise<AgentSkillResult[]> {
  const version = packageVersion();
  const results: AgentSkillResult[] = [];

  // Resolve every target first, so an invalid one fails before anything is written.
  const destinations = options.targets.map((target) =>
    path.join(resolveTarget(options.dest, target, { scope: options.scope, homeDir: options.homeDir }), AGENT_SKILL_NAME)
  );

  for (const [index, target] of options.targets.entries()) {
    const destination = destinations[index];
    const present = await exists(destination);
    const current = present ? await installedVersion(destination) : null;

    if (present && current === null && !options.force) {
      results.push({
        target,
        path: destination,
        status: "skipped",
        reason: "a 'skanvil' skill folder exists that skanvil did not install (use --force to replace it)"
      });
      continue;
    }
    if (current === version && !options.force) {
      results.push({ target, path: destination, status: "unchanged" });
      continue;
    }

    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(agentSkillSource(), destination, { recursive: true });
    const skillPath = path.join(destination, "SKILL.md");
    const skill = SkillFile.parse(await fs.readFile(skillPath, "utf8"));
    skill.set(["metadata", AGENT_SKILL_VERSION_KEY], version);
    await fs.writeFile(skillPath, skill.toString(), "utf8");

    results.push({ target, path: destination, status: present ? "updated" : "installed" });
  }
  return results;
}
