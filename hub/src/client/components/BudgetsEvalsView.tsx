import type { BudgetsResponse } from "../../shared/schema.js";

export function BudgetsEvalsView({ data }: { data: BudgetsResponse }) {
  const points = data.snapshots;
  if (points.length === 0) {
    return (
      <div className="card empty-state">
        <div className="empty-icon-ring" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 17l6-6 4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M17 7h4v4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h3 style={{ margin: 0, fontSize: 18 }}>No library snapshots recorded yet</h3>
        <p className="muted" style={{ margin: 0, maxWidth: 480 }}>
          Run <span className="code-chip">npx skanvil telemetry snapshot</span> locally or from CI to track Stage-1,
          Stage-2, Stage-3 token budgets and eval trigger pass rates over time.
        </p>
      </div>
    );
  }

  const width = 720;
  const height = 216;
  const padLeft = 48;
  const padRight = 18;
  const padTop = 16;
  const padBottom = 28;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const baseY = padTop + plotHeight;

  const maxTokens = points.reduce(
    (acc, item) => Math.max(acc, item.alwaysLoadedTokens, item.bodyTokens, item.resourceTokens),
    10
  );

  const coordX = (index: number) =>
    points.length === 1 ? padLeft + plotWidth / 2 : padLeft + (index / (points.length - 1)) * plotWidth;
  const coordY = (val: number) => padTop + plotHeight * (1 - val / maxTokens);

  const buildPath = (getter: (item: (typeof points)[number]) => number) =>
    points
      .map((item, idx) => `${idx === 0 ? "M" : "L"}${coordX(idx).toFixed(1)},${coordY(getter(item)).toFixed(1)}`)
      .join(" ");

  const buildAreaPath = (getter: (item: (typeof points)[number]) => number) => {
    const line = buildPath(getter);
    const lastX = coordX(points.length - 1).toFixed(1);
    const firstX = coordX(0).toFixed(1);
    return `${line} L${lastX},${baseY.toFixed(1)} L${firstX},${baseY.toFixed(1)} Z`;
  };

  return (
    <div className="stack-col">
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">3-Stage Token Budget History</h3>
          <div className="legend">
            <span className="legend-item">
              <span className="dot" style={{ background: "var(--accent)", color: "var(--accent)" }} /> Stage 1
              (Always-Loaded)
            </span>
            <span className="legend-item">
              <span className="dot" style={{ background: "var(--success)", color: "var(--success)" }} /> Stage 2 (Body)
            </span>
            <span className="legend-item">
              <span className="dot" style={{ background: "var(--warn)", color: "var(--warn)" }} /> Stage 3 (Resources)
            </span>
          </div>
        </div>

        <div className="chart-wrap">
          <svg
            className="chart-svg"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="3-stage token budget trend chart"
          >
            <defs>
              <linearGradient id="stage1Area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="stage2Area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--success)" stopOpacity="0.2" />
                <stop offset="100%" stopColor="var(--success)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="stage3Area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--warn)" stopOpacity="0.16" />
                <stop offset="100%" stopColor="var(--warn)" stopOpacity="0" />
              </linearGradient>
            </defs>

            {[0, 0.5, 1].map((ratio) => {
              const y = padTop + plotHeight * (1 - ratio);
              return (
                <g key={ratio}>
                  <line
                    x1={padLeft}
                    y1={y}
                    x2={width - padRight}
                    y2={y}
                    stroke="var(--chart-grid)"
                    strokeDasharray="3 4"
                  />
                  <text x={padLeft - 7} y={y + 4} textAnchor="end" fontSize="10" fill="var(--chart-axis)">
                    {Math.round(maxTokens * ratio)}
                  </text>
                </g>
              );
            })}

            {points.length > 1 && (
              <>
                <path d={buildAreaPath((p) => p.bodyTokens)} fill="url(#stage2Area)" />
                <path d={buildAreaPath((p) => p.resourceTokens)} fill="url(#stage3Area)" />
                <path d={buildAreaPath((p) => p.alwaysLoadedTokens)} fill="url(#stage1Area)" />
                <path
                  d={buildPath((p) => p.bodyTokens)}
                  fill="none"
                  stroke="var(--success)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d={buildPath((p) => p.resourceTokens)}
                  fill="none"
                  stroke="var(--warn)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d={buildPath((p) => p.alwaysLoadedTokens)}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </>
            )}

            {points.map((point, idx) => {
              const x = coordX(idx);
              const showLabel = idx === 0 || idx === points.length - 1;
              return (
                <g key={point.eventId}>
                  <circle
                    cx={x}
                    cy={coordY(point.alwaysLoadedTokens)}
                    r="4.5"
                    fill="var(--accent)"
                    stroke="var(--chart-dot-ring)"
                    strokeWidth="2"
                  >
                    <title>
                      {`${point.timestamp.slice(0, 16)} (${point.library}): Stage 1 = ${point.alwaysLoadedTokens}`}
                    </title>
                  </circle>
                  <circle
                    cx={x}
                    cy={coordY(point.bodyTokens)}
                    r="4"
                    fill="var(--success)"
                    stroke="var(--chart-dot-ring)"
                    strokeWidth="1.8"
                  >
                    <title>{`Stage 2 = ${point.bodyTokens}`}</title>
                  </circle>
                  <circle
                    cx={x}
                    cy={coordY(point.resourceTokens)}
                    r="4"
                    fill="var(--warn)"
                    stroke="var(--chart-dot-ring)"
                    strokeWidth="1.8"
                  >
                    <title>{`Stage 3 = ${point.resourceTokens}`}</title>
                  </circle>
                  {showLabel && (
                    <text x={x} y={height - 8} textAnchor="middle" fontSize="10" fill="var(--chart-axis)">
                      {point.timestamp.slice(5, 10)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Snapshot Log</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {points.length} snapshot(s)
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Library</th>
                <th>Git Ref</th>
                <th>Skills</th>
                <th>Stage 1</th>
                <th>Stage 2</th>
                <th>Stage 3</th>
                <th>Validation</th>
                <th>Eval Triggers</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((snap) => (
                <tr key={snap.eventId}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {snap.timestamp.slice(0, 19).replace("T", " ")}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {snap.library}
                  </td>
                  <td>
                    {snap.gitBranch || snap.gitSha ? (
                      <span className="code-chip">
                        {snap.gitBranch ?? ""}
                        {snap.gitBranch && snap.gitSha ? "@" : ""}
                        {snap.gitSha ?? ""}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{snap.skillsCount}</td>
                  <td>~{snap.alwaysLoadedTokens.toLocaleString()}</td>
                  <td>~{snap.bodyTokens.toLocaleString()}</td>
                  <td>~{snap.resourceTokens.toLocaleString()}</td>
                  <td>
                    <span className={`badge ${snap.validationErrors > 0 ? "badge-danger" : "badge-success"}`}>
                      {snap.validationErrors} err / {snap.validationWarnings} warn
                    </span>
                  </td>
                  <td>
                    {snap.evalTotal > 0 ? (
                      <span className={`badge ${snap.evalFailed > 0 ? "badge-warn" : "badge-success"}`}>
                        {snap.evalPassed}/{snap.evalTotal} ({Math.round((snap.evalPassRate ?? 0) * 100)}%)
                      </span>
                    ) : (
                      <span className="muted">No triggers</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
