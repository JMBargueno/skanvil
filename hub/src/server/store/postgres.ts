import pg from "pg";

import type {
  AdoptionResponse,
  BudgetsResponse,
  FeedbackResponse,
  FeedbackTriageRequest,
  LibrariesResponse,
  LibrarySummary,
  OverviewResponse,
  RetentionResult,
  SkillDetailResponse,
  SkillsAnalyticsResponse,
  TelemetryEvent
} from "../../shared/schema.js";
import {
  aggregateAdoption,
  aggregateBudgets,
  aggregateFeedbackSummary,
  aggregateOverview,
  aggregateSkillDetail,
  aggregateSkillsAnalytics,
  normalizeIso,
  sinceTimestamp,
  type FeedbackRowData,
  type InvokedRowData,
  type SnapshotRowData,
  type SyncStateRowData,
  type TriageRowData
} from "./analytics.js";
import type { AnalyticsQuery, ExportEventRow, IngestResult, TelemetryStore } from "./types.js";

export interface PgQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

export interface PgQueryClient {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PgQueryResult<R>>;
  end?(): Promise<void>;
}

const PG_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    received_at TEXT NOT NULL,
    library TEXT NOT NULL,
    skanvil_version TEXT NOT NULL,
    project_hash TEXT,
    session_hash TEXT,
    skill TEXT,
    agent TEXT,
    model TEXT,
    outcome TEXT,
    duration_ms DOUBLE PRECISION,
    tool_calls INTEGER,
    failed_tool_calls INTEGER,
    stage1_tokens INTEGER,
    payload_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_lib_skill_ts ON events(library, skill, timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events(agent, timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project_hash, timestamp);

  CREATE TABLE IF NOT EXISTS library_snapshots (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT UNIQUE NOT NULL,
    library TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    project_hash TEXT,
    git_sha TEXT,
    git_branch TEXT,
    skills_count INTEGER NOT NULL,
    always_loaded_tokens INTEGER NOT NULL,
    body_tokens INTEGER NOT NULL,
    resource_tokens INTEGER NOT NULL,
    validation_errors INTEGER NOT NULL,
    validation_warnings INTEGER NOT NULL,
    eval_total INTEGER NOT NULL,
    eval_passed INTEGER NOT NULL,
    eval_failed INTEGER NOT NULL,
    skills_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_lib_ts ON library_snapshots(library, timestamp DESC);

  CREATE TABLE IF NOT EXISTS project_sync_state (
    project_hash TEXT NOT NULL,
    target TEXT NOT NULL,
    library TEXT NOT NULL,
    scope TEXT NOT NULL,
    mode TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    always_loaded_tokens INTEGER NOT NULL,
    skills_json TEXT NOT NULL,
    PRIMARY KEY (project_hash, target, library)
  );

  CREATE TABLE IF NOT EXISTS feedback_triage (
    group_key TEXT PRIMARY KEY,
    library TEXT NOT NULL,
    skill TEXT NOT NULL,
    step TEXT NOT NULL,
    symptom TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    updated_at TEXT NOT NULL
  );
`;

export class PostgresTelemetryStore implements TelemetryStore {
  private readonly connectionString?: string;
  private client: PgQueryClient | null;
  private ownsClient: boolean;

  constructor(connectionOrClient: string | PgQueryClient) {
    if (typeof connectionOrClient === "string") {
      this.connectionString = connectionOrClient;
      this.client = null;
      this.ownsClient = true;
    } else {
      this.client = connectionOrClient;
      this.ownsClient = false;
    }
  }

  private getClient(): PgQueryClient {
    if (!this.client) {
      throw new Error("PostgreSQL telemetry store is not initialized. Call init() first.");
    }
    return this.client;
  }

  async init(): Promise<void> {
    if (!this.client && this.connectionString) {
      const { Pool } = pg;
      this.client = new Pool({ connectionString: this.connectionString }) as unknown as PgQueryClient;
      this.ownsClient = true;
    }
    await this.getClient().query(PG_DDL);
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.client?.end) {
      await this.client.end();
    }
    if (this.ownsClient) this.client = null;
  }

  async ingestEvents(events: readonly TelemetryEvent[]): Promise<IngestResult> {
    if (events.length === 0) return { accepted: 0, duplicates: 0 };
    const client = this.getClient();
    const receivedAt = new Date().toISOString();
    let accepted = 0;
    let duplicates = 0;

    await client.query("BEGIN");
    try {
      for (const event of events) {
        const ts = normalizeIso(event.timestamp);
        const payloadJson = JSON.stringify(event);

        const projectHash = "projectHash" in event ? (event.projectHash ?? null) : null;
        const sessionHash = event.type === "skill.invoked" ? (event.sessionHash ?? null) : null;
        const skill = event.type === "skill.invoked" || event.type === "skill.feedback" ? event.skill : null;
        const agent =
          event.type === "skill.invoked"
            ? event.agent
            : event.type === "sync.applied"
              ? event.target
              : event.type === "skill.feedback"
                ? (event.agent ?? null)
                : null;
        const model = event.type === "skill.invoked" || event.type === "skill.feedback" ? (event.model ?? null) : null;
        const outcome = event.type === "skill.invoked" ? event.outcome : null;
        const durationMs = event.type === "skill.invoked" ? (event.durationMs ?? null) : null;
        const toolCalls = event.type === "skill.invoked" ? (event.toolCalls ?? null) : null;
        const failedToolCalls = event.type === "skill.invoked" ? (event.failedToolCalls ?? null) : null;
        const stage1Tokens =
          event.type === "skill.invoked"
            ? (event.stage1Tokens ?? null)
            : event.type === "sync.applied"
              ? event.alwaysLoadedTokens
              : null;

        const inserted = await client.query(
          `
            INSERT INTO events (
              event_id, type, timestamp, received_at, library, skanvil_version,
              project_hash, session_hash, skill, agent, model, outcome,
              duration_ms, tool_calls, failed_tool_calls, stage1_tokens, payload_json
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (event_id) DO NOTHING
          `,
          [
            event.eventId,
            event.type,
            ts,
            receivedAt,
            event.library,
            event.skanvilVersion,
            projectHash,
            sessionHash,
            skill,
            agent,
            model,
            outcome,
            durationMs,
            toolCalls,
            failedToolCalls,
            stage1Tokens,
            payloadJson
          ]
        );

        if ((inserted.rowCount ?? 0) === 0) {
          duplicates += 1;
          continue;
        }
        accepted += 1;

        if (event.type === "library.snapshot") {
          await client.query(
            `
              INSERT INTO library_snapshots (
                event_id, library, timestamp, project_hash, git_sha, git_branch,
                skills_count, always_loaded_tokens, body_tokens, resource_tokens,
                validation_errors, validation_warnings, eval_total, eval_passed, eval_failed,
                skills_json
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
              ON CONFLICT (event_id) DO NOTHING
            `,
            [
              event.eventId,
              event.library,
              ts,
              event.projectHash ?? null,
              event.gitSha ?? null,
              event.gitBranch ?? null,
              event.totals.skills,
              event.totals.alwaysLoadedTokens,
              event.totals.bodyTokens,
              event.totals.resourceTokens,
              event.validation.errors,
              event.validation.warnings,
              event.evals.totalTriggers,
              event.evals.passedTriggers,
              event.evals.failedTriggers,
              JSON.stringify(event.skills)
            ]
          );
        } else if (event.type === "sync.applied") {
          await client.query(
            `
              INSERT INTO project_sync_state (
                project_hash, target, library, scope, mode, synced_at, always_loaded_tokens, skills_json
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (project_hash, target, library) DO UPDATE SET
                scope = EXCLUDED.scope,
                mode = EXCLUDED.mode,
                synced_at = EXCLUDED.synced_at,
                always_loaded_tokens = EXCLUDED.always_loaded_tokens,
                skills_json = EXCLUDED.skills_json
              WHERE EXCLUDED.synced_at >= project_sync_state.synced_at
            `,
            [
              event.projectHash,
              event.target,
              event.library,
              event.scope,
              event.mode,
              ts,
              event.alwaysLoadedTokens,
              JSON.stringify(event.installedSkills)
            ]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    return { accepted, duplicates };
  }

  private async getLatestSnapshots(library?: string): Promise<SnapshotRowData[]> {
    const sql = `
      SELECT s.*
      FROM library_snapshots s
      INNER JOIN (
        SELECT library, MAX(timestamp) AS max_ts
        FROM library_snapshots
        ${library ? "WHERE library = $1" : ""}
        GROUP BY library
      ) latest ON s.library = latest.library AND s.timestamp = latest.max_ts
      WHERE s.id = (
        SELECT MAX(s2.id)
        FROM library_snapshots s2
        WHERE s2.library = s.library AND s2.timestamp = s.timestamp
      )
      ORDER BY s.library ASC
    `;
    const res = await this.getClient().query<SnapshotRowData>(sql, library ? [library] : []);
    return res.rows;
  }

  private async getSyncStates(library?: string): Promise<SyncStateRowData[]> {
    const sql = library
      ? "SELECT * FROM project_sync_state WHERE library = $1 ORDER BY synced_at DESC"
      : "SELECT * FROM project_sync_state ORDER BY synced_at DESC";
    const res = await this.getClient().query<SyncStateRowData>(sql, library ? [library] : []);
    return res.rows;
  }

  private async getInvokedRows(sinceIso: string, library?: string, skill?: string): Promise<InvokedRowData[]> {
    const clauses = ["type = 'skill.invoked'", "timestamp >= $1"];
    const params: unknown[] = [sinceIso];
    if (library) {
      params.push(library);
      clauses.push(`library = $${params.length}`);
    }
    if (skill) {
      params.push(skill);
      clauses.push(`skill = $${params.length}`);
    }
    const sql = `
      SELECT library, skill, timestamp, agent, model, project_hash, outcome, duration_ms, tool_calls, stage1_tokens, payload_json
      FROM events WHERE ${clauses.join(" AND ")}
    `;
    const res = await this.getClient().query<InvokedRowData>(sql, params);
    return res.rows;
  }

  private async getFeedbackRows(sinceIso: string, library?: string, skill?: string): Promise<FeedbackRowData[]> {
    const clauses = ["type = 'skill.feedback'", "timestamp >= $1"];
    const params: unknown[] = [sinceIso];
    if (library) {
      params.push(library);
      clauses.push(`library = $${params.length}`);
    }
    if (skill) {
      params.push(skill);
      clauses.push(`skill = $${params.length}`);
    }
    const sql = `
      SELECT event_id, library, skill, timestamp, project_hash, agent, model, payload_json
      FROM events WHERE ${clauses.join(" AND ")} ORDER BY timestamp DESC
    `;
    const res = await this.getClient().query<FeedbackRowData>(sql, params);
    return res.rows;
  }

  private async getTriageRows(library?: string, skill?: string): Promise<TriageRowData[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (library) {
      params.push(library);
      clauses.push(`library = $${params.length}`);
    }
    if (skill) {
      params.push(skill);
      clauses.push(`skill = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.getClient().query<TriageRowData>(
      `SELECT group_key, status, note, updated_at FROM feedback_triage ${where}`,
      params
    );
    return res.rows;
  }

  async listLibraries(): Promise<LibrariesResponse> {
    const client = this.getClient();
    const libRes = await client.query<{ library: string }>(`
      SELECT DISTINCT library FROM (
        SELECT library FROM library_snapshots
        UNION SELECT library FROM project_sync_state
        UNION SELECT library FROM events
      ) libs ORDER BY library ASC
    `);
    const latestSnapshots = await this.getLatestSnapshots();
    const latestByLib = new Map(latestSnapshots.map((snap) => [snap.library, snap]));

    const invRes = await client.query<{ library: string; cnt: number | string }>(
      "SELECT library, COUNT(*) AS cnt FROM events WHERE type = 'skill.invoked' GROUP BY library"
    );
    const invMap = new Map(invRes.rows.map((r) => [r.library, Number(r.cnt)]));

    const syncRes = await client.query<{ library: string; cnt: number | string }>(
      "SELECT library, COUNT(DISTINCT project_hash) AS cnt FROM project_sync_state GROUP BY library"
    );
    const syncMap = new Map(syncRes.rows.map((r) => [r.library, Number(r.cnt)]));

    const skillCntRes = await client.query<{ library: string; cnt: number | string }>(
      "SELECT library, COUNT(DISTINCT skill) AS cnt FROM events WHERE skill IS NOT NULL GROUP BY library"
    );
    const skillCntMap = new Map(skillCntRes.rows.map((r) => [r.library, Number(r.cnt)]));

    const libraries: LibrarySummary[] = libRes.rows.map(({ library }) => {
      const snap = latestByLib.get(library);
      return {
        library,
        latestSnapshotAt: snap ? snap.timestamp : null,
        skillsCount: snap ? Number(snap.skills_count) : (skillCntMap.get(library) ?? 0),
        alwaysLoadedTokens: snap ? Number(snap.always_loaded_tokens) : 0,
        evalPassRate: snap && Number(snap.eval_total) > 0 ? Number(snap.eval_passed) / Number(snap.eval_total) : null,
        validationErrors: snap ? Number(snap.validation_errors) : 0,
        validationWarnings: snap ? Number(snap.validation_warnings) : 0,
        totalInvocations: invMap.get(library) ?? 0,
        syncedProjects: syncMap.get(library) ?? 0
      };
    });

    return { libraries };
  }

  async getOverview(query: AnalyticsQuery): Promise<OverviewResponse> {
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;
    const [snaps, syncs, invs, fbs] = await Promise.all([
      this.getLatestSnapshots(lib),
      this.getSyncStates(lib),
      this.getInvokedRows(sinceIso, lib),
      this.getFeedbackRows(sinceIso, lib)
    ]);
    return aggregateOverview(query, snaps, syncs, invs, fbs);
  }

  async getSkillsAnalytics(query: AnalyticsQuery): Promise<SkillsAnalyticsResponse> {
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;
    const [snaps, syncs, invs, fbs] = await Promise.all([
      this.getLatestSnapshots(lib),
      this.getSyncStates(lib),
      this.getInvokedRows(sinceIso, lib),
      this.getFeedbackRows(sinceIso, lib)
    ]);
    return aggregateSkillsAnalytics(
      query,
      snaps,
      syncs,
      invs,
      fbs.map((row) => ({ library: row.library, skill: row.skill }))
    );
  }

  async getSkillDetail(library: string, skill: string, days: number): Promise<SkillDetailResponse> {
    const sinceIso = sinceTimestamp(days);
    const [snaps, syncs, invs, fbs, triageRows] = await Promise.all([
      this.getLatestSnapshots(library),
      this.getSyncStates(library),
      this.getInvokedRows(sinceIso, library, skill),
      this.getFeedbackRows(sinceIso, library, skill),
      this.getTriageRows(library, skill)
    ]);
    const summaryList = aggregateSkillsAnalytics(
      { library, days },
      snaps,
      syncs,
      invs,
      fbs.map((row) => ({ library: row.library, skill: row.skill }))
    ).skills;
    const summary = summaryList.find((item) => item.skill === skill) ?? null;
    return aggregateSkillDetail(library, skill, days, summary, invs, fbs, triageRows, syncs);
  }

  async getBudgetsHistory(query: AnalyticsQuery): Promise<BudgetsResponse> {
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;
    const sql = lib
      ? `SELECT event_id, library, timestamp, git_sha, git_branch, skills_count,
                always_loaded_tokens, body_tokens, resource_tokens,
                validation_errors, validation_warnings, eval_total, eval_passed, eval_failed
         FROM library_snapshots WHERE timestamp >= $1 AND library = $2 ORDER BY timestamp ASC, id ASC`
      : `SELECT event_id, library, timestamp, git_sha, git_branch, skills_count,
                always_loaded_tokens, body_tokens, resource_tokens,
                validation_errors, validation_warnings, eval_total, eval_passed, eval_failed
         FROM library_snapshots WHERE timestamp >= $1 ORDER BY timestamp ASC, id ASC`;
    const res = await this.getClient().query<SnapshotRowData>(sql, lib ? [sinceIso, lib] : [sinceIso]);
    const rows = res.rows.length > 0 ? res.rows : await this.getLatestSnapshots(lib);
    return aggregateBudgets(query, rows);
  }

  async getFeedbackSummary(query: AnalyticsQuery): Promise<FeedbackResponse> {
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;
    const [rows, triage] = await Promise.all([this.getFeedbackRows(sinceIso, lib), this.getTriageRows(lib)]);
    return aggregateFeedbackSummary(query, rows, triage);
  }

  async setFeedbackTriage(input: FeedbackTriageRequest): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.getClient().query(
      `
        INSERT INTO feedback_triage (group_key, library, skill, step, symptom, status, note, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (group_key) DO UPDATE SET
          status = EXCLUDED.status,
          note = EXCLUDED.note,
          updated_at = EXCLUDED.updated_at
      `,
      [
        input.groupKey,
        input.library,
        input.skill,
        input.step,
        input.symptom,
        input.status,
        input.note ?? null,
        updatedAt
      ]
    );
  }

  async getSyncAdoption(query: AnalyticsQuery): Promise<AdoptionResponse> {
    const lib = query.library || undefined;
    const [syncs, snaps] = await Promise.all([this.getSyncStates(lib), this.getLatestSnapshots(lib)]);
    return aggregateAdoption(query, syncs, snaps);
  }

  async pruneOldData(retentionDays: number): Promise<RetentionResult> {
    const client = this.getClient();
    const cutoffIso = sinceTimestamp(retentionDays);
    await client.query("BEGIN");
    try {
      const snapRes = await client.query(
        `
          DELETE FROM library_snapshots s
          WHERE s.timestamp < $1
            AND EXISTS (
              SELECT 1 FROM library_snapshots s2
              WHERE s2.library = s.library
                AND (s2.timestamp > s.timestamp OR (s2.timestamp = s.timestamp AND s2.id > s.id))
            )
        `,
        [cutoffIso]
      );
      const evtRes = await client.query(
        `
          DELETE FROM events
          WHERE timestamp < $1
            AND event_id NOT IN (SELECT event_id FROM library_snapshots)
        `,
        [cutoffIso]
      );
      await client.query("COMMIT");
      return {
        deletedEvents: evtRes.rowCount ?? 0,
        deletedSnapshots: snapRes.rowCount ?? 0,
        cutoffIso
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  async exportEvents(query: AnalyticsQuery): Promise<ExportEventRow[]> {
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;
    const sql = lib
      ? `SELECT event_id, type, timestamp, library, skill, agent, model, outcome, duration_ms, tool_calls, failed_tool_calls, project_hash, payload_json
         FROM events WHERE timestamp >= $1 AND library = $2 ORDER BY timestamp DESC`
      : `SELECT event_id, type, timestamp, library, skill, agent, model, outcome, duration_ms, tool_calls, failed_tool_calls, project_hash, payload_json
         FROM events WHERE timestamp >= $1 ORDER BY timestamp DESC`;
    const res = await this.getClient().query<{
      event_id: string;
      type: string;
      timestamp: string;
      library: string;
      skill: string | null;
      agent: string | null;
      model: string | null;
      outcome: string | null;
      duration_ms: number | null;
      tool_calls: number | null;
      failed_tool_calls: number | null;
      project_hash: string | null;
      payload_json: string;
    }>(sql, lib ? [sinceIso, lib] : [sinceIso]);

    return res.rows.map((row) => ({
      eventId: row.event_id,
      type: row.type,
      timestamp: row.timestamp,
      library: row.library,
      skill: row.skill,
      agent: row.agent,
      model: row.model,
      outcome: row.outcome,
      durationMs: row.duration_ms !== null ? Number(row.duration_ms) : null,
      toolCalls: row.tool_calls !== null ? Number(row.tool_calls) : null,
      failedToolCalls: row.failed_tool_calls !== null ? Number(row.failed_tool_calls) : null,
      projectHash: row.project_hash,
      payload: JSON.parse(row.payload_json) as TelemetryEvent
    }));
  }
}
