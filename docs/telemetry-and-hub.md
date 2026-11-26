# Telemetry & Self-Hosted Hub (`skanvil-hub`)

skanvil includes an **opt-in**, privacy-preserving telemetry system paired with **`skanvil-hub`**, a self-hosted web application and REST ingestion API under [`hub/`](../hub/). Nothing is sent anywhere unless you explicitly configure an endpoint and opt in.

## What you can measure

- **Catalog & context budgets (`library.snapshot`)**: historical Stage-1 (`alwaysLoadedTokens`), Stage-2 (`bodyTokens`), and Stage-3 (`resourceTokens`) sizes, validation counts, eval trigger pass rates, and per-skill metadata (`owner`, `status`, `replacedBy`).
- **Real usage & performance (`skill.invoked`)**: invocations by skill, coding agent (`claude`, `cursor`, `gemini`, `copilot`, `windsurf`, `codex`, `opencode`, CLI), model, duration, tool calls, error rates, and **Zombie Skill** detection (non-deprecated catalog or synced skills with zero invocations in the selected time window).
- **Friction & quality loop (`skill.feedback`)**: redacted, deduplicated reports uploaded from `.skanvil-feedback.jsonl` with `skanvil feedback push`.
- **Sync adoption (`sync.applied`)**: per-project sync states, agent distribution, and alerts when repositories still have `deprecated` skills synced locally.

---

## Quick start: run `skanvil-hub` self-hosted

### Option A — Docker Compose (recommended)

```bash
cd hub
cp .env.example .env
# Set SKANVIL_HUB_API_KEYS and SKANVIL_HUB_ADMIN_TOKEN inside .env
docker compose up -d
```

- Dashboard UI: `http://localhost:4318`
- Ingestion endpoint: `POST http://localhost:4318/v1/events`
- Healthcheck: `GET http://localhost:4318/health`
- Persistent SQLite database stored on Docker volume `skanvil-hub-data` (`/data/skanvil-hub.sqlite`).

### Option B — Local Node.js (Node >= 22.5)

`skanvil-hub` uses Node's built-in `node:sqlite` (`DatabaseSync`), so zero C++ compiler or `node-gyp` build tools are required:

```bash
cd hub
npm install
npm run build
SKANVIL_HUB_ADMIN_TOKEN=dev-admin SKANVIL_HUB_API_KEYS=dev-ingest npm start
```

### Environment variables (`skanvil-hub`)

| Variable                                    | Default                     | Description                                                                                      |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| `PORT`                                      | `4318`                      | HTTP listener port.                                                                              |
| `HOST`                                      | `0.0.0.0`                   | Bind interface.                                                                                  |
| `SKANVIL_HUB_DB_PATH`                       | `./data/skanvil-hub.sqlite` | SQLite file path (created automatically; WAL mode enabled).                                      |
| `DATABASE_URL` / `SKANVIL_HUB_DATABASE_URL` | `""` (SQLite)               | Optional PostgreSQL connection string (`pg`); when set, switches `TelemetryStore` to PostgreSQL. |
| `SKANVIL_HUB_API_KEYS`                      | `""` (open)                 | Comma-separated Bearer API keys accepted by `POST /v1/events`.                                   |
| `SKANVIL_HUB_ADMIN_TOKEN`                   | `""` (open local dev mode)  | Protects `/api/dashboard/*` and the UI via an `HttpOnly` HMAC session cookie or `Bearer` header. |
| `SKANVIL_HUB_COOKIE_SECURE`                 | `false`                     | Set to `true` when serving `skanvil-hub` behind an HTTPS reverse proxy.                          |
| `SKANVIL_HUB_RETENTION_DAYS`                | `""` (disabled)             | Prune events and superseded snapshots older than N days (`1`–`3650`) on startup and daily timer. |
| `SKANVIL_HUB_WEBHOOK_URL`                   | `""` (disabled)             | Optional Slack, Discord, or generic webhook URL for hub alert notifications.                     |
| `SKANVIL_HUB_ALERT_MAX_STAGE1_TOKENS`       | `""`                        | Alert threshold when a snapshot's `alwaysLoadedTokens` exceeds N tokens.                         |
| `SKANVIL_HUB_ALERT_MIN_EVAL_PASS_RATE`      | `""`                        | Alert threshold (`0`–`1` or `0`–`100`) when eval trigger pass rate drops below minimum.          |
| `SKANVIL_HUB_ALERT_ON_VALIDATION_ERRORS`    | `true`                      | Set `false` to mute webhook alerts when a snapshot reports validation errors.                    |
| `SKANVIL_HUB_ALERT_ON_DEPRECATED_SYNC`      | `true`                      | Set `false` to mute webhook alerts when `sync.applied` installs a `deprecated` skill.            |

