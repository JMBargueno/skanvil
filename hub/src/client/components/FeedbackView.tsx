import type { FeedbackResponse } from "../../shared/schema.js";

export function FeedbackView({ data }: { data: FeedbackResponse }) {
  return (
    <div className="stack-col">
      <div className="banner">
        <span>
          Friction reports come from <span className="code-chip">.skanvil-feedback.jsonl</span> via{" "}
          <span className="code-chip">npx skanvil feedback push</span> (secrets and local home paths are redacted before
          upload). Promote suggested cases locally with{" "}
          <span className="code-chip">npx skanvil feedback promote --prune</span>.
        </span>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Grouped Friction Queue ({data.groups.length})</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {data.totalEvents} total report(s)
          </span>
        </div>

        {data.groups.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No feedback events recorded in this time window.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Library</th>
                  <th>Step</th>
                  <th>Symptom &amp; Proposed Fix</th>
                  <th>Reports</th>
                  <th>Eval Cases</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((group) => (
                  <tr key={`${group.library}:${group.skill}:${group.step}:${group.symptom}`}>
                    <td>
                      <span className="code-chip">{group.skill}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {group.library}
                    </td>
                    <td>
                      <span className="badge badge-neutral">{group.step}</span>
                    </td>
                    <td>
                      <div>{group.symptom}</div>
                      {group.proposedFixes.length > 0 && (
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          Fix: {group.proposedFixes[0]}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="badge badge-warn">{group.count}</span>
                    </td>
                    <td>
                      {group.suggestedEvalCaseCount > 0 ? (
                        <span className="badge badge-accent">{group.suggestedEvalCaseCount} ready</span>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {group.latestTimestamp.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.recent.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Recent Feedback Events</h3>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Skill</th>
                  <th>Step</th>
                  <th>Symptom</th>
                  <th>Agent</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((item) => (
                  <tr key={item.eventId}>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {item.timestamp.slice(0, 16).replace("T", " ")}
                    </td>
                    <td>
                      <span className="code-chip">{item.skill}</span>
                    </td>
                    <td>{item.step}</td>
                    <td>{item.symptom}</td>
                    <td className="muted">{[item.agent, item.model].filter(Boolean).join(" / ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
