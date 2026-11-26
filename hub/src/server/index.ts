import { serve } from "@hono/node-server";

import { createHubApp } from "./app.js";
import { loadHubConfig } from "./config.js";
import { SqliteTelemetryStore } from "./store/sqlite.js";

async function main(): Promise<void> {
  const config = loadHubConfig();
  const store = new SqliteTelemetryStore(config.dbPath);
  await store.init();

  const app = createHubApp(store, config);
  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port
  });

  const displayHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const authSummary = config.adminToken ? "admin-token enabled" : "open local dev mode";
  const ingestSummary = config.apiKeys.length > 0 ? `${config.apiKeys.length} API key(s)` : "open ingestion";
  console.log(
    `skanvil-hub listening on http://${displayHost}:${config.port} (db: ${config.dbPath}, ${authSummary}, ${ingestSummary})`
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}, shutting down skanvil-hub...`);
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
