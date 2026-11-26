import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";

import { TelemetryBatchSchema } from "../shared/schema.js";
import {
  buildSessionSetCookie,
  constantTimeEqual,
  createSessionCookieValue,
  isAdminAuthorized,
  verifyApiKey
} from "./auth.js";
import type { HubConfig } from "./config.js";
import type { AnalyticsQuery, TelemetryStore } from "./store/types.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

function parseAnalyticsQuery(c: Context): AnalyticsQuery {
  const rawLibrary = c.req.query("library")?.trim();
  const library = rawLibrary && rawLibrary !== "all" ? rawLibrary : undefined;
  const rawDays = Number(c.req.query("days") ?? "30");
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(365, Math.round(rawDays))) : 30;
  return { ...(library ? { library } : {}), days };
}

function tryReadStaticFile(filePath: string): { bytes: Uint8Array; mime: string } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const ext = path.extname(filePath).toLowerCase();
    return {
      bytes: new Uint8Array(fs.readFileSync(filePath)),
      mime: MIME_TYPES[ext] ?? "application/octet-stream"
    };
  } catch {
    return null;
  }
}

export function createHubApp(store: TelemetryStore, config: HubConfig): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("x-frame-options", "DENY");
    c.res.headers.set("referrer-policy", "no-referrer");
  });

  app.get("/health", (c) => c.json({ ok: true, status: "healthy" }));

  app.post("/v1/events", async (c) => {
    if (!verifyApiKey(c.req.header("authorization"), config.apiKeys)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return c.json({ error: "Payload too large" }, 413);
    }

    const rawText = await c.req.text();
    if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) {
      return c.json({ error: "Payload too large" }, 413);
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawText);
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const parsed = TelemetryBatchSchema.safeParse(rawJson);
    if (!parsed.success) {
      return c.json({ error: "Invalid telemetry batch", details: parsed.error.issues }, 400);
    }

    const result = await store.ingestEvents(parsed.data.events);
    return c.json({ ok: true, accepted: result.accepted, duplicates: result.duplicates });
  });

  app.get("/api/auth/status", (c) => {
    const authRequired = Boolean(config.adminToken);
    const authenticated = isAdminAuthorized(c.req.header("cookie"), c.req.header("authorization"), config.adminToken);
    return c.json({
      authRequired,
      authenticated,
      ingestionProtected: config.apiKeys.length > 0
    });
  });

  app.post("/api/auth/login", async (c) => {
    if (!config.adminToken) {
      return c.json({ ok: true });
    }
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || !constantTimeEqual(token, config.adminToken)) {
      return c.json({ error: "Invalid admin token" }, 401);
    }
    const sessionValue = createSessionCookieValue(config.adminToken);
    c.header("set-cookie", buildSessionSetCookie(sessionValue, config.cookieSecure, false));
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    c.header("set-cookie", buildSessionSetCookie("", config.cookieSecure, true));
    return c.json({ ok: true });
  });

  app.use("/api/dashboard/*", async (c, next) => {
    if (!isAdminAuthorized(c.req.header("cookie"), c.req.header("authorization"), config.adminToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/dashboard/libraries", async (c) => {
    return c.json(await store.listLibraries());
  });

  app.get("/api/dashboard/overview", async (c) => {
    return c.json(await store.getOverview(parseAnalyticsQuery(c)));
  });

  app.get("/api/dashboard/skills", async (c) => {
    return c.json(await store.getSkillsAnalytics(parseAnalyticsQuery(c)));
  });

  app.get("/api/dashboard/budgets", async (c) => {
    return c.json(await store.getBudgetsHistory(parseAnalyticsQuery(c)));
  });

  app.get("/api/dashboard/feedback", async (c) => {
    return c.json(await store.getFeedbackSummary(parseAnalyticsQuery(c)));
  });

  app.get("/api/dashboard/adoption", async (c) => {
    return c.json(await store.getSyncAdoption(parseAnalyticsQuery(c)));
  });

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  app.all("/v1/*", (c) => c.json({ error: "Not found" }, 404));

  app.get("*", (c) => {
    const rootDir = path.resolve(config.staticDir);
    let reqPath: string;
    try {
      reqPath = decodeURIComponent(c.req.path);
    } catch {
      return c.json({ error: "Bad request" }, 400);
    }
    const rel = reqPath.replace(/^\/+/, "");
    const resolved = path.resolve(rootDir, rel);
    if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const fileAsset = rel ? tryReadStaticFile(resolved) : null;
    if (fileAsset) {
      const headers = new Headers({
        "content-type": fileAsset.mime,
        "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache"
      });
      return new Response(Buffer.from(fileAsset.bytes), { status: 200, headers });
    }

    if (rel && path.extname(rel)) {
      return c.json({ error: "Asset not found" }, 404);
    }

    const indexAsset = tryReadStaticFile(path.join(rootDir, "index.html"));
    if (indexAsset) {
      return new Response(Buffer.from(indexAsset.bytes), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }
      });
    }

    return c.json({ error: "Dashboard client not built. Run npm run build:client." }, 404);
  });

  return app;
}
