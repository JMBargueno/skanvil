import { useState } from "react";

import type { FeedbackGroupRow, FeedbackResponse, FeedbackStatus } from "../../shared/schema.js";

const STATUS_FILTERS: Array<{ value: "all" | FeedbackStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "triaged", label: "Triaged" },
  { value: "resolved", label: "Resolved" }
];

function statusBadgeClass(status: FeedbackStatus): string {
  if (status === "resolved") return "badge-success";
  if (status === "triaged") return "badge-accent";
  return "badge-warn";
}

export function FeedbackView({
  data,
  statusFilter,
  onStatusFilterChange,
  onTriageChange
}: {
  data: FeedbackResponse;
  statusFilter: "all" | FeedbackStatus;
  onStatusFilterChange: (status: "all" | FeedbackStatus) => void;
  onTriageChange: (group: FeedbackGroupRow, nextStatus: FeedbackStatus) => Promise<void>;
}) {
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleStatusChange = async (group: FeedbackGroupRow, nextStatus: FeedbackStatus) => {
    setUpdatingKey(group.groupKey);
    try {
      await onTriageChange(group, nextStatus);
    } finally {
      setUpdatingKey(null);
    }
  };

  const handleCopyIssue = async (group: FeedbackGroupRow) => {
    const lines = [
      `### Skill friction report: \`${group.skill}\` (${group.library})`,
      "",
      `- **Step**: ${group.step}`,
      `- **Occurrences**: ${group.count}`,
      `- **Symptom**: ${group.symptom}`,
      ...(group.proposedFixes.length > 0 ? [`- **Proposed fix**: ${group.proposedFixes[0]}`] : []),
      "",
      "Run `npx skanvil feedback promote --prune` in the library repo if a suggested eval case is ready."
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopiedKey(group.groupKey);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // ignore clipboard refusal
    }
  };

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
        <div className="toolbar">
          <div className="filters">
            <h3 className="card-title">Grouped Friction Queue ({data.groups.length})</h3>
            <div className="segmented-sm">
              {STATUS_FILTERS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`btn btn-sm ${statusFilter === opt.value ? "btn-primary" : ""}`}
                  onClick={() => onStatusFilterChange(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            {data.totalEvents} total report(s)
          </span>
        </div>

        {data.groups.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No feedback events match this filter.
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
                  <th>Triage</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((group) => (
                  <tr key={group.groupKey}>
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
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        Latest: {group.latestTimestamp.slice(0, 10)}
                      </div>
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
                    <td>
                      <select
                        aria-label={`Triage status for ${group.skill}`}
                        className={`select badge ${statusBadgeClass(group.status)}`}
                        style={{ padding: "4px 8px", fontSize: 12 }}
                        value={group.status}
                        disabled={updatingKey === group.groupKey}
                        onChange={(e) => void handleStatusChange(group, e.target.value as FeedbackStatus)}
                      >
                        <option value="open">open</option>
                        <option value="triaged">triaged</option>
                        <option value="resolved">resolved</option>
                      </select>
                    </td>
                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => void handleCopyIssue(group)}>
                        {copiedKey === group.groupKey ? "Copied" : "Copy Issue"}
                      </button>
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