When `SKANVIL_HUB_ADMIN_TOKEN` is unset, the dashboard runs in open local development mode and displays a reminder banner in the UI. Always set both `SKANVIL_HUB_ADMIN_TOKEN` and `SKANVIL_HUB_API_KEYS` before exposing `skanvil-hub` on a shared team network.

---

## Connecting the `skanvil` CLI

### 1. Library configuration (`.skanvilrc.json`)

```json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "https://skanvil-hub.internal",
    "timeoutMs": 1500
  }
}
```

### 2. Environment variables

Environment variables override `.skanvilrc.json` and avoid committing secrets:

| Variable                    | Description                                                                |
| --------------------------- | -------------------------------------------------------------------------- |
| `SKANVIL_TELEMETRY_URL`     | Base URL of `skanvil-hub` (overrides `telemetry.endpoint`).                |
| `SKANVIL_TELEMETRY_KEY`     | Bearer API key sent as `Authorization: Bearer <key>` on `POST /v1/events`. |
| `SKANVIL_TELEMETRY_ENABLED` | Set to `1`/`true` or `0`/`false` to override `telemetry.enabled`.          |
| `SKANVIL_TELEMETRY_QUEUE`   | Custom path for the offline retry JSONL queue.                             |
| `DO_NOT_TRACK`              | Set `DO_NOT_TRACK=1` (or `SKANVIL_NO_TELEMETRY=1`) to disable all sends.   |

### 3. CI library snapshots

Run `skanvil telemetry snapshot` in CI on pushes to `main`:

```yaml
- name: Publish skill library snapshot
  if: github.ref == 'refs/heads/main'
  env:
    SKANVIL_TELEMETRY_URL: ${{ vars.SKANVIL_HUB_URL }}
    SKANVIL_TELEMETRY_KEY: ${{ secrets.SKANVIL_HUB_INGEST_KEY }}
  run: npx skanvil telemetry snapshot --no-queue
```

### 4. Coding agent usage hooks

Install non-blocking hooks that listen across **7 supported agents** (`claude`, `cursor`, `gemini`, `copilot`, `windsurf`, `codex`, `opencode`) when a skill's `SKILL.md` is read or invoked, plus session-end hooks (`Stop`, `SessionEnd`, `post_cascade_response`) to compute accurate `durationMs` and tool call counters:

```bash
npx skanvil telemetry install-hooks --target claude,cursor,gemini
# Or install all 7 agents globally into your home config folders:
npx skanvil telemetry install-hooks --global
```

- Hooks run `npx --no-install skanvil telemetry hook --agent <agent>` and read JSON on stdin.
- When `session_id` / `conversation_id` is supplied, tool invocations are buffered in `~/.skanvil/sessions/` until the agent's session-end hook fires, emitting `durationMs`, `toolCalls`, and `failedToolCalls`. Stateless payloads without `session_id` emit immediately.
- If `skills/` appears outside an installed skill file, or no matching skill is found, nothing is emitted.
- Hooks always exit `0` so agents are never blocked even if the hub is unreachable; failed deliveries append to `~/.skanvil/telemetry-queue.jsonl`, which flushes automatically on `skanvil sync` and `skanvil telemetry snapshot` (or manually via `npx skanvil telemetry push`).

### 5. Transcript ingestion, usage audit, manual events & feedback

