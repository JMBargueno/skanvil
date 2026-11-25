/**
 * Bundled agent skills shipped with skanvil (`skanvil` and `skanvil-feedback`).
 * `init` installs them into new libraries, and `install-skill` installs them into any project.
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";

import { exists } from "../util/fs.js";
import { PACKAGE_ROOT, packageVersion } from "../util/paths.js";
import { SkillFile } from "./skill.js";
import { resolveTarget, type TargetScope } from "./sync.js";

/** Folder and frontmatter name of the primary CLI agent skill. */
export const AGENT_SKILL_NAME = "skanvil";

/** Folder and frontmatter name of the bundled skill-friction feedback agent skill. */
export const FEEDBACK_SKILL_NAME = "skanvil-feedback";

/**
 * Frontmatter `metadata` key stamped on installed copies with the skanvil version that installed
 * them. Its presence marks a folder as managed by skanvil, so it may be updated.
 */
export const AGENT_SKILL_VERSION_KEY = "skanvil-version";

/** @returns Absolute path of the `skanvil` agent skill shipped with the package (`agent-skill/skanvil`). */
export function agentSkillSource(): string {
  return path.join(PACKAGE_ROOT, "agent-skill", AGENT_SKILL_NAME);
}

/** @returns Absolute path of the `skanvil-feedback` agent skill shipped with the package (`agent-skill/skanvil-feedback`). */
export function feedbackSkillSource(): string {
  return path.join(PACKAGE_ROOT, "agent-skill", FEEDBACK_SKILL_NAME);
}

/** Options of {@link installAgentSkill}. */
export interface InstallAgentSkillOptions {
  /** Project root that receives the skill(s). */
  dest: string;
  /** Target presets (`claude`, `copilot`, `agents`, `codex`) or paths relative to `dest`. */
  targets: string[];
  /**
   * Replace an existing skanvil-named folder that skanvil did not install, and reinstall even when
   * the installed version is current. @defaultValue `false`
   */
  force?: boolean;
  /** Install into the project (`dest`) or the user's home folder (`--global`). @defaultValue `"project"` */
  scope?: TargetScope;
  /** Home folder for the `user` scope. @defaultValue `os.homedir()` */
  homeDir?: string;
  /**
   * Also install the `skanvil-feedback` skill so agents can log structured skill friction reports.
   * @defaultValue `true`
   */
  includeFeedback?: boolean;
}

/** Outcome of {@link installAgentSkill} for one skill in one target. */
export interface AgentSkillResult {
  /** Skill folder name (`skanvil` or `skanvil-feedback`). */
  skill: string;
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
 * Installs or updates the `skanvil` (and by default `skanvil-feedback`) agent skill in the agent
 * skill folders of a project. Each installed `SKILL.md` is stamped with `metadata.skanvil-version`,
 * so later runs know they own it.
 *
 * @remarks A folder without that stamp was written by someone else and is never overwritten unless
 * `force` is set.
 *
 * @param options - Destination, targets, scope and feedback option.
 * @returns One result per `(target, skill)` pair, in target order.
 * @throws Error when a target is invalid (see {@link resolveTarget}); nothing is written then.
 *
 * @example
 * ```ts
 * const results = await installAgentSkill({ dest: ".", targets: ["claude"] });
 * results.map((r) => `${r.skill}:${r.status}`); // ["skanvil:installed", "skanvil-feedback:installed"]
 * ```
 */
export async function installAgentSkill(options: InstallAgentSkillOptions): Promise<AgentSkillResult[]> {
  const version = packageVersion();
  const skills = [
    { name: AGENT_SKILL_NAME, source: agentSkillSource() },
    ...(options.includeFeedback !== false ? [{ name: FEEDBACK_SKILL_NAME, source: feedbackSkillSource() }] : [])
  ];

  // Resolve every target first, so an invalid one fails before anything is written.
  const targetDirs = options.targets.map((target) => ({
    target,
    dir: resolveTarget(options.dest, target, { scope: options.scope, homeDir: options.homeDir })
  }));

  const results: AgentSkillResult[] = [];
  for (const { target, dir } of targetDirs) {
    for (const skillEntry of skills) {
      const destination = path.join(dir, skillEntry.name);
      const present = await exists(destination);
      const current = present ? await installedVersion(destination) : null;

      if (present && current === null && !options.force) {
        results.push({
          skill: skillEntry.name,
          target,
          path: destination,
          status: "skipped",
          reason: `a '${skillEntry.name}' skill folder exists that skanvil did not install (use --force to replace it)`
        });
        continue;
      }
      if (current === version && !options.force) {
        results.push({ skill: skillEntry.name, target, path: destination, status: "unchanged" });
        continue;
      }

      await fs.rm(destination, { recursive: true, force: true });
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(skillEntry.source, destination, { recursive: true });
      const skillPath = path.join(destination, "SKILL.md");
      const skill = SkillFile.parse(await fs.readFile(skillPath, "utf8"));
      skill.set(["metadata", AGENT_SKILL_VERSION_KEY], version);
      await fs.writeFile(skillPath, skill.toString(), "utf8");

      results.push({ skill: skillEntry.name, target, path: destination, status: present ? "updated" : "installed" });
    }
  }
  return results;
}
