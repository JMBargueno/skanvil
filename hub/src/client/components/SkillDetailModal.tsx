import { useEffect } from "react";

import type { SkillDetailResponse } from "../../shared/schema.js";

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function SkillDetailModal({
  open,
  loading,
  error,
  detail,
  onClose
}: {
  open: boolean;
  loading: boolean;
  error: string | null;
  detail: SkillDetailResponse | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const summary = detail?.summary ?? null;
  const successRate =
    summary && summary.invocations > 0 ? `${Math.round((summary.successCount / summary.invocations) * 100)}%` : "—";
  const maxDaily = detail?.daily.reduce((acc, p) => Math.max(acc, p.invocations, p.errors), 1) ?? 1;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Skill telemetry details"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card" style={{ maxWidth: 860 }}>
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h2 className="card-title" style={{ fontSize: 18 }}>
              {detail?.skill ?? "Skill Details"}
            </h2>
            {detail && <span className="code-chip">{detail.library}</span>}
            {summary?.isZombie && <span className="badge badge-warn">ZOMBIE</span>}
            {summary?.status === "deprecated" && <span className="badge badge-danger">deprecated</span>}
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {loading ? (
          <div className="loading-card" style={{ padding: "12px 0" }}>
            <div className="spinner" aria-hidden="true" />
            <p className="muted" style={{ margin: 0 }}>
              Loading skill metrics...
            </p>
          </div>
        ) : error ? (
          <div className="error-text">{error}</div>
        ) : detail ? (
          <div className="stack-col">
            <div className="kpi-grid">
              <div className="card kpi-card" style={{ padding: 14 }}>
                <div className="kpi-label">Invocations ({detail.days}d)</div>
                <div className="kpi-value" style={{ fontSize: 22 }}>
                  {summary?.invocations ?? 0}
                </div>
                <div className="kpi-sub">Success rate {successRate}</div>
              </div>
              <div className="card kpi-card" style={{ padding: 14 }}>
                <div className="kpi-label">Stage-1 Tokens</div>
                <div className="kpi-value" style={{ fontSize: 22 }}>
                  {summary?.stage1Tokens !== null && summary?.stage1Tokens !== undefined
                    ? `~${summary.stage1Tokens}`
                    : "—"}
                </div>
                <div className="kpi-sub">{summary?.bodyLines ?? "—"} body lines</div>
              </div>
              <div className="card kpi-card" style={{ padding: 14 }}>
                <div className="kpi-label">Avg Duration</div>
                <div className="kpi-value" style={{ fontSize: 22 }}>
                  {formatDuration(summary?.avgDurationMs ?? null)}
                </div>
                <div className="kpi-sub">
                  {summary?.avgToolCalls !== null && summary?.avgToolCalls !== undefined
                    ? `${summary.avgToolCalls.toFixed(1)} avg tool calls`
                    : "No tool call count"}
                </div>
              </div>
              <div className="card kpi-card" style={{ padding: 14 }}>
                <div className="kpi-label">Evals &amp; Owner</div>
                <div className="kpi-value" style={{ fontSize: 22 }}>
                  {summary?.evalTriggers ?? 0} triggers
                </div>
                <div className="kpi-sub">
                  {summary?.evalCases ?? 0} case(s) · {summary?.owner ?? "unassigned"}
                </div>
              </div>
            </div>

            <div className="card" style={{ padding: 16 }}>
              <div className="card-header">
                <h3 className="card-title">Daily Trend ({detail.days}d UTC)</h3>
              </div>
              <svg viewBox="0 0 680 120" style={{ width: "100%", height: 120, display: "block" }}>
                <defs>
                  <linearGradient id="skillBarGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent-hover)" stopOpacity="0.95" />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.45" />
                  </linearGradient>
                </defs>
                <line x1="20" y1="100" x2="660" y2="100" stroke="var(--chart-grid)" strokeDasharray="3 4" />
                {detail.daily.map((point, idx) => {
                  const slot = 640 / Math.max(1, detail.daily.length);
                  const barW = Math.max(4, Math.min(16, slot * 0.6));
                  const x = 20 + idx * slot + (slot - barW) / 2;
                  const h = (point.invocations / maxDaily) * 84;
                  return (
                    <g key={point.date}>
                      <title>{`${point.date}: ${point.invocations} invocations, ${point.errors} errors`}</title>
                      <rect
                        x={x}
                        y={100 - h}
                        width={barW}
                        height={Math.max(h, point.invocations > 0 ? 3 : 0)}
                        rx={3}
                        fill="url(#skillBarGrad)"
                      />
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="split-grid">
              <div className="card" style={{ padding: 16 }}>
                <h3 className="card-title" style={{ marginBottom: 10 }}>
                  Agents &amp; Models
                </h3>
                {detail.byAgent.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    No invocations recorded in this window.
                  </p>
                ) : (
                  <div className="bar-list">
                    {detail.byAgent.map((a) => (
                      <div className="bar-meta" key={a.name}>
                        <span className="mono">{a.name}</span>
                        <span>{a.count}</span>
                      </div>
                    ))}
                    {detail.byModel.length > 0 && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        Models: {detail.byModel.map((m) => `${m.name} (${m.count})`).join(", ")}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="card" style={{ padding: 16 }}>
                <h3 className="card-title" style={{ marginBottom: 10 }}>
                  Synced Projects ({detail.syncedProjects.length})
                </h3>
                {detail.syncedProjects.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    No synced target manifests report this skill.
                  </p>
                ) : (
                  <div className="bar-list">
                    {detail.syncedProjects.map((proj) => (
                      <div className="bar-meta" key={`${proj.projectHash}:${proj.target}`}>
                        <span className="mono" style={{ fontSize: 12 }}>
                          {proj.projectHash}
                        </span>
                        <span className="badge badge-neutral">{proj.target}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="card" style={{ padding: 16 }}>
              <h3 className="card-title" style={{ marginBottom: 10 }}>
                Open &amp; Historical Feedback ({detail.feedback.length})
              </h3>
              {detail.feedback.length === 0 ? (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  No feedback reports for this skill.
                </p>
              ) : (
                <div className="bar-list">
                  {detail.feedback.map((fb) => (
                    <div key={fb.groupKey} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span className="badge badge-neutral">{fb.step}</span>
                        <span className="badge badge-warn">x{fb.count}</span>
                        <span className="badge badge-accent">{fb.status}</span>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 13 }}>{fb.symptom}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
