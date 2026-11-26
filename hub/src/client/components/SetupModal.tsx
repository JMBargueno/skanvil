import { useState } from "react";

function SnippetBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore clipboard denial
    }
  };

  return (
    <div className="snippet-box">
      <div className="snippet-header">
        <span>{title}</span>
        <button type="button" className="btn btn-sm" onClick={() => void handleCopy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="snippet-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function SetupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4318";

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Connect skanvil CLI and hooks">
      <div className="modal-card">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <h2 className="card-title" style={{ fontSize: 18 }}>
            Connect skanvil CLI &amp; Agent Hooks
          </h2>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Telemetry is opt-in and never sends prompts, file contents, secrets, or unhashed local paths. Set{" "}
          <span className="code-chip">DO_NOT_TRACK=1</span> anytime to silence all emissions.
        </p>

        <SnippetBlock
          title="1. Configure .skanvilrc.json in your skills library"
          code={`{
  "telemetry": {
    "enabled": true,
    "endpoint": "${origin}",
    "timeoutMs": 1500
  }
}`}
        />

        <SnippetBlock
          title="2. Export environment variables (optional override or API key)"
          code={`export SKANVIL_TELEMETRY_URL="${origin}"
export SKANVIL_TELEMETRY_KEY="your-ingestion-api-key"`}
        />

        <SnippetBlock
          title="3. Publish a library snapshot from local checkout or CI"
          code={`npx skanvil telemetry snapshot`}
        />

        <SnippetBlock
          title="4. Install non-blocking usage hooks for Claude Code, Cursor, or Gemini CLI"
          code={`npx skanvil telemetry install-hooks --target claude,cursor,gemini`}
        />

        <SnippetBlock
          title="5. Push sanitized friction reports & flush offline queue"
          code={`npx skanvil feedback push
npx skanvil telemetry push`}
        />
      </div>
    </div>
  );
}
