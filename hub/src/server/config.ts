import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface HubConfig {
  port: number;
  host: string;
  dbPath: string;
  databaseUrl?: string;
  apiKeys: string[];
  adminToken?: string;
  cookieSecure: boolean;
  staticDir: string;
  retentionDays?: number;
  webhookUrl?: string;
  alertMaxStage1Tokens?: number;
  alertMinEvalPassRate?: number;
  alertOnValidationErrors: boolean;
  alertOnDeprecatedSync: boolean;
}

function resolveDefaultStaticDir(): string {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const distSibling = path.resolve(dirname, "../client");
  if (fs.existsSync(path.join(distSibling, "index.html"))) {
    return distSibling;
  }
  return path.resolve(dirname, "../../dist/client");
}

function parseOptionalInt(raw: string | undefined, min: number, max: number): number | undefined {
  if (!raw?.trim()) return undefined;
  const val = Number(raw);
  return Number.isInteger(val) && val >= min && val <= max ? val : undefined;
}

function parseOptionalRate(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const val = Number(raw);
  if (!Number.isFinite(val)) return undefined;
  if (val > 1 && val <= 100) return val / 100;
  return val >= 0 && val <= 1 ? val : undefined;
}

function parseBoolDefaultTrue(raw: string | undefined): boolean {
  if (!raw?.trim()) return true;
  const lower = raw.trim().toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no";
}

export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const parsedPort = Number(env.PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 4318;
  const host = env.HOST?.trim() || "0.0.0.0";
  const dbPath = env.SKANVIL_HUB_DB_PATH?.trim() || path.resolve(process.cwd(), "data/skanvil-hub.sqlite");
  const databaseUrl = env.DATABASE_URL?.trim() || env.SKANVIL_HUB_DATABASE_URL?.trim() || undefined;
  const apiKeys = (env.SKANVIL_HUB_API_KEYS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const adminToken = env.SKANVIL_HUB_ADMIN_TOKEN?.trim() || undefined;
  const cookieSecure = env.SKANVIL_HUB_COOKIE_SECURE === "1" || env.SKANVIL_HUB_COOKIE_SECURE?.toLowerCase() === "true";
  const staticDir = env.SKANVIL_HUB_STATIC_DIR?.trim() || resolveDefaultStaticDir();
  const retentionDays = parseOptionalInt(env.SKANVIL_HUB_RETENTION_DAYS, 1, 3650);
  const webhookUrl = env.SKANVIL_HUB_WEBHOOK_URL?.trim() || undefined;
  const alertMaxStage1Tokens = parseOptionalInt(env.SKANVIL_HUB_ALERT_MAX_STAGE1_TOKENS, 1, 10_000_000);
  const alertMinEvalPassRate = parseOptionalRate(env.SKANVIL_HUB_ALERT_MIN_EVAL_PASS_RATE);
  const alertOnValidationErrors = parseBoolDefaultTrue(env.SKANVIL_HUB_ALERT_ON_VALIDATION_ERRORS);
  const alertOnDeprecatedSync = parseBoolDefaultTrue(env.SKANVIL_HUB_ALERT_ON_DEPRECATED_SYNC);

  return {
    port,
    host,
    dbPath,
    ...(databaseUrl ? { databaseUrl } : {}),
    apiKeys,
    adminToken,
    cookieSecure,
    staticDir,
    ...(retentionDays !== undefined ? { retentionDays } : {}),
    ...(webhookUrl ? { webhookUrl } : {}),
    ...(alertMaxStage1Tokens !== undefined ? { alertMaxStage1Tokens } : {}),
    ...(alertMinEvalPassRate !== undefined ? { alertMinEvalPassRate } : {}),
    alertOnValidationErrors,
    alertOnDeprecatedSync
  };
}
