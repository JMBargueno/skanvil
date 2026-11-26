import { z } from "zod";

export const TELEMETRY_SCHEMA_VERSION = 1;

const IsoTimestampSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "timestamp must be a valid ISO-8601 date");

const EnvelopeFields = {
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  eventId: z.string().min(1),
  timestamp: IsoTimestampSchema,
  library: z.string().min(1),
  skanvilVersion: z.string().min(1)
};

export const SnapshotSkillSchema = z
  .object({
    name: z.string().min(1),
    category: z.string().min(1),
    status: z.string().optional(),
    owner: z.string().optional(),
    replacedBy: z.string().optional(),
    stage1Tokens: z.number().int().nonnegative(),
    bodyLines: z.number().int().nonnegative(),
    bodyTokens: z.number().int().nonnegative(),
    resourceFiles: z.number().int().nonnegative(),
    unreferencedFiles: z.number().int().nonnegative(),
    evalCases: z.number().int().nonnegative(),
    evalTriggers: z.number().int().nonnegative(),
    valid: z.boolean()
  })
  .strict();

export const LibrarySnapshotEventSchema = z
  .object({
    ...EnvelopeFields,
    type: z.literal("library.snapshot"),
    projectHash: z.string().min(1).optional(),
    gitSha: z.string().min(1).optional(),
    gitBranch: z.string().min(1).optional(),
    totals: z
      .object({
        skills: z.number().int().nonnegative(),
        alwaysLoadedTokens: z.number().int().nonnegative(),
        bodyTokens: z.number().int().nonnegative(),
        bodyLines: z.number().int().nonnegative(),
        resourceFiles: z.number().int().nonnegative(),
        resourceTokens: z.number().int().nonnegative(),
        unreferencedFiles: z.number().int().nonnegative()
      })
      .strict(),
    validation: z
      .object({
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative()
      })
      .strict(),
    evals: z
      .object({
        totalTriggers: z.number().int().nonnegative(),
        passedTriggers: z.number().int().nonnegative(),
        failedTriggers: z.number().int().nonnegative()
      })
      .strict(),
    skills: z.array(SnapshotSkillSchema)
  })
  .strict();

export const SyncAppliedEventSchema = z
  .object({
    ...EnvelopeFields,
    type: z.literal("sync.applied"),
    projectHash: z.string().min(1),
    target: z.string().min(1),
    scope: z.enum(["project", "user"]),
    mode: z.enum(["copy", "link"]),
    added: z.array(z.string()),
    updated: z.array(z.string()),
    unchanged: z.array(z.string()),
    removed: z.array(z.string()),
    skipped: z.array(z.object({ skill: z.string(), reason: z.string() }).strict()),
    installedSkills: z.array(z.string()),
    alwaysLoadedTokens: z.number().int().nonnegative()
  })
  .strict();

export const SkillInvokedEventSchema = z
  .object({
    ...EnvelopeFields,
    type: z.literal("skill.invoked"),
    skill: z.string().min(1),
    agent: z.string().min(1),
    model: z.string().optional(),
    projectHash: z.string().optional(),
    sessionHash: z.string().optional(),
    skillVersion: z.string().optional(),
    owner: z.string().optional(),
    outcome: z.enum(["success", "error", "friction", "unknown"]),
    durationMs: z.number().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    failedToolCalls: z.number().int().nonnegative().optional(),
    stage1Tokens: z.number().int().nonnegative().optional(),
    source: z.enum(["hook", "cli", "manual", "transcript"]).optional()
  })
  .strict();

export const SkillFeedbackEventSchema = z
  .object({
    ...EnvelopeFields,
    type: z.literal("skill.feedback"),
    skill: z.string().min(1),
    step: z.string().min(1),
    symptom: z.string().min(1),
    proposedFix: z.string().optional(),
    hasSuggestedEvalCase: z.boolean(),
    projectHash: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    reportedAt: z.string().optional()
  })
  .strict();

export const TelemetryEventSchema = z.discriminatedUnion("type", [
  LibrarySnapshotEventSchema,
  SyncAppliedEventSchema,
  SkillInvokedEventSchema,
  SkillFeedbackEventSchema
]);

export const TelemetryBatchSchema = z
  .object({
    events: z.array(TelemetryEventSchema).min(1).max(500)
  })
  .strict();

