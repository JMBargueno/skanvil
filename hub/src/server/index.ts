import { serve } from "@hono/node-server";

import { createHubApp } from "./app.js";
import { loadHubConfig } from "./config.js";
import { createTelemetryStore } from "./store/factory.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadHubConfig();
  const store = createTelemetryStore(config);
  await store.init();

  let retentionTimer: NodeJS.Timeout | null = null;
  if (config.retentionDays !== undefined) {
    const runPrune = async () => {
      try {
        const res = await store.pruneOldData(config.retentionDays!);
        if (res.deletedEvents > 0 || res.deletedSnapshots > 0) {
          console.log(
            `Retention prune (${config.retentionDays}d): removed ${res.deletedEvents} event(s), ${res.deletedSnapshots} snapshot(s).`
          );
        }
      } catch (error) {
        console.error("Retention prune failed:", error);
      }
    };
    await runPrune();
    retentionTimer = setInterval(() => void runPrune(), DAY_MS);
    retentionTimer.unref();
  }

  const app = createHubApp(store, config);
  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port
  });

  const displayHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const authSummary = config.adminToken ? "admin-token enabled" : "open local dev mode";
  const ingestSummary = config.apiKeys.length > 0 ? `${config.apiKeys.length} API key(s)` : "open ingestion";
  const storageSummary = config.databaseUrl ? "PostgreSQL" : `SQLite (${config.dbPath})`;
  console.log(
    `skanvil-hub listening on http://${displayHost}:${config.port} (store: ${storageSummary}, ${authSummary}, ${ingestSummary})`
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}, shutting down skanvil-hub...`);
    if (retentionTimer) clearInterval(retentionTimer);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start skanvil-hub:", error);
  process.exit(1);
});
