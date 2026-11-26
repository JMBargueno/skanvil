import type {
  AdoptionResponse,
  BreakdownItem,
  BudgetHistoryPoint,
  BudgetsResponse,
  DeprecatedInstalledAlert,
  FeedbackEventRow,
  FeedbackGroupRow,
  FeedbackResponse,
  FeedbackStatus,
  OverviewDailyPoint,
  OverviewResponse,
  ProjectSyncRow,
  SkillAnalyticsRow,
  SkillDetailResponse,
  SkillsAnalyticsResponse,
  SnapshotSkill
} from "../../shared/schema.js";
import { computeFeedbackGroupKey, type AnalyticsQuery } from "./types.js";

export interface SnapshotRowData {
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
  skills_json?: string;
}

export interface SyncStateRowData {
  project_hash: string;
  target: string;
  library: string;
  scope: string;
  mode: string;
  synced_at: string;
  always_loaded_tokens: number;
  skills_json: string;
}

export interface InvokedRowData {
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

export interface FeedbackRowData {
  event_id: string;
  library: string;
  skill: string;
  timestamp: string;
  project_hash: string | null;
  agent: string | null;
  model: string | null;
  payload_json: string;
}

export interface TriageRowData {
  group_key: string;
  status: FeedbackStatus;
  note: string | null;
  updated_at: string;
}

export function normalizeIso(value: string): string {
  return new Date(value).toISOString();
}

export function sinceTimestamp(days: number): string {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
  return new Date(Date.now() - safeDays * 86_400_000).toISOString();
}

export function parseJsonArray<T>(raw: string | undefined | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function toBreakdown(map: Map<string, number>): BreakdownItem[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function buildDailySeries(days: number): Map<string, OverviewDailyPoint> {
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

export function aggregateOverview(
  query: AnalyticsQuery,
  latestSnapshots: SnapshotRowData[],
  syncStates: SyncStateRowData[],
  invokedRows: InvokedRowData[],
  feedbackRows: FeedbackRowData[]
): OverviewResponse {
  const catalogSkills = new Map<string, { status?: string; stage1Tokens: number }>();
  let alwaysLoadedTokens = 0;
  let evalTotal = 0;
  let evalPassed = 0;

  for (const snap of latestSnapshots) {
    alwaysLoadedTokens += Number(snap.always_loaded_tokens);
    evalTotal += Number(snap.eval_total);
    evalPassed += Number(snap.eval_passed);
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

    const dayPoint = dailyMap.get(row.timestamp.slice(0, 10));
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
    library: query.library ?? null,
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

export function aggregateSkillsAnalytics(
  query: AnalyticsQuery,
  latestSnapshots: SnapshotRowData[],
  syncStates: SyncStateRowData[],
  invRows: InvokedRowData[],
  fbRows: Array<{ library: string; skill: string }>
): SkillsAnalyticsResponse {
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

  for (const snap of latestSnapshots) {
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

  for (const sync of syncStates) {
    for (const installed of parseJsonArray<string>(sync.skills_json)) {
      const entry = ensure(sync.library, installed);
      entry.inCatalogOrSynced = true;
      entry.syncedProjects.add(sync.project_hash);
    }
  }

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
    library: query.library ?? null,
    days: query.days,
    skills
  };
}

export function aggregateBudgets(query: AnalyticsQuery, rows: SnapshotRowData[]): BudgetsResponse {
  const snapshots: BudgetHistoryPoint[] = rows.map((row) => {
    const total = Number(row.eval_total);
    const passed = Number(row.eval_passed);
    return {
      eventId: row.event_id,
      library: row.library,
      timestamp: row.timestamp,
      gitSha: row.git_sha,
      gitBranch: row.git_branch,
      skillsCount: Number(row.skills_count),
      alwaysLoadedTokens: Number(row.always_loaded_tokens),
      bodyTokens: Number(row.body_tokens),
      resourceTokens: Number(row.resource_tokens),
      validationErrors: Number(row.validation_errors),
      validationWarnings: Number(row.validation_warnings),
      evalTotal: total,
      evalPassed: passed,
      evalFailed: Number(row.eval_failed),
      evalPassRate: total > 0 ? passed / total : null
    };
  });

  return {
    library: query.library ?? null,
    days: query.days,
    snapshots
  };
}

export function aggregateFeedbackSummary(
  query: AnalyticsQuery,
  rows: FeedbackRowData[],
  triageRows: TriageRowData[]
): FeedbackResponse {
  const triageMap = new Map<string, TriageRowData>();
  for (const row of triageRows) triageMap.set(row.group_key, row);

  const groupsMap = new Map<
    string,
    {
      groupKey: string;
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

    const groupKey = computeFeedbackGroupKey(row.library, row.skill, step, symptom);
    let group = groupsMap.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        library: row.library,
        skill: row.skill,
        step,
        symptom,
        count: 0,
        suggestedEvalCaseCount: 0,
        fixes: new Set<string>(),
        latestTimestamp: row.timestamp
      };
      groupsMap.set(groupKey, group);
    }
    group.count += 1;
    if (hasSuggestedEvalCase) group.suggestedEvalCaseCount += 1;
    if (proposedFix) group.fixes.add(proposedFix);
    if (row.timestamp > group.latestTimestamp) group.latestTimestamp = row.timestamp;
  }

  let groups: FeedbackGroupRow[] = [...groupsMap.values()].map((item) => {
    const triage = triageMap.get(item.groupKey);
    return {
      groupKey: item.groupKey,
      library: item.library,
      skill: item.skill,
      step: item.step,
      symptom: item.symptom,
      count: item.count,
      suggestedEvalCaseCount: item.suggestedEvalCaseCount,
      proposedFixes: [...item.fixes],
      latestTimestamp: item.latestTimestamp,
      status: triage?.status ?? "open",
      note: triage?.note ?? null,
      updatedAt: triage?.updated_at ?? null
    };
  });

  if (query.status) {
    groups = groups.filter((group) => group.status === query.status);
  }
  groups.sort((a, b) => b.count - a.count || b.latestTimestamp.localeCompare(a.latestTimestamp));

  return {
    library: query.library ?? null,
    days: query.days,
    totalEvents: rows.length,
    groups,
    recent
  };
}

export function aggregateAdoption(
  query: AnalyticsQuery,
  syncRows: SyncStateRowData[],
  latestSnapshots: SnapshotRowData[]
): AdoptionResponse {
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
      alwaysLoadedTokens: Number(row.always_loaded_tokens),
      installedSkills
    };
  });

  return {
    library: query.library ?? null,
    totalSyncedProjects: projectSet.size,
    byTarget: toBreakdown(targetCounts),
    projects,
    deprecatedInstalled
  };
}

export function aggregateSkillDetail(
  library: string,
  skill: string,
  days: number,
  summary: SkillAnalyticsRow | null,
  invRows: InvokedRowData[],
  fbRows: FeedbackRowData[],
  triageRows: TriageRowData[],
  syncRows: SyncStateRowData[]
): SkillDetailResponse {
  const dailyMap = buildDailySeries(days);
  const agentCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();

  for (const row of invRows) {
    const point = dailyMap.get(row.timestamp.slice(0, 10));
    if (point) {
      point.invocations += 1;
      if (row.outcome === "error") point.errors += 1;
    }
    const agent = row.agent || "unknown";
    agentCounts.set(agent, (agentCounts.get(agent) ?? 0) + 1);
    const model = row.model || "unspecified";
    modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
  }

  for (const row of fbRows) {
    const point = dailyMap.get(row.timestamp.slice(0, 10));
    if (point) point.feedback += 1;
  }

  const fbSummary = aggregateFeedbackSummary({ library, days }, fbRows, triageRows);
  const syncedProjects: ProjectSyncRow[] = [];
  for (const row of syncRows) {
    const installedSkills = parseJsonArray<string>(row.skills_json);
    if (installedSkills.includes(skill)) {
      syncedProjects.push({
        projectHash: row.project_hash,
        target: row.target,
        library: row.library,
        scope: row.scope,
        mode: row.mode,
        syncedAt: row.synced_at,
        alwaysLoadedTokens: Number(row.always_loaded_tokens),
        installedSkills
      });
    }
  }

  return {
    library,
    skill,
    days,
    summary,
    daily: [...dailyMap.values()],
    byAgent: toBreakdown(agentCounts),
    byModel: toBreakdown(modelCounts),
    feedback: fbSummary.groups,
    syncedProjects
  };
}
