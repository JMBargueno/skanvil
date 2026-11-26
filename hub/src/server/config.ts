import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface HubConfig {
  port: number;
  host: string;
  dbPath: string;
  apiKeys: string[];
  adminToken?: string;
  cookieSecure: boolean;
  staticDir: string;
}

function resolveDefaultStaticDir(): string {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const distSibling = path.resolve(dirname, "../client");
  if (fs.existsSync(path.join(distSibling, "index.html"))) {
    return distSibling;
  }
  return path.resolve(dirname, "../../dist/client");
}

export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const parsedPort = Number(env.PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 4318;
  const host = env.HOST?.trim() || "0.0.0.0";
  const dbPath = env.SKANVIL_HUB_DB_PATH?.trim() || path.resolve(process.cwd(), "data/skanvil-hub.sqlite");
  const apiKeys = (env.SKANVIL_HUB_API_KEYS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const adminToken = env.SKANVIL_HUB_ADMIN_TOKEN?.trim() || undefined;
  const cookieSecure = env.SKANVIL_HUB_COOKIE_SECURE === "1" || env.SKANVIL_HUB_COOKIE_SECURE?.toLowerCase() === "true";
  const staticDir = env.SKANVIL_HUB_STATIC_DIR?.trim() || resolveDefaultStaticDir();

  return {
    port,
    host,
    dbPath,
    apiKeys,
    adminToken,
    cookieSecure,
    staticDir
  };
}
