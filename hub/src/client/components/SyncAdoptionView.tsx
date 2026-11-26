import type { AdoptionResponse } from "../../shared/schema.js";

export function SyncAdoptionView({ data }: { data: AdoptionResponse }) {
  const maxTarget = data.byTarget.reduce((acc, item) => Math.max(acc, item.count), 0);

  return (
    <div className="stack-col">
      {data.deprecatedInstalled.length > 0 && (
        <div className="card" style={{ borderColor: "rgba(244, 63, 94, 0.5)" }}>
          <div className="card-header">
            <h3 className="card-title" style={{ color: "var(--danger)" }}>
              Deprecated Skills Still Installed ({data.deprecatedInstalled.length})
            </h3>
            <span className="badge badge-danger">Action Recommended</span>
          </div>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Re-run <span className="code-chip">npx skanvil sync</span> in affected repositories to prune deprecated
            skills automatically.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Project Hash</th>
                  <th>Target</th>
                  <th>Library</th>
                  <th>Deprecated Skill</th>
                  <th>Replaced By</th>
                  <th>Last Synced</th>
                </tr>
              </thead>
              <tbody>
                {data.deprecatedInstalled.map((alert) => (
                  <tr key={`${alert.projectHash}:${alert.target}:${alert.library}:${alert.skill}`}>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {alert.projectHash}
                    </td>
                    <td>
                      <span className="badge badge-neutral">{alert.target}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {alert.library}
                    </td>
                    <td>
                      <span className="code-chip">{alert.skill}</span>
                    </td>
                    <td>{alert.replacedBy ? <span className="code-chip">{alert.replacedBy}</span> : "—"}</td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {alert.syncedAt.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="split-grid">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Synced Projects ({data.totalSyncedProjects})</h3>
            <span className="muted" style={{ fontSize: 12 }}>
              {data.projects.length} target state(s)
            </span>
          </div>
          {data.projects.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No <span className="code-chip">sync.applied</span> events recorded yet. Enable{" "}
              <span className="code-chip">telemetry.enabled</span> in <span className="code-chip">.skanvilrc.json</span>{" "}
              or pass <span className="code-chip">SKANVIL_TELEMETRY_URL</span> during sync.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Project Hash</th>
                    <th>Library</th>
                    <th>Target</th>
                    <th>Scope / Mode</th>
                    <th>Installed</th>
                    <th>Stage-1 Tokens</th>
                    <th>Last Synced</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((proj) => (
                    <tr key={`${proj.projectHash}:${proj.target}:${proj.library}`}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {proj.projectHash}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {proj.library}
                      </td>
                      <td>
                        <span className="badge badge-accent">{proj.target}</span>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {proj.scope} · {proj.mode}
                      </td>
                      <td>{proj.installedSkills.length}</td>
                      <td>~{proj.alwaysLoadedTokens.toLocaleString()}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {proj.syncedAt.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Target Distribution</h3>
          </div>
          {data.byTarget.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              No sync targets recorded.
            </p>
          ) : (
            <div className="bar-list">
              {data.byTarget.map((item) => {
                const pct = maxTarget > 0 ? Math.max(6, Math.round((item.count / maxTarget) * 100)) : 0;
                return (
                  <div className="bar-row" key={item.name}>
                    <div className="bar-meta">
                      <span className="mono">{item.name}</span>
                      <span>{item.count}</span>
                    </div>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${pct}%`, background: "var(--success)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
