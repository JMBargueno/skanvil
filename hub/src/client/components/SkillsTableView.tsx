import { useMemo, useState } from "react";

import type { SkillAnalyticsRow, SkillsAnalyticsResponse } from "../../shared/schema.js";

type SortKey =
  | "skill"
  | "library"
  | "stage1Tokens"
  | "invocations"
  | "frictionRate"
  | "avgDurationMs"
  | "syncedProjects"
  | "lastUsedAt";

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function compareRows(a: SkillAnalyticsRow, b: SkillAnalyticsRow, key: SortKey, dir: "asc" | "desc"): number {
  const factor = dir === "asc" ? 1 : -1;
  if (key === "skill" || key === "library") {
    return a[key].localeCompare(b[key]) * factor;
  }
  if (key === "lastUsedAt") {
    return (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? "") * factor;
  }
  const va = a[key] ?? -1;
  const vb = b[key] ?? -1;
  return (va - vb) * factor;
}

export function SkillsTableView({
  data,
  onSelectSkill
}: {
  data: SkillsAnalyticsResponse;
  onSelectSkill: (library: string, skill: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [onlyZombies, setOnlyZombies] = useState(false);
  const [onlyDeprecated, setOnlyDeprecated] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("invocations");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "skill" || key === "library" ? "asc" : "desc");
    }
  };

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.skills
      .filter((row) => {
        if (onlyZombies && !row.isZombie) return false;
        if (onlyDeprecated && row.status !== "deprecated") return false;
        if (!q) return true;
        return (
          row.skill.toLowerCase().includes(q) ||
          row.library.toLowerCase().includes(q) ||
          (row.owner?.toLowerCase().includes(q) ?? false) ||
          (row.category?.toLowerCase().includes(q) ?? false)
        );
      })
      .sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [data.skills, search, onlyZombies, onlyDeprecated, sortKey, sortDir]);

  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : "");

  return (
    <div className="card">
      <div className="toolbar">
        <div className="filters">
          <input
            type="search"
            className="input"
            placeholder="Filter by skill, owner, category..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ minWidth: 260 }}
          />
          <label className="checkbox-label">
            <input type="checkbox" checked={onlyZombies} onChange={(e) => setOnlyZombies(e.target.checked)} />
            Only Zombie Skills
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={onlyDeprecated} onChange={(e) => setOnlyDeprecated(e.target.checked)} />
            Only Deprecated
          </label>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          Showing {rows.length} of {data.skills.length} skill(s) · click any skill for details
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="muted" style={{ margin: "18px 0 4px" }}>
          No skills match the selected filters.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <button type="button" className="th-btn" onClick={() => toggleSort("skill")}>
                    Skill {sortIndicator("skill")}
                  </button>
                </th>
                <th>
                  <button type="button" className="th-btn" onClick={() => toggleSort("library")}>
                    Library {sortIndicator("library")}
                  </button>
                </th>
                <th>Status &amp; Owner</th>
                <th>
                  <button type="button" className="th-btn" onClick={() => toggleSort("stage1Tokens")}>
                    Stage-1 Tokens {sortIndicator("stage1Tokens")}
                  </button>
                </th>
                <th>
                  <button type="button" className="th-btn" onClick={() => toggleSort("invocations")}>
                    Invocations {sortIndicator("invocations")}
                  </button>
                </th>
                <th>
                  <button type="button" className="th-btn" onClick={() => toggleSort("frictionRate")}>
                    Friction {sortIndicator("frictionRate")}
                  </button>
                </th>
                <th>
                  <button type="button" className="th-btn" onClick={() => toggleSort("avgDurationMs")}>
                    Avg Duration {sortIndicator("avgDurationMs")}
                  </button>
                </th>
                <th>
                  <button type="button" className="th-btn" onClick={() => toggleSort("syncedProjects")}>
                    Synced {sortIndicator("syncedProjects")}
                  </button>
                </th>
                <th>
                  <button type="button" className="th-btn" onClick={() => toggleSort("lastUsedAt")}>
                    Last Used {sortIndicator("lastUsedAt")}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.library}:${row.skill}`}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="skill-link-chip"
                        onClick={() => onSelectSkill(row.library, row.skill)}
                      >
                        {row.skill}
                      </button>
                      {row.isZombie && <span className="badge badge-warn">ZOMBIE</span>}
                      {row.valid === false && <span className="badge badge-danger">INVALID</span>}
                    </div>
                    {row.category && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        category: {row.category}
                      </div>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {row.library}
                  </td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {row.status === "deprecated" ? (
                        <span className="badge badge-danger">deprecated</span>
                      ) : row.status ? (
                        <span className="badge badge-accent">{row.status}</span>
                      ) : (
                        <span className="badge badge-neutral">active</span>
                      )}
                      {row.owner && <span className="muted">{row.owner}</span>}
                    </div>
                    {row.replacedBy && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        replaced by <span className="mono">{row.replacedBy}</span>
                      </div>
                    )}
                  </td>
                  <td>{row.stage1Tokens !== null ? `~${row.stage1Tokens}` : "—"}</td>
                  <td>
                    <strong>{row.invocations}</strong>
                    {row.errorCount > 0 && (
                      <div className="muted" style={{ fontSize: 11 }}>
                        {row.errorCount} err
                      </div>
                    )}
                  </td>
                  <td>
                    {row.frictionEvents > 0 ? (
                      <span className="badge badge-warn">
                        {row.frictionEvents}
                        {row.frictionRate !== null ? ` (${Math.round(row.frictionRate * 100)}%)` : ""}
                      </span>
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td>{formatDuration(row.avgDurationMs)}</td>
                  <td>{row.syncedProjects}</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {row.lastUsedAt ? row.lastUsedAt.slice(0, 10) : "Never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