export type SnapshotSkill = z.infer<typeof SnapshotSkillSchema>;
export type LibrarySnapshotEvent = z.infer<typeof LibrarySnapshotEventSchema>;
export type SyncAppliedEvent = z.infer<typeof SyncAppliedEventSchema>;
export type SkillInvokedEvent = z.infer<typeof SkillInvokedEventSchema>;
export type SkillFeedbackEvent = z.infer<typeof SkillFeedbackEventSchema>;
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;

export interface LibrarySummary {
  library: string;
  latestSnapshotAt: string | null;
  skillsCount: number;
  alwaysLoadedTokens: number;
  evalPassRate: number | null;
  validationErrors: number;
  validationWarnings: number;
  totalInvocations: number;
  syncedProjects: number;
}

export interface LibrariesResponse {
  libraries: LibrarySummary[];
}

export interface OverviewDailyPoint {
  date: string;
  invocations: number;
  errors: number;
  feedback: number;
}

export interface BreakdownItem {
  name: string;
  count: number;
}

export interface OverviewResponse {
  library: string | null;
  days: number;
  totalInvocations: number;
  successCount: number;
  errorCount: number;
  frictionCount: number;
  successRate: number | null;
  activeSkills: number;
  catalogSkills: number;
  zombieSkills: number;
  wastedStage1Tokens: number;
  alwaysLoadedTokens: number;
  evalPassRate: number | null;
  activeProjects: number;
  feedbackCount: number;
  daily: OverviewDailyPoint[];
  byAgent: BreakdownItem[];
  byModel: BreakdownItem[];
}

export interface SkillAnalyticsRow {
  library: string;
  skill: string;
  category: string | null;
  owner: string | null;
  status: string | null;
  replacedBy: string | null;
  stage1Tokens: number | null;
  bodyLines: number | null;
  evalCases: number;
  evalTriggers: number;
  valid: boolean | null;
  invocations: number;
  successCount: number;
  errorCount: number;
  frictionEvents: number;
  frictionRate: number | null;
  avgDurationMs: number | null;
  avgToolCalls: number | null;
  syncedProjects: number;
  lastUsedAt: string | null;
  isZombie: boolean;
  agents: Record<string, number>;
}

export interface SkillsAnalyticsResponse {
  library: string | null;
  days: number;
  skills: SkillAnalyticsRow[];
}

export interface BudgetHistoryPoint {
  eventId: string;
  library: string;
  timestamp: string;
  gitSha: string | null;
  gitBranch: string | null;
  skillsCount: number;
  alwaysLoadedTokens: number;
  bodyTokens: number;
  resourceTokens: number;
  validationErrors: number;
  validationWarnings: number;
  evalTotal: number;
  evalPassed: number;
  evalFailed: number;
  evalPassRate: number | null;
}

export interface BudgetsResponse {
  library: string | null;
  days: number;
  snapshots: BudgetHistoryPoint[];
}

export interface FeedbackGroupRow {
  library: string;
  skill: string;
  step: string;
  symptom: string;
  count: number;
  suggestedEvalCaseCount: number;
  proposedFixes: string[];
  latestTimestamp: string;
}

export interface FeedbackEventRow {
  eventId: string;
  library: string;
  skill: string;
  step: string;
  symptom: string;
  proposedFix: string | null;
  hasSuggestedEvalCase: boolean;
  agent: string | null;
  model: string | null;
  timestamp: string;
}

export interface FeedbackResponse {
  library: string | null;
  days: number;
  totalEvents: number;
  groups: FeedbackGroupRow[];
  recent: FeedbackEventRow[];
}

export interface ProjectSyncRow {
  projectHash: string;
  target: string;
  library: string;
  scope: string;
  mode: string;
  syncedAt: string;
  alwaysLoadedTokens: number;
  installedSkills: string[];
}

export interface DeprecatedInstalledAlert {
  projectHash: string;
  target: string;
  library: string;
  skill: string;
  replacedBy: string | null;
  syncedAt: string;
}

export interface AdoptionResponse {
  library: string | null;
  totalSyncedProjects: number;
  byTarget: BreakdownItem[];
  projects: ProjectSyncRow[];
  deprecatedInstalled: DeprecatedInstalledAlert[];
}

export interface AuthStatusResponse {
  authRequired: boolean;
  authenticated: boolean;
  ingestionProtected: boolean;
}
