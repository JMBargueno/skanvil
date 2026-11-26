import { createHash } from "node:crypto";

import type {
  AdoptionResponse,
  BudgetsResponse,
  FeedbackResponse,
  FeedbackStatus,
  FeedbackTriageRequest,
  LibrariesResponse,
  OverviewResponse,
  RetentionResult,
  SkillDetailResponse,
  SkillsAnalyticsResponse,
  TelemetryEvent
} from "../../shared/schema.js";

export interface AnalyticsQuery {
  library?: string;
  days: number;
  status?: FeedbackStatus;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
}

export interface ExportEventRow {
  eventId: string;
  type: string;
  timestamp: string;
  library: string;
  skill: string | null;
  agent: string | null;
  model: string | null;
  outcome: string | null;
  durationMs: number | null;
  toolCalls: number | null;
  failedToolCalls: number | null;
  projectHash: string | null;
  payload: TelemetryEvent;
}

export function computeFeedbackGroupKey(library: string, skill: string, step: string, symptom: string): string {
  return createHash("sha256").update(`${library}\0${skill}\0${step}\0${symptom}`).digest("hex").slice(0, 24);
}

/**
 * Storage abstraction for skanvil-hub telemetry ingestion and analytics.
 * Implemented by both SQLite (`node:sqlite`) and PostgreSQL (`pg`).
 */
export interface TelemetryStore {
  init(): Promise<void>;
  close(): Promise<void>;
  ingestEvents(events: readonly TelemetryEvent[]): Promise<IngestResult>;
  listLibraries(): Promise<LibrariesResponse>;
  getOverview(query: AnalyticsQuery): Promise<OverviewResponse>;
  getSkillsAnalytics(query: AnalyticsQuery): Promise<SkillsAnalyticsResponse>;
  getSkillDetail(library: string, skill: string, days: number): Promise<SkillDetailResponse>;
  getBudgetsHistory(query: AnalyticsQuery): Promise<BudgetsResponse>;
  getFeedbackSummary(query: AnalyticsQuery): Promise<FeedbackResponse>;
  setFeedbackTriage(input: FeedbackTriageRequest): Promise<void>;
  getSyncAdoption(query: AnalyticsQuery): Promise<AdoptionResponse>;
  pruneOldData(retentionDays: number): Promise<RetentionResult>;
  exportEvents(query: AnalyticsQuery): Promise<ExportEventRow[]>;
}
