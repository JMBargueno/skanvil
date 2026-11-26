import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
  AdoptionResponse,
  BreakdownItem,
  BudgetHistoryPoint,
  BudgetsResponse,
  DeprecatedInstalledAlert,
  FeedbackEventRow,
  FeedbackGroupRow,
  FeedbackResponse,
  LibrariesResponse,
  LibrarySummary,
  OverviewDailyPoint,
  OverviewResponse,
  ProjectSyncRow,
  SkillAnalyticsRow,
  SkillsAnalyticsResponse,
  SnapshotSkill,
  TelemetryEvent
} from "../../shared/schema.js";
import type { AnalyticsQuery, IngestResult, TelemetryStore } from "./types.js";

interface LatestSnapshotRow {
  event_id: string;
  library: string;
  timestamp: string;
  git_sha: string | null;
  git_branch: string | null;
  skills_count: number;
  always_loaded_tokens: number;
  body_tokens: number;
  resource_tokens: number;
  validation_errors: number;
  validation_warnings: number;
  eval_total: number;
  eval_passed: number;
  eval_failed: number;
  skills_json: string;
}

interface SyncStateDbRow {
  project_hash: string;
  target: string;
  library: string;
  scope: string;
  mode: string;
  synced_at: string;
  always_loaded_tokens: number;
  skills_json: string;
}

interface InvokedDbRow {
  library: string;
  skill: string;
  timestamp: string;
  agent: string;
  model: string | null;
  project_hash: string | null;
  outcome: string;
  duration_ms: number | null;
  tool_calls: number | null;
  stage1_tokens: number | null;
  payload_json: string;
}

interface FeedbackDbRow {
  event_id: string;
  library: string;
  skill: string;
  timestamp: string;
  project_hash: string | null;
  agent: string | null;
  model: string | null;
  payload_json: string;
}

function normalizeIso(value: string): string {
  return new Date(value).toISOString();
}

