/**
 * Programmatic API of skanvil: everything the CLI does, available as functions.
 *
 * Start with {@link Library.open} to load a library. Then use:
 * - {@link scaffoldSkill}, {@link editSkill} and {@link removeSkill} to change skills;
 * - {@link validateLibrary} to check it;
 * - {@link rebuildIndex} and {@link doctor} to maintain the README index;
 * - {@link syncSkills} to install skills into agent folders.
 *
 * @example
 * ```ts
 * import { Library, scaffoldSkill, validateLibrary, syncSkills } from "skanvil";
 *
 * const lib = await Library.open("./my-skills");
 * await scaffoldSkill(lib, { type: "front", name: "a11y", description: "Audits accessibility." });
 * const { errors } = await validateLibrary(lib);
 * if (errors === 0) await syncSkills(lib, { dest: "../app", targets: ["claude"] });
 * ```
 *
 * @packageDocumentation
 */
export {
  AGENT_SKILL_NAME,
  agentSkillSource,
  installAgentSkill,
  type AgentSkillResult,
  type InstallAgentSkillOptions
} from "./core/agent-skill.js";
export { Categories } from "./core/categories.js";
export {
  CONFIG_FILE,
  ConfigSchema,
  DEFAULT_CATEGORIES,
  configJsonSchema,
  loadConfig,
  resolveConfig,
  type Category,
  type RawConfig,
  type ResolvedConfig,
  type Severity
} from "./core/config.js";
export { doctor, type DoctorResult } from "./core/doctor.js";
export { createLibrary, parseProfile, type CreateLibraryOptions } from "./core/init.js";
export { Library, type SkillInfo } from "./core/library.js";
export { rebuildIndex, reconcileIndex } from "./core/reindex.js";
export { SkillFile } from "./core/skill.js";
export { editSkill, removeSkill, scaffoldSkill, type AddSkillOptions, type EditSkillOptions } from "./core/skills.js";
export {
  MANIFEST_FILE,
  TARGET_PRESETS,
  USER_TARGET_PRESETS,
  resolveTarget,
  syncSkills,
  type ResolveTargetOptions,
  type SyncOptions,
  type TargetResult,
  type TargetScope
} from "./core/sync.js";
export { ejectSkillTemplate, resolveSkillTemplate } from "./core/templates.js";
export { RULES, formatDiagnostic, validateLibrary, type Diagnostic, type ValidationResult } from "./core/validate.js";
export { collectSkills, type ListedSkill } from "./commands/skills.js";
