import type { BreakdownItem, OverviewResponse } from "../../shared/schema.js";

interface OverviewViewProps {
  data: OverviewResponse;
  onOpenSetup: () => void;
}

function BreakdownCard({ title, items }: { title: string; items: BreakdownItem[] }) {
  const max = items.reduce((acc, item) => Math.max(acc, item.count), 0);
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">{title}</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {items.length} group(s)
        </span>
      </div>
      {items.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          No usage events recorded in this window.
        </p>
      ) : (
        <div className="bar-list">
          {items.slice(0, 8).map((item) => {
            const pct = max > 0 ? Math.max(4, Math.round((item.count / max) * 100)) : 0;
            return (
              <div className="bar-row" key={item.name}>
                <div className="bar-meta">
                  <span className="mono">{item.name}</span>
                  <span>{item.count.toLocaleString()}</span>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function OverviewView({ data, onOpenSetup }: OverviewViewProps) {
  if (data.totalInvocations === 0 && data.catalogSkills === 0 && data.feedbackCount === 0) {
    return (
      <div className="card empty-state">
        <div className="empty-icon-ring" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 17l5-5 4 4 7-8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M16 8h4v4" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="3" y="3" width="18" height="18" rx="5" opacity="0.35" />
          </svg>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, letterSpacing: "-0.025em" }}>No telemetry data received yet</h2>
        <p className="muted" style={{ maxWidth: 520, margin: 0, fontSize: 14 }}>
          Connect a skills library with CI snapshots or coding agent hooks to see usage metrics, zombie-skill detection,
          Stage-1 token trends, and friction reports.
        </p>
        <button type="button" className="btn btn-primary" style={{ marginTop: 4 }} onClick={onOpenSetup}>
          Connect CLI &amp; Hooks
        </button>
        <div className="empty-hint">
          <span>Want instant demo telemetry? Run</span>
          <span className="code-chip">npm --prefix hub run seed</span>
        </div>
      </div>
    );
  }

  const maxDaily = data.daily.reduce((acc, point) => Math.max(acc, point.invocations, point.errors, point.feedback), 1);
  const chartWidth = 720;
  const chartHeight = 186;
  const padLeft = 36;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 26;
  const plotWidth = chartWidth - padLeft - padRight;
  const plotHeight = chartHeight - padTop - padBottom;
  const stepWidth = data.daily.length > 0 ? plotWidth / data.daily.length : plotWidth;
  const barWidth = Math.max(4, Math.min(20, stepWidth * 0.58));

  const successPct = data.successRate !== null ? `${Math.round(data.successRate * 100)}%` : "—";
  const evalPct = data.evalPassRate !== null ? `${Math.round(data.evalPassRate * 100)}%` : "—";

  return (
    <div className="stack-col">
      <div className="kpi-grid">
        <div className="card kpi-card">
          <div className="kpi-label">Invocations ({data.days}d)</div>
          <div className="kpi-value">{data.totalInvocations.toLocaleString()}</div>
          <div className="kpi-sub">
            Success rate {successPct} · {data.errorCount} errors
          </div>
        </div>

        <div className="card kpi-card">
          <div className="kpi-label">Active / Catalog Skills</div>
          <div className="kpi-value">
            {data.activeSkills} / {data.catalogSkills}
          </div>
          <div className="kpi-sub">Skills invoked during window</div>
        </div>

        <div className="card kpi-card">
          <div className="kpi-label">Zombie Skills</div>
          <div className="kpi-value" style={{ color: data.zombieSkills > 0 ? "var(--warn)" : "var(--success)" }}>
            {data.zombieSkills}
          </div>
          <div className="kpi-sub">
            {data.zombieSkills > 0
              ? `~${data.wastedStage1Tokens.toLocaleString()} unused Stage-1 tokens`
              : "All catalog skills are active"}
          </div>
        </div>

        <div className="card kpi-card">
          <div className="kpi-label">Always-Loaded (Stage 1)</div>
          <div className="kpi-value">~{data.alwaysLoadedTokens.toLocaleString()}</div>
          <div className="kpi-sub">Estimated tokens across snapshots</div>
        </div>

        <div className="card kpi-card">
          <div className="kpi-label">Eval Trigger Pass Rate</div>
          <div className="kpi-value">{evalPct}</div>
          <div className="kpi-sub">Latest CI trigger routing check</div>
        </div>

        <div className="card kpi-card">
          <div className="kpi-label">Projects &amp; Feedback</div>
          <div className="kpi-value">{data.activeProjects} projects</div>
          <div className="kpi-sub">{data.feedbackCount} friction report(s)</div>
        </div>
      </div>

      <div className="split-grid">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Daily Activity ({data.days}d UTC)</h3>
            <div className="legend">
              <span className="legend-item">
                <span className="dot" style={{ background: "var(--accent)", color: "var(--accent)" }} /> Invocations
              </span>
              <span className="legend-item">
                <span className="dot" style={{ background: "var(--danger)", color: "var(--danger)" }} /> Errors
              </span>
              <span className="legend-item">
                <span className="dot" style={{ background: "var(--warn)", color: "var(--warn)" }} /> Feedback
              </span>
            </div>
          </div>

          <div className="chart-wrap">
            <svg
              className="chart-svg"
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              role="img"
              aria-label="Daily skill invocations, errors, and feedback chart"
            >
              <defs>
                <linearGradient id="invGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent-hover)" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.45" />
                </linearGradient>
                <linearGradient id="errGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--danger)" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="var(--danger)" stopOpacity="0.45" />
                </linearGradient>
                <linearGradient id="fbGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--warn)" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="var(--warn)" stopOpacity="0.45" />
                </linearGradient>
              </defs>

              {[0, 0.5, 1].map((ratio) => {
                const y = padTop + plotHeight * (1 - ratio);
                const val = Math.round(maxDaily * ratio);
                return (
                  <g key={ratio}>
                    <line
                      x1={padLeft}
                      y1={y}
                      x2={chartWidth - padRight}
                      y2={y}
                      stroke="var(--chart-grid)"
                      strokeDasharray="3 4"
                    />
                    <text x={padLeft - 7} y={y + 4} textAnchor="end" fontSize="10" fill="var(--chart-axis)">
                      {val}
                    </text>
                  </g>
                );
              })}

              {data.daily.map((point, index) => {
                const xCenter = padLeft + index * stepWidth + stepWidth / 2;
                const invH = (point.invocations / maxDaily) * plotHeight;
                const errH = (point.errors / maxDaily) * plotHeight;
                const fbH = (point.feedback / maxDaily) * plotHeight;
                const baseY = padTop + plotHeight;
                const showDate =
                  index === 0 || index === data.daily.length - 1 || index === Math.floor(data.daily.length / 2);

                return (
                  <g key={point.date}>
                    <title>
                      {`${point.date}: ${point.invocations} invocation(s), ${point.errors} error(s), ${point.feedback} feedback`}
                    </title>
                    <rect
                      x={xCenter - barWidth / 2}
                      y={baseY - invH}
                      width={barWidth}
                      height={Math.max(invH, point.invocations > 0 ? 3 : 0)}
                      rx={4}
                      fill="url(#invGrad)"
                    />
                    {point.errors > 0 && (
                      <rect
                        x={xCenter - barWidth / 2}
                        y={baseY - errH}
                        width={Math.max(3, barWidth * 0.45)}
                        height={Math.max(3, errH)}
                        rx={2}
                        fill="url(#errGrad)"
                      />
                    )}
                    {point.feedback > 0 && (
                      <rect
                        x={xCenter}
                        y={baseY - fbH}
                        width={Math.max(3, barWidth * 0.45)}
                        height={Math.max(3, fbH)}
                        rx={2}
                        fill="url(#fbGrad)"
                      />
                    )}
                    {showDate && (
                      <text x={xCenter} y={chartHeight - 6} textAnchor="middle" fontSize="10" fill="var(--chart-axis)">
                        {point.date.slice(5)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        <div className="stack-col">
          <BreakdownCard title="By Agent" items={data.byAgent} />
          <BreakdownCard title="By Model" items={data.byModel} />
        </div>
      </div>
    </div>
  );
}
