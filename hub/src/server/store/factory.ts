import type { HubConfig } from "../config.js";
import { PostgresTelemetryStore } from "./postgres.js";
import { SqliteTelemetryStore } from "./sqlite.js";
import type { TelemetryStore } from "./types.js";

export function createTelemetryStore(config: HubConfig): TelemetryStore {
  if (config.databaseUrl && /^postgres(?:ql)?:\/\//i.test(config.databaseUrl)) {
    return new PostgresTelemetryStore(config.databaseUrl);
  }
  return new SqliteTelemetryStore(config.dbPath);
}
