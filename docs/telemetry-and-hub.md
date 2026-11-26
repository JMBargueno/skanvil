# Telemetry & Self-Hosted Hub (`skanvil-hub`)

skanvil includes an **opt-in**, privacy-preserving telemetry system paired with **`skanvil-hub`**, a self-hosted web application and REST ingestion API under [`hub/`](../hub/). Nothing is sent anywhere unless you explicitly configure an endpoint and opt in.

## What you can measure

- **Catalog & context budgets (`library.snapshot`)**: historical Stage-1 (`alwaysLoadedTokens`), Stage-2 (`bodyTokens`), and Stage-3 (`resourceTokens`) sizes, validation counts, eval trigger pass rates, and per-skill metadata (`owner`, `status`, `replacedBy`).
- **Real usage & performance (`skill.invoked`)**: invocations by skill, coding agent (`claude`, `cursor`, `gemini`, CLI), model, duration, tool calls, error rates, and **Zombie Skill** detection (non-deprecated catalog or synced skills with zero invocations in the selected time window).
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

| Variable                    | Default                     | Description                                                                                      |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| `PORT`                      | `4318`                      | HTTP listener port.                                                                              |
| `HOST`                      | `0.0.0.0`                   | Bind interface.                                                                                  |
| `SKANVIL_HUB_DB_PATH`       | `./data/skanvil-hub.sqlite` | SQLite file path (created automatically; WAL mode enabled).                                      |
| `SKANVIL_HUB_API_KEYS`      | `""` (open)                 | Comma-separated Bearer API keys accepted by `POST /v1/events`.                                   |
| `SKANVIL_HUB_ADMIN_TOKEN`   | `""` (open local dev mode)  | Protects `/api/dashboard/*` and the UI via an `HttpOnly` HMAC session cookie or `Bearer` header. |
| `SKANVIL_HUB_COOKIE_SECURE` | `false`                     | Set to `true` when serving `skanvil-hub` behind an HTTPS reverse proxy.                          |

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

Install non-blocking hooks that listen when Claude Code, Cursor, or Gemini CLI reads a skill's `SKILL.md` or invokes a `Skill` tool:

```bash
npx skanvil telemetry install-hooks --target claude,cursor,gemini
# Or globally in your home agent settings:
npx skanvil telemetry install-hooks --global --target claude,cursor,gemini
```

- Hooks run `npx --no-install skanvil telemetry hook --agent <agent>` and read JSON on stdin.
- If `skills/` appears outside an installed skill file, or no matching skill is found, nothing is emitted.
- Hooks always exit `0` so agents are never blocked even if the hub is unreachable; failed deliveries append to `~/.skanvil/telemetry-queue.jsonl` and can be retried later with `npx skanvil telemetry push`.

### 5. Manual events, sync adoption & feedback

- **Manual / workflow usage**: `npx skanvil telemetry emit --skill front-api-review --agent claude --outcome success --duration-ms 1200`
- **Sync adoption (`sync.applied`)**: When `telemetry.enabled` and `telemetry.endpoint` (or `SKANVIL_TELEMETRY_URL`) are configured, `skanvil sync` emits a non-fatal `sync.applied` event automatically (skipped on `--dry-run` or opt-out).
- **Friction reports (`skill.feedback`)**: `npx skanvil feedback push` uploads `.skanvil-feedback.jsonl` with deterministic `fb_<hash>` event IDs so repeated pushes never duplicate server rows.

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

The storage layer inside `hub/src/server/store/sqlite.ts` implements an async `TelemetryStore` interface (`hub/src/server/store/types.ts`), making it straightforward to add a PostgreSQL adapter later without changing HTTP endpoints or the React dashboard.
