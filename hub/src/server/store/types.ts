import type {
  AdoptionResponse,
  BudgetsResponse,
  FeedbackResponse,
  LibrariesResponse,
  OverviewResponse,
  SkillsAnalyticsResponse,
  TelemetryEvent
} from "../../shared/schema.js";

export interface AnalyticsQuery {
  library?: string;
  days: number;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
}

/**
 * Storage abstraction for skanvil-hub telemetry ingestion and analytics.
 * Default implementation uses SQLite via `node:sqlite`; a PostgreSQL adapter can implement
 * the same contract without changing HTTP routes or dashboard queries.
 */
export interface TelemetryStore {
  init(): Promise<void>;
  close(): Promise<void>;
  ingestEvents(events: readonly TelemetryEvent[]): Promise<IngestResult>;
  listLibraries(): Promise<LibrariesResponse>;
  getOverview(query: AnalyticsQuery): Promise<OverviewResponse>;
  getSkillsAnalytics(query: AnalyticsQuery): Promise<SkillsAnalyticsResponse>;
  getBudgetsHistory(query: AnalyticsQuery): Promise<BudgetsResponse>;
  getFeedbackSummary(query: AnalyticsQuery): Promise<FeedbackResponse>;
  getSyncAdoption(query: AnalyticsQuery): Promise<AdoptionResponse>;
}