function sinceTimestamp(days: number): string {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
  return new Date(Date.now() - safeDays * 86_400_000).toISOString();
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toBreakdown(map: Map<string, number>): BreakdownItem[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildDailySeries(days: number): Map<string, OverviewDailyPoint> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
  const map = new Map<string, OverviewDailyPoint>();
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const dateStr = new Date(todayUtc - offset * 86_400_000).toISOString().slice(0, 10);
    map.set(dateStr, { date: dateStr, invocations: 0, errors: 0, feedback: 0 });
  }
  return map;
}

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

  private getLatestSnapshots(library?: string): LatestSnapshotRow[] {
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
    const rows = (library ? db.prepare(sql).all(library) : db.prepare(sql).all()) as unknown as LatestSnapshotRow[];
    return rows;
  }

  private getSyncStates(library?: string): SyncStateDbRow[] {
    const db = this.getDb();
    const sql = library
      ? "SELECT * FROM project_sync_state WHERE library = ? ORDER BY synced_at DESC"
      : "SELECT * FROM project_sync_state ORDER BY synced_at DESC";
    return (library ? db.prepare(sql).all(library) : db.prepare(sql).all()) as unknown as SyncStateDbRow[];
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

    const latestByLib = new Map<string, LatestSnapshotRow>();
    for (const snap of this.getLatestSnapshots()) {
      latestByLib.set(snap.library, snap);
    }

    const invocationsByLib = new Map<string, number>();
    const invRows = db
      .prepare("SELECT library, COUNT(*) AS cnt FROM events WHERE type = 'skill.invoked' GROUP BY library")
      .all() as unknown as Array<{ library: string; cnt: number }>;
    for (const row of invRows) {
      invocationsByLib.set(row.library, Number(row.cnt));
    }

    const syncedProjectsByLib = new Map<string, number>();
    const syncCountRows = db
      .prepare("SELECT library, COUNT(DISTINCT project_hash) AS cnt FROM project_sync_state GROUP BY library")
      .all() as unknown as Array<{ library: string; cnt: number }>;
    for (const row of syncCountRows) {
      syncedProjectsByLib.set(row.library, Number(row.cnt));
    }

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
    const db = this.getDb();
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;

    const latestSnapshots = this.getLatestSnapshots(lib);
    const syncStates = this.getSyncStates(lib);

    const invSql = lib
      ? `SELECT library, skill, timestamp, agent, model, project_hash, outcome
         FROM events WHERE type = 'skill.invoked' AND timestamp >= ? AND library = ?`
      : `SELECT library, skill, timestamp, agent, model, project_hash, outcome
         FROM events WHERE type = 'skill.invoked' AND timestamp >= ?`;
    const invokedRows = (lib
      ? db.prepare(invSql).all(sinceIso, lib)
      : db.prepare(invSql).all(sinceIso)) as unknown as Array<
      Pick<InvokedDbRow, "library" | "skill" | "timestamp" | "agent" | "model" | "project_hash" | "outcome">
    >;

    const fbSql = lib
      ? `SELECT library, skill, timestamp, project_hash
         FROM events WHERE type = 'skill.feedback' AND timestamp >= ? AND library = ?`
      : `SELECT library, skill, timestamp, project_hash
         FROM events WHERE type = 'skill.feedback' AND timestamp >= ?`;
    const feedbackRows = (lib
      ? db.prepare(fbSql).all(sinceIso, lib)
      : db.prepare(fbSql).all(sinceIso)) as unknown as Array<
      Pick<FeedbackDbRow, "library" | "skill" | "timestamp" | "project_hash">
    >;

    const catalogSkills = new Map<string, { status?: string; stage1Tokens: number }>();
    let alwaysLoadedTokens = 0;
    let evalTotal = 0;
    let evalPassed = 0;

    for (const snap of latestSnapshots) {
      alwaysLoadedTokens += snap.always_loaded_tokens;
      evalTotal += snap.eval_total;
      evalPassed += snap.eval_passed;
      for (const skill of parseJsonArray<SnapshotSkill>(snap.skills_json)) {
        catalogSkills.set(`${snap.library}\0${skill.name}`, {
          status: skill.status,
          stage1Tokens: skill.stage1Tokens
        });
      }
    }

    const projectSet = new Set<string>();
    for (const sync of syncStates) {
      projectSet.add(sync.project_hash);
      for (const installed of parseJsonArray<string>(sync.skills_json)) {
        const key = `${sync.library}\0${installed}`;
        if (!catalogSkills.has(key)) {
          catalogSkills.set(key, { status: undefined, stage1Tokens: 0 });
        }
      }
    }

    const dailyMap = buildDailySeries(query.days);
    const agentCounts = new Map<string, number>();
    const modelCounts = new Map<string, number>();
    const usedSkillKeys = new Set<string>();

    let successCount = 0;
    let errorCount = 0;
    let frictionCount = 0;

    for (const row of invokedRows) {
      usedSkillKeys.add(`${row.library}\0${row.skill}`);
      if (row.project_hash) projectSet.add(row.project_hash);

      if (row.outcome === "success") successCount += 1;
      else if (row.outcome === "error") errorCount += 1;
      else if (row.outcome === "friction") frictionCount += 1;

      const dayKey = row.timestamp.slice(0, 10);
      const dayPoint = dailyMap.get(dayKey);
      if (dayPoint) {
        dayPoint.invocations += 1;
        if (row.outcome === "error") dayPoint.errors += 1;
      }

      const agent = row.agent || "unknown";
      agentCounts.set(agent, (agentCounts.get(agent) ?? 0) + 1);
      const model = row.model || "unspecified";
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    }

    for (const row of feedbackRows) {
      if (row.project_hash) projectSet.add(row.project_hash);
      const dayPoint = dailyMap.get(row.timestamp.slice(0, 10));
      if (dayPoint) dayPoint.feedback += 1;
    }

    let zombieSkills = 0;
    let wastedStage1Tokens = 0;
    for (const [key, meta] of catalogSkills.entries()) {
      if (meta.status === "deprecated") continue;
      if (!usedSkillKeys.has(key)) {
        zombieSkills += 1;
        wastedStage1Tokens += meta.stage1Tokens;
      }
    }

    const totalInvocations = invokedRows.length;

    return {
      library: lib ?? null,
      days: query.days,
      totalInvocations,
      successCount,
      errorCount,
      frictionCount,
      successRate: totalInvocations > 0 ? successCount / totalInvocations : null,
      activeSkills: usedSkillKeys.size,
      catalogSkills: catalogSkills.size,
      zombieSkills,
      wastedStage1Tokens,
      alwaysLoadedTokens,
      evalPassRate: evalTotal > 0 ? evalPassed / evalTotal : null,
      activeProjects: projectSet.size,
      feedbackCount: feedbackRows.length,
      daily: [...dailyMap.values()],
      byAgent: toBreakdown(agentCounts),
      byModel: toBreakdown(modelCounts)
    };
  }

  async getSkillsAnalytics(query: AnalyticsQuery): Promise<SkillsAnalyticsResponse> {
    const db = this.getDb();
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;

    interface MutableSkill {
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
      inCatalogOrSynced: boolean;
      invocations: number;
      successCount: number;
      errorCount: number;
      frictionOutcomeCount: number;
      feedbackCount: number;
      durationSum: number;
      durationCount: number;
      toolCallsSum: number;
      toolCallsCount: number;
      syncedProjects: Set<string>;
      lastUsedAt: string | null;
      agents: Record<string, number>;
    }

    const map = new Map<string, MutableSkill>();
    const ensure = (libraryName: string, skillName: string): MutableSkill => {
      const key = `${libraryName}\0${skillName}`;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          library: libraryName,
          skill: skillName,
          category: null,
          owner: null,
          status: null,
          replacedBy: null,
          stage1Tokens: null,
          bodyLines: null,
          evalCases: 0,
          evalTriggers: 0,
          valid: null,
          inCatalogOrSynced: false,
          invocations: 0,
          successCount: 0,
          errorCount: 0,
          frictionOutcomeCount: 0,
          feedbackCount: 0,
          durationSum: 0,
          durationCount: 0,
          toolCallsSum: 0,
          toolCallsCount: 0,
          syncedProjects: new Set<string>(),
          lastUsedAt: null,
          agents: {}
        };
        map.set(key, entry);
      }
      return entry;
    };

    for (const snap of this.getLatestSnapshots(lib)) {
      for (const item of parseJsonArray<SnapshotSkill>(snap.skills_json)) {
        const entry = ensure(snap.library, item.name);
        entry.category = item.category;
        entry.owner = item.owner ?? null;
        entry.status = item.status ?? null;
        entry.replacedBy = item.replacedBy ?? null;
        entry.stage1Tokens = item.stage1Tokens;
        entry.bodyLines = item.bodyLines;
        entry.evalCases = item.evalCases;
        entry.evalTriggers = item.evalTriggers;
        entry.valid = item.valid;
        entry.inCatalogOrSynced = true;
      }
    }

    for (const sync of this.getSyncStates(lib)) {
      for (const installed of parseJsonArray<string>(sync.skills_json)) {
        const entry = ensure(sync.library, installed);
        entry.inCatalogOrSynced = true;
        entry.syncedProjects.add(sync.project_hash);
      }
    }

    const invSql = lib
      ? `SELECT library, skill, timestamp, agent, outcome, duration_ms, tool_calls, stage1_tokens, payload_json
         FROM events WHERE type = 'skill.invoked' AND timestamp >= ? AND library = ?`
      : `SELECT library, skill, timestamp, agent, outcome, duration_ms, tool_calls, stage1_tokens, payload_json
         FROM events WHERE type = 'skill.invoked' AND timestamp >= ?`;
    const invRows = (lib
      ? db.prepare(invSql).all(sinceIso, lib)
      : db.prepare(invSql).all(sinceIso)) as unknown as InvokedDbRow[];

    for (const row of invRows) {
      const entry = ensure(row.library, row.skill);
      entry.invocations += 1;
      if (row.outcome === "success") entry.successCount += 1;
      else if (row.outcome === "error") entry.errorCount += 1;
      else if (row.outcome === "friction") entry.frictionOutcomeCount += 1;

      if (row.duration_ms !== null) {
        entry.durationSum += Number(row.duration_ms);
        entry.durationCount += 1;
      }
      if (row.tool_calls !== null) {
        entry.toolCallsSum += Number(row.tool_calls);
        entry.toolCallsCount += 1;
      }
      if (entry.stage1Tokens === null && row.stage1_tokens !== null) {
        entry.stage1Tokens = Number(row.stage1_tokens);
      }
      if (!entry.owner) {
        try {
          const parsed = JSON.parse(row.payload_json) as { owner?: string };
          if (parsed.owner) entry.owner = parsed.owner;
        } catch {
          // ignore
        }
      }
      if (!entry.lastUsedAt || row.timestamp > entry.lastUsedAt) {
        entry.lastUsedAt = row.timestamp;
      }
      const agent = row.agent || "unknown";
      entry.agents[agent] = (entry.agents[agent] ?? 0) + 1;
    }

    const fbSql = lib
      ? `SELECT library, skill FROM events WHERE type = 'skill.feedback' AND timestamp >= ? AND library = ?`
      : `SELECT library, skill FROM events WHERE type = 'skill.feedback' AND timestamp >= ?`;
    const fbRows = (lib ? db.prepare(fbSql).all(sinceIso, lib) : db.prepare(fbSql).all(sinceIso)) as unknown as Array<{
      library: string;
      skill: string;
    }>;

    for (const row of fbRows) {
      const entry = ensure(row.library, row.skill);
      entry.feedbackCount += 1;
    }

    const skills: SkillAnalyticsRow[] = [...map.values()]
      .map((entry) => {
        const frictionEvents = entry.frictionOutcomeCount + entry.feedbackCount;
        const isZombie = entry.inCatalogOrSynced && entry.status !== "deprecated" && entry.invocations === 0;
        return {
          library: entry.library,
          skill: entry.skill,
          category: entry.category,
          owner: entry.owner,
          status: entry.status,
          replacedBy: entry.replacedBy,
          stage1Tokens: entry.stage1Tokens,
          bodyLines: entry.bodyLines,
          evalCases: entry.evalCases,
          evalTriggers: entry.evalTriggers,
          valid: entry.valid,
          invocations: entry.invocations,
          successCount: entry.successCount,
          errorCount: entry.errorCount,
          frictionEvents,
          frictionRate: entry.invocations > 0 ? frictionEvents / entry.invocations : null,
          avgDurationMs: entry.durationCount > 0 ? entry.durationSum / entry.durationCount : null,
          avgToolCalls: entry.toolCallsCount > 0 ? entry.toolCallsSum / entry.toolCallsCount : null,
          syncedProjects: entry.syncedProjects.size,
          lastUsedAt: entry.lastUsedAt,
          isZombie,
          agents: entry.agents
        };
      })
      .sort(
        (a, b) =>
          b.invocations - a.invocations || Number(b.isZombie) - Number(a.isZombie) || a.skill.localeCompare(b.skill)
      );

    return {
      library: lib ?? null,
      days: query.days,
      skills
    };
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

    let rows = (lib ? db.prepare(sql).all(sinceIso, lib) : db.prepare(sql).all(sinceIso)) as unknown as Array<
      Omit<LatestSnapshotRow, "skills_json">
    >;

    if (rows.length === 0) {
      rows = this.getLatestSnapshots(lib);
    }

    const snapshots: BudgetHistoryPoint[] = rows.map((row) => ({
      eventId: row.event_id,
      library: row.library,
      timestamp: row.timestamp,
      gitSha: row.git_sha,
      gitBranch: row.git_branch,
      skillsCount: row.skills_count,
      alwaysLoadedTokens: row.always_loaded_tokens,
      bodyTokens: row.body_tokens,
      resourceTokens: row.resource_tokens,
      validationErrors: row.validation_errors,
      validationWarnings: row.validation_warnings,
      evalTotal: row.eval_total,
      evalPassed: row.eval_passed,
      evalFailed: row.eval_failed,
      evalPassRate: row.eval_total > 0 ? row.eval_passed / row.eval_total : null
    }));

    return {
      library: lib ?? null,
      days: query.days,
      snapshots
    };
  }

  async getFeedbackSummary(query: AnalyticsQuery): Promise<FeedbackResponse> {
    const db = this.getDb();
    const sinceIso = sinceTimestamp(query.days);
    const lib = query.library || undefined;

    const sql = lib
      ? `SELECT event_id, library, skill, timestamp, agent, model, payload_json
         FROM events
         WHERE type = 'skill.feedback' AND timestamp >= ? AND library = ?
         ORDER BY timestamp DESC`
      : `SELECT event_id, library, skill, timestamp, agent, model, payload_json
         FROM events
         WHERE type = 'skill.feedback' AND timestamp >= ?
         ORDER BY timestamp DESC`;

    const rows = (lib
      ? db.prepare(sql).all(sinceIso, lib)
      : db.prepare(sql).all(sinceIso)) as unknown as FeedbackDbRow[];

    const groupsMap = new Map<
      string,
      {
        library: string;
        skill: string;
        step: string;
        symptom: string;
        count: number;
        suggestedEvalCaseCount: number;
        fixes: Set<string>;
        latestTimestamp: string;
      }
    >();

    const recent: FeedbackEventRow[] = [];

    for (const row of rows) {
      let step = "unknown";
      let symptom = "Unparsed feedback payload";
      let proposedFix: string | null = null;
      let hasSuggestedEvalCase = false;

      try {
        const parsed = JSON.parse(row.payload_json) as {
          step?: string;
          symptom?: string;
          proposedFix?: string;
          hasSuggestedEvalCase?: boolean;
        };
        if (parsed.step) step = parsed.step;
        if (parsed.symptom) symptom = parsed.symptom;
        if (parsed.proposedFix) proposedFix = parsed.proposedFix;
        hasSuggestedEvalCase = Boolean(parsed.hasSuggestedEvalCase);
      } catch {
        // leave fallbacks
      }

      if (recent.length < 50) {
        recent.push({
          eventId: row.event_id,
          library: row.library,
          skill: row.skill,
          step,
          symptom,
          proposedFix,
          hasSuggestedEvalCase,
          agent: row.agent,
          model: row.model,
          timestamp: row.timestamp
        });
      }

      const key = `${row.library}\0${row.skill}\0${step}\0${symptom}`;
      let group = groupsMap.get(key);
      if (!group) {
        group = {
          library: row.library,
          skill: row.skill,
          step,
          symptom,
          count: 0,
          suggestedEvalCaseCount: 0,
          fixes: new Set<string>(),
          latestTimestamp: row.timestamp
        };
        groupsMap.set(key, group);
      }
      group.count += 1;
      if (hasSuggestedEvalCase) group.suggestedEvalCaseCount += 1;
      if (proposedFix) group.fixes.add(proposedFix);
      if (row.timestamp > group.latestTimestamp) group.latestTimestamp = row.timestamp;
    }

    const groups: FeedbackGroupRow[] = [...groupsMap.values()]
      .map((item) => ({
        library: item.library,
        skill: item.skill,
        step: item.step,
        symptom: item.symptom,
        count: item.count,
        suggestedEvalCaseCount: item.suggestedEvalCaseCount,
        proposedFixes: [...item.fixes],
        latestTimestamp: item.latestTimestamp
      }))
      .sort((a, b) => b.count - a.count || b.latestTimestamp.localeCompare(a.latestTimestamp));

    return {
      library: lib ?? null,
      days: query.days,
      totalEvents: rows.length,
      groups,
      recent
    };
  }

  async getSyncAdoption(query: AnalyticsQuery): Promise<AdoptionResponse> {
    const lib = query.library || undefined;
    const syncRows = this.getSyncStates(lib);
    const latestSnapshots = this.getLatestSnapshots(lib);

    const deprecatedCatalog = new Map<string, { replacedBy: string | null }>();
    for (const snap of latestSnapshots) {
      for (const skill of parseJsonArray<SnapshotSkill>(snap.skills_json)) {
        if (skill.status === "deprecated") {
          deprecatedCatalog.set(`${snap.library}\0${skill.name}`, {
            replacedBy: skill.replacedBy ?? null
          });
        }
      }
    }

    const projectSet = new Set<string>();
    const targetCounts = new Map<string, number>();
    const deprecatedInstalled: DeprecatedInstalledAlert[] = [];

    const projects: ProjectSyncRow[] = syncRows.map((row) => {
      projectSet.add(row.project_hash);
      targetCounts.set(row.target, (targetCounts.get(row.target) ?? 0) + 1);
      const installedSkills = parseJsonArray<string>(row.skills_json);

      for (const skill of installedSkills) {
        const dep = deprecatedCatalog.get(`${row.library}\0${skill}`);
        if (dep) {
          deprecatedInstalled.push({
            projectHash: row.project_hash,
            target: row.target,
            library: row.library,
            skill,
            replacedBy: dep.replacedBy,
            syncedAt: row.synced_at
          });
        }
      }

      return {
        projectHash: row.project_hash,
        target: row.target,
        library: row.library,
        scope: row.scope,
        mode: row.mode,
        syncedAt: row.synced_at,
        alwaysLoadedTokens: row.always_loaded_tokens,
        installedSkills
      };
    });

    return {
      library: lib ?? null,
      totalSyncedProjects: projectSet.size,
      byTarget: toBreakdown(targetCounts),
      projects,
      deprecatedInstalled
    };
  }
}