- **Backfill local session transcripts**: `npx skanvil telemetry ingest-transcripts <path> --agent claude` scans JSONL/JSON agent transcripts to recover historical `skill.invoked` events idempotently (`--dry-run` to preview, `--no-queue` to fail fast instead of queueing).
- **Zombie / usage audit**: `npx skanvil telemetry audit --days 30 --strict-zombies` queries `/api/dashboard/skills` on the hub to surface high-adoption vs. never-invoked skills; combine with `skanvil diff --from-hub` to see usage and failure stats next to Stage-1 budget deltas in PR diffs.
- **Manual / workflow usage**: `npx skanvil telemetry emit --skill front-api-review --agent claude --outcome success --duration-ms 1200`
- **Sync adoption (`sync.applied`)**: When `telemetry.enabled` and `telemetry.endpoint` (or `SKANVIL_TELEMETRY_URL`) are configured, `skanvil sync` emits a non-fatal `sync.applied` event automatically (skipped on `--dry-run` or opt-out).
- **Friction reports (`skill.feedback`)**: `npx skanvil feedback push` uploads `.skanvil-feedback.jsonl` with deterministic `fb_<hash>` event IDs so repeated pushes never duplicate server rows.
- **Native eval runs (`skill.invoked`)**: `npx skanvil eval run --emit-telemetry` publishes per-case `skill.invoked` events (`agent: "eval:<provider>"`) with outcome and duration directly to the hub.

---

## Hub operations: PostgreSQL, webhooks, retention, triage & seeding

- **Database backends**: Set `DATABASE_URL` (or `SKANVIL_HUB_DATABASE_URL`) to use PostgreSQL (`pg`) via `PostgresTelemetryStore`; omit it to run zero-dependency embedded SQLite (`node:sqlite`, `SKANVIL_HUB_DB_PATH`).
- **Webhook alerts**: Configure `SKANVIL_HUB_WEBHOOK_URL` (Slack, Discord, or generic JSON webhook) along with `SKANVIL_HUB_ALERT_MAX_STAGE1_TOKENS`, `SKANVIL_HUB_ALERT_MIN_EVAL_PASS_RATE`, `SKANVIL_HUB_ALERT_ON_VALIDATION_ERRORS` (`true` by default), and `SKANVIL_HUB_ALERT_ON_DEPRECATED_SYNC` (`true` by default).
- **Automated retention pruning**: Set `SKANVIL_HUB_RETENTION_DAYS` (`1`–`3650`) to prune old events and superseded snapshots automatically on startup, daily on a background timer, or on demand via `POST /api/dashboard/retention/prune`.
- **Dashboard drill-down, triage & exports**: Click any skill row in **Skills & Budgets** to inspect trend history, cross-agent invocation breakdowns, and related friction reports; triage reports between `open`, `triaged`, and `resolved` (`PATCH /api/dashboard/feedback/triage`) or copy ready-to-paste GitHub Issue Markdown; export filtered CSV/JSON event logs from the header toolbar (`GET /api/dashboard/export?format=csv|json`).
- **Demo seeding & GHCR images**: Run `npm --prefix hub run seed` to populate realistic 14-day telemetry for local demos, or pull multi-arch container images from `ghcr.io/jmbargueno/skanvil-hub:latest`.

---

## Privacy & safety guarantees

1. **Opt-in by default**: `telemetry.enabled` defaults to `false`.
2. **Never transmits prompts or skill contents**: only skill names, versions, counts, token estimates, outcomes, timings, and `.skanvil-feedback.jsonl` diagnostic summaries.
3. **Hashed workspace & session IDs**: `projectHash` and `sessionHash` are truncated one-way `sha256:<16 hex>` digests (`hashIdentifier()`).
4. **Automatic redaction (`redactTelemetryText`)**: credential patterns (private keys, API keys, Bearer headers) and machine home folder paths (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) are scrubbed before `skill.feedback` events leave the machine.
5. **Respects standard opt-out signals**: `DO_NOT_TRACK=1` or `SKANVIL_NO_TELEMETRY=1` immediately bypasses both sending and queueing.

---

## Ingestion API (`schemaVersion: 1`)

`POST /v1/events` accepts `{ "events": TelemetryEvent[] }` (1–500 events, max 2 MB JSON payload) and responds with:

```json
{ "ok": true, "accepted": 3, "duplicates": 1 }
```

Supported event types: `library.snapshot`, `sync.applied`, `skill.invoked`, and `skill.feedback`. Each carries `{ schemaVersion: 1, eventId, timestamp, library, skanvilVersion }`. Duplicate `eventId` submissions are ignored idempotently via `PRIMARY KEY (event_id)`.

The storage layer inside `hub/src/server/store/` implements an async `TelemetryStore` interface (`types.ts`) with both embedded SQLite (`sqlite.ts`) and PostgreSQL (`postgres.ts`, selected automatically via `createTelemetryStore()` when `DATABASE_URL` or `SKANVIL_HUB_DATABASE_URL` is configured) behind identical HTTP endpoints and React UI.
