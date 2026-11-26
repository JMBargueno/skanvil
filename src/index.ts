/**
 * Programmatic API of skanvil: everything the CLI does, available as functions.
 *
 * Start with {@link Library.open} to load a library. Then use:
 * - {@link scaffoldSkill}, {@link editSkill} and {@link removeSkill} to change skills;
 * - {@link validateLibrary} to check it;
 * - {@link rebuildIndex} and {@link doctor} to maintain the README index;
 * - {@link syncSkills} to install skills into agent folders;
 * - {@link buildLibrary} to generate a library's typed npm exports, and {@link renderTemplate} for parametrized skills.
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
  FEEDBACK_SKILL_NAME,
  agentSkillSource,
  feedbackSkillSource,
  installAgentSkill,
  type AgentSkillResult,
  type InstallAgentSkillOptions
} from "./core/agent-skill.js";
export { buildLibrary, exportNames, type BuildOptions, type BuildResult, type BuiltSkill } from "./core/build.js";
export { Categories } from "./core/categories.js";
export {
  CONFIG_FILE,
  ConfigSchema,
  DEFAULT_CATEGORIES,
  DEFAULT_MAX_DESCRIPTION_TOKENS,
  DEFAULT_OVERLAP_THRESHOLD,
  DEFAULT_SEMANTIC_OVERLAP_THRESHOLD,
  DEFAULT_TELEMETRY_TIMEOUT_MS,
  DEFAULT_VAGUE_FALLBACKS,
  SKILL_STATUSES,
  configJsonSchema,
  loadConfig,
  resolveConfig,
  type Category,
  type RawConfig,
  type ResolvedConfig,
  type Severity,
  type SkillStatus
} from "./core/config.js";
export {
  diffLibrary,
  formatDiffMarkdown,
  type DiffOptions,
  type LibraryDiffResult,
  type SkillDiffEntry,
  type TriggerRegression,
  type ValidationRegression
} from "./core/diff.js";
export { doctor, type DoctorOptions, type DoctorResult } from "./core/doctor.js";
export {
  EVALS_FILE,
  EVAL_SPLITS,
  EvalsFileSchema,
  checkTriggerRouting,
  exportEvalDataset,
  parseEvals,
  readEvals,
  routePrompt,
  type EvalCase,
  type EvalExportFormat,
  type EvalSplit,
  type ExportEvalOptions,
  type ExportEvalResult,
  type RouteCandidate,
  type RoutePromptOptions,
  type RoutePromptResult,
  type SkillEvals,
  type SplitSummary,
  type TriggerCheckItem,
  type TriggerCheckOptions,
  type TriggerCheckResult,
  type TriggerEntry
} from "./core/evals.js";
export {
  EVAL_PROVIDERS,
  runEvalCases,
  type EvalCaseRunOutcome,
  type EvalCompletionFn,
  type EvalCompletionRequest,
  type EvalProvider,
  type EvalRunOptions,
  type EvalRunResult
} from "./core/eval-runner.js";
export {
  FEEDBACK_FILE,
  promoteFeedback,
  readFeedbackLog,
  summarizeFeedback,
  type FeedbackEntry,
  type FeedbackGroup,
  type FeedbackReadResult,
  type FeedbackSuggestedEvalCase,
  type FeedbackSummary,
  type InvalidFeedbackLine,
  type PromoteFeedbackOptions,
  type PromoteFeedbackResult,
  type PromotedCase,
  type SkippedFeedback,
  type SummarizeFeedbackOptions
} from "./core/feedback.js";
export {
  importSkills,
  type ImportSkillsOptions,
  type ImportSkillsResult,
  type ImportedSkillItem
} from "./core/import.js";
export { createLibrary, parseProfile, type CreateLibraryOptions } from "./core/init.js";
export { Library, type SkillInfo } from "./core/library.js";
export {
  PARAMS_FILE,
  findUndeclaredParams,
  parseParamPairs,
  parseParams,
  readParams,
  renderTemplate,
  resolveParamValues,
  type ParamDefinition,
  type ParamDefinitions,
  type ParamValues
} from "./core/params.js";
export { rebuildIndex, reconcileIndex } from "./core/reindex.js";
export { SkillFile } from "./core/skill.js";
export { editSkill, removeSkill, scaffoldSkill, type AddSkillOptions, type EditSkillOptions } from "./core/skills.js";
export {
  analyzeLibraryStats,
  type BodyStats,
  type LibraryStats,
  type ResourceStats,
  type SkillStats,
  type StageStats,
  type StatsOptions
} from "./core/stats.js";
export {
  MANIFEST_FILE,
  TARGET_PRESETS,
  USER_TARGET_PRESETS,
  checkOutdatedSkills,
  parseGitSource,
  readManifestPinnedSha,
  resolveSource,
  resolveSourceHandle,
  resolveTarget,
  syncSkills,
  type InstalledSkillEntry,
  type ManifestSourceEntry,
  type ManifestV2,
  type OutdatedOptions,
  type OutdatedReport,
  type OutdatedSourceEntry,
  type ParsedGitSource,
  type ResolveSourceHandleOptions,
  type ResolveTargetOptions,
  type ResolvedSourceHandle,
  type SyncOptions,
  type TargetResult,
  type TargetScope
} from "./core/sync.js";
export {
  TELEMETRY_SCHEMA_VERSION,
  LibrarySnapshotEventSchema,
  SkillFeedbackEventSchema,
  SkillInvokedEventSchema,
  SnapshotSkillSchema,
  SyncAppliedEventSchema,
  TelemetryBatchSchema,
  TelemetryEventSchema,
  buildFeedbackEvents,
  buildLibrarySnapshotEvent,
  buildSkillInvokedEvent,
  buildSyncAppliedEvents,
  defaultTelemetryQueuePath,
  enqueueTelemetryEvents,
  fetchHubSkillsAudit,
  flushTelemetryQueue,
  hashIdentifier,
  isTelemetryOptedOut,
  libraryDisplayName,
  redactTelemetryText,
  resolveTelemetrySettings,
  sendTelemetryEvents,
  tryAutoFlushTelemetryQueue,
  type BuildSkillInvokedOptions,
  type HubAuditResult,
  type HubSkillAuditRow,
  type LibrarySnapshotEvent,
  type ResolvedTelemetrySettings,
  type SkillFeedbackEvent,
  type SkillInvokedEvent,
  type SnapshotBuildOptions,
  type SyncAppliedEvent,
  type TelemetryEvent,
  type TelemetryFlushResult,
  type TelemetrySendResult,
  type TelemetrySettingsOverrides
} from "./core/telemetry.js";
export {
  HOOK_AGENTS,
  collectTranscriptEvents,
  defaultTelemetrySessionsDir,
  installTelemetryHooks,
  parseAgentHookPayload,
  parseTranscriptFile,
  processAgentHookPayload,
  type HookInstallItem,
  type HookInstallTarget,
  type InstallHooksOptions,
  type InstallHooksResult,
  type ParsedHookSignal,
  type TranscriptParseOptions
} from "./core/telemetry-hooks.js";
export { ejectSkillTemplate, resolveSkillTemplate } from "./core/templates.js";
export {
  canonicalizeSemanticTokens,
  cosineSimilarity,
  estimateTokens,
  extractSection,
  jaccardSimilarity,
  semanticSimilarity,
  stripFencedCode,
  tokenizeForSimilarity
} from "./core/text.js";
export {
  RULES,
  fetchEmbeddings,
  findBrokenReferences,
  findUnusedResources,
  formatDiagnostic,
  validateLibrary,
  type Diagnostic,
  type RuleDefinition,
  type ValidateLibraryOptions,
  type ValidationResult
} from "./core/validate.js";
export {
  formatGitHubAnnotations,
  formatSarif,
  resolveDiagnosticFile,
  type ValidateOutputFormat
} from "./core/validate-format.js";
export { collectSkills, type ListFilterOptions, type ListedSkill } from "./commands/skills.js";
