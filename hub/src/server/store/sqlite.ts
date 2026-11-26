import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

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

export class SqliteTelemetryStore implements TelemetryStore {
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("Telemetry store is not initialized. Call init() first.");
    }
    return this.db;
  }

  async init(): Promise<void> {
    if (this.db) return;
    if (this.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }
    const db = new DatabaseSync(this.dbPath);
    if (this.dbPath !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL;");
    }
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
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
        duration_ms REAL,
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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    `);
    this.db = db;
  }

  async close(): Promise<void> {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  async ingestEvents(events: readonly TelemetryEvent[]): Promise<IngestResult> {
    if (events.length === 0) return { accepted: 0, duplicates: 0 };
    const db = this.getDb();
    const receivedAt = new Date().toISOString();

    const insertEvent = db.prepare(`
      INSERT OR IGNORE INTO events (
        event_id, type, timestamp, received_at, library, skanvil_version,
        project_hash, session_hash, skill, agent, model, outcome,
        duration_ms, tool_calls, failed_tool_calls, stage1_tokens, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertSnapshot = db.prepare(`
      INSERT OR IGNORE INTO library_snapshots (
        event_id, library, timestamp, project_hash, git_sha, git_branch,
        skills_count, always_loaded_tokens, body_tokens, resource_tokens,
        validation_errors, validation_warnings, eval_total, eval_passed, eval_failed,
        skills_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const upsertSyncState = db.prepare(`
      INSERT INTO project_sync_state (
        project_hash, target, library, scope, mode, synced_at, always_loaded_tokens, skills_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_hash, target, library) DO UPDATE SET
        scope = excluded.scope,
        mode = excluded.mode,
        synced_at = excluded.synced_at,
        always_loaded_tokens = excluded.always_loaded_tokens,
        skills_json = excluded.skills_json
      WHERE excluded.synced_at >= project_sync_state.synced_at
    `);

    let accepted = 0;
    let duplicates = 0;

    db.exec("BEGIN IMMEDIATE;");
    try {
      for (const event of events) {
        const ts = normalizeIso(event.timestamp);
        const payloadJson = JSON.stringify(event);

        let projectHash: SQLInputValue = null;
        let sessionHash: SQLInputValue = null;
        let skill: SQLInputValue = null;
        let agent: SQLInputValue = null;
        let model: SQLInputValue = null;
        let outcome: SQLInputValue = null;
        let durationMs: SQLInputValue = null;
        let toolCalls: SQLInputValue = null;
        let failedToolCalls: SQLInputValue = null;
        let stage1Tokens: SQLInputValue = null;

        if (event.type === "library.snapshot") {
          projectHash = event.projectHash ?? null;
        } else if (event.type === "sync.applied") {
          projectHash = event.projectHash;
          agent = event.target;
          stage1Tokens = event.alwaysLoadedTokens;
        } else if (event.type === "skill.invoked") {
          projectHash = event.projectHash ?? null;
          sessionHash = event.sessionHash ?? null;
          skill = event.skill;
          agent = event.agent;
          model = event.model ?? null;
          outcome = event.outcome;
          durationMs = event.durationMs ?? null;
          toolCalls = event.toolCalls ?? null;
          failedToolCalls = event.failedToolCalls ?? null;
          stage1Tokens = event.stage1Tokens ?? null;
        } else if (event.type === "skill.feedback") {
          projectHash = event.projectHash ?? null;
          skill = event.skill;
          agent = event.agent ?? null;
          model = event.model ?? null;
        }

        const res = insertEvent.run(
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
        );

        if (Number(res.changes) === 0) {
          duplicates += 1;
          continue;
        }
        accepted += 1;

        if (event.type === "library.snapshot") {
          insertSnapshot.run(
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
          );
        } else if (event.type === "sync.applied") {
          upsertSyncState.run(
            event.projectHash,
            event.target,
            event.library,
            event.scope,
            event.mode,
            ts,
            event.alwaysLoadedTokens,
            JSON.stringify(event.installedSkills)
          );
        }
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }

    return { accepted, duplicates };
  }

  private getLatestSnapshots(library?: string): SnapshotRowData[] {
    const db = this.getDb();
    const sql = `
      SELECT s.*
      FROM library_snapshots s
      INNER JOIN (
        SELECT library, MAX(timestamp) AS max_ts
        FROM library_snapshots
        ${library ? "WHERE library = ?" : ""}
        GROUP BY library
      ) latest ON s.library = latest.library AND s.timestamp = latest.max_ts
      WHERE s.id = (
        SELECT MAX(s2.id)
        FROM library_snapshots s2
        WHERE s2.library = s.library AND s2.timestamp = s.timestamp
      )
      ORDER BY s.library ASC
    `;
    return (library ? db.prepare(sql).all(library) : db.prepare(sql).all()) as unknown as SnapshotRowData[];
  }

  private getSyncStates(library?: string): SyncStateRowData[] {
    const db = this.getDb();
    const sql = library
      ? "SELECT * FROM project_sync_state WHERE library = ? ORDER BY synced_at DESC"
      : "SELECT * FROM project_sync_state ORDER BY synced_at DESC";
    return (library ? db.prepare(sql).all(library) : db.prepare(sql).all()) as unknown as SyncStateRowData[];
  }

  private getInvokedRows(sinceIso: string, library?: string, skill?: string): InvokedRowData[] {
    const db = this.getDb();
    const clauses = ["type = 'skill.invoked'", "timestamp >= ?"];
    const params: SQLInputValue[] = [sinceIso];
    if (library) {
      clauses.push("library = ?");
      params.push(library);
    }
    if (skill) {
      clauses.push("skill = ?");
      params.push(skill);
    }
    const sql = `
      SELECT library, skill, timestamp, agent, model, project_hash, outcome, duration_ms, tool_calls, stage1_tokens, payload_json
      FROM events
      WHERE ${clauses.join(" AND ")}
    `;
    return db.prepare(sql).all(...params) as unknown as InvokedRowData[];
  }

  private getFeedbackRows(sinceIso: string, library?: string, skill?: string): FeedbackRowData[] {
    const db = this.getDb();
    const clauses = ["type = 'skill.feedback'", "timestamp >= ?"];
    const params: SQLInputValue[] = [sinceIso];
    if (library) {
      clauses.push("library = ?");
      params.push(library);
    }
    if (skill) {
      clauses.push("skill = ?");
      params.push(skill);
    }
    const sql = `
      SELECT event_id, library, skill, timestamp, project_hash, agent, model, payload_json
      FROM events
      WHERE ${clauses.join(" AND ")}
      ORDER BY timestamp DESC
    `;
    return db.prepare(sql).all(...params) as unknown as FeedbackRowData[];
  }

  private getTriageRows(library?: string, skill?: string): TriageRowData[] {
    const db = this.getDb();
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (library) {
      clauses.push("library = ?");
      params.push(library);
    }
    if (skill) {
      clauses.push("skill = ?");
      params.push(skill);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return db
      .prepare(`SELECT group_key, status, note, updated_at FROM feedback_triage ${where}`)
      .all(...params) as unknown as TriageRowData[];
  }

  async listLibraries(): Promise<LibrariesResponse> {
    const db = this.getDb();
    const libraryRows = db
      .prepare(
        `
        SELECT DISTINCT library FROM (
          SELECT library FROM library_snapshots
          UNION
          SELECT library FROM project_sync_state
          UNION
          SELECT library FROM events
        )
        ORDER BY library ASC
      `
      )
      .all() as unknown as Array<{ library: string }>;

    const latestByLib = new Map<string, SnapshotRowData>();
    for (const snap of this.getLatestSnapshots()) {
      latestByLib.set(snap.library, snap);
    }

    const invocationsByLib = new Map<string, number>();
    const invRows = db
      .prepare("SELECT library, COUNT(*) AS cnt FROM events WHERE type = 'skill.invoked' GROUP BY library")
      .all() as unknown as Array<{ library: string; cnt: number }>;
    for (const row of invRows) invocationsByLib.set(row.library, Number(row.cnt));

    const syncedProjectsByLib = new Map<string, number>();
    const syncCountRows = db
      .prepare("SELECT library, COUNT(DISTINCT project_hash) AS cnt FROM project_sync_state GROUP BY library")
      .all() as unknown as Array<{ library: string; cnt: number }>;
    for (const row of syncCountRows) syncedProjectsByLib.set(row.library, Number(row.cnt));

    const distinctSkillCountStmt = db.prepare(
      "SELECT COUNT(DISTINCT skill) AS cnt FROM events WHERE library = ? AND skill IS NOT NULL"
    );

    const libraries: LibrarySummary[] = libraryRows.map(({ library }) => {
      const snap = latestByLib.get(library);
      const fallbackSkills = Number((distinctSkillCountStmt.get(library) as { cnt: number } | undefined)?.cnt ?? 0);
      return {
        library,
        latestSnapshotAt: snap ? snap.timestamp : null,
        skillsCount: snap ? snap.skills_count : fallbackSkills,
        alwaysLoadedTokens: snap ? snap.always_loaded_tokens : 0,
        evalPassRate: snap && snap.eval_total > 0 ? snap.eval_passed / snap.eval_total : null,
        validationErrors: snap ? snap.validation_errors : 0,
        validationWarnings: snap ? snap.validation_warnings : 0,
        totalInvocations: invocationsByLib.get(library) ?? 0,
        syncedProjects: syncedProjectsByLib.get(library) ?? 0
      };
    });

    return { libraries };
  }

  async getOverview(query: AnalyticsQuery): Promise<OverviewResponse> {
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;
    return aggregateOverview(
      query,
      this.getLatestSnapshots(lib),
      this.getSyncStates(lib),
      this.getInvokedRows(sinceIso, lib),
      this.getFeedbackRows(sinceIso, lib)
    );
  }

  async getSkillsAnalytics(query: AnalyticsQuery): Promise<SkillsAnalyticsResponse> {
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;
    return aggregateSkillsAnalytics(
      query,
      this.getLatestSnapshots(lib),
      this.getSyncStates(lib),
      this.getInvokedRows(sinceIso, lib),
      this.getFeedbackRows(sinceIso, lib).map((row) => ({ library: row.library, skill: row.skill }))
    );
  }

  async getSkillDetail(library: string, skill: string, days: number): Promise<SkillDetailResponse> {
    const sinceIso = sinceTimestamp(days);
    const invRows = this.getInvokedRows(sinceIso, library, skill);
    const fbRows = this.getFeedbackRows(sinceIso, library, skill);
    const triageRows = this.getTriageRows(library, skill);
    const syncRows = this.getSyncStates(library);
    const summaryList = aggregateSkillsAnalytics(
      { library, days },
      this.getLatestSnapshots(library),
      syncRows,
      invRows,
      fbRows.map((row) => ({ library: row.library, skill: row.skill }))
    ).skills;
    const summary = summaryList.find((item) => item.skill === skill) ?? null;

    return aggregateSkillDetail(library, skill, days, summary, invRows, fbRows, triageRows, syncRows);
  }

  async getBudgetsHistory(query: AnalyticsQuery): Promise<BudgetsResponse> {
    const db = this.getDb();
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;

    const sql = lib
      ? `SELECT event_id, library, timestamp, git_sha, git_branch, skills_count,
                always_loaded_tokens, body_tokens, resource_tokens,
                validation_errors, validation_warnings, eval_total, eval_passed, eval_failed
         FROM library_snapshots
         WHERE timestamp >= ? AND library = ?
         ORDER BY timestamp ASC, id ASC`
      : `SELECT event_id, library, timestamp, git_sha, git_branch, skills_count,
                always_loaded_tokens, body_tokens, resource_tokens,
                validation_errors, validation_warnings, eval_total, eval_passed, eval_failed
         FROM library_snapshots
         WHERE timestamp >= ?
         ORDER BY timestamp ASC, id ASC`;

    let rows = (lib
      ? db.prepare(sql).all(sinceIso, lib)
      : db.prepare(sql).all(sinceIso)) as unknown as SnapshotRowData[];
    if (rows.length === 0) rows = this.getLatestSnapshots(lib);
    return aggregateBudgets(query, rows);
  }

  async getFeedbackSummary(query: AnalyticsQuery): Promise<FeedbackResponse> {
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;
    return aggregateFeedbackSummary(query, this.getFeedbackRows(sinceIso, lib), this.getTriageRows(lib));
  }

  async setFeedbackTriage(input: FeedbackTriageRequest): Promise<void> {
    const db = this.getDb();
    const updatedAt = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO feedback_triage (group_key, library, skill, step, symptom, status, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_key) DO UPDATE SET
        status = excluded.status,
        note = excluded.note,
        updated_at = excluded.updated_at
    `
    ).run(
      input.groupKey,
      input.library,
      input.skill,
      input.step,
      input.symptom,
      input.status,
      input.note ?? null,
      updatedAt
    );
  }

  async getSyncAdoption(query: AnalyticsQuery): Promise<AdoptionResponse> {
    const lib = query.library || undefined;
    return aggregateAdoption(query, this.getSyncStates(lib), this.getLatestSnapshots(lib));
  }

  async pruneOldData(retentionDays: number): Promise<RetentionResult> {
    const db = this.getDb();
    const cutoffIso = sinceTimestamp(retentionDays);
    const delSnapshots = db.prepare(`
      DELETE FROM library_snapshots
      WHERE timestamp < ?
        AND EXISTS (
          SELECT 1 FROM library_snapshots s2
          WHERE s2.library = library_snapshots.library
            AND (s2.timestamp > library_snapshots.timestamp OR (s2.timestamp = library_snapshots.timestamp AND s2.id > library_snapshots.id))
        )
    `);
    const delEvents = db.prepare(`
      DELETE FROM events
      WHERE timestamp < ?
        AND event_id NOT IN (SELECT event_id FROM library_snapshots)
    `);

    db.exec("BEGIN IMMEDIATE;");
    try {
      const snapRes = delSnapshots.run(cutoffIso);
      const evtRes = delEvents.run(cutoffIso);
      db.exec("COMMIT;");
      return {
        deletedEvents: Number(evtRes.changes),
        deletedSnapshots: Number(snapRes.changes),
        cutoffIso
      };
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  async exportEvents(query: AnalyticsQuery): Promise<ExportEventRow[]> {
    const db = this.getDb();
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;
    const sql = lib
      ? `SELECT event_id, type, timestamp, library, skill, agent, model, outcome, duration_ms, tool_calls, failed_tool_calls, project_hash, payload_json
         FROM events WHERE timestamp >= ? AND library = ? ORDER BY timestamp DESC`
      : `SELECT event_id, type, timestamp, library, skill, agent, model, outcome, duration_ms, tool_calls, failed_tool_calls, project_hash, payload_json
         FROM events WHERE timestamp >= ? ORDER BY timestamp DESC`;
    const rows = (lib ? db.prepare(sql).all(sinceIso, lib) : db.prepare(sql).all(sinceIso)) as unknown as Array<{
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
    }>;

    return rows.map((row) => ({
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
