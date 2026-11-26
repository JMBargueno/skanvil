import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHubApp } from "../src/server/app.js";
import { loadHubConfig, type HubConfig } from "../src/server/config.js";
import { SqliteTelemetryStore } from "../src/server/store/sqlite.js";
import type {
  AdoptionResponse,
  BudgetsResponse,
  FeedbackResponse,
  LibrariesResponse,
  OverviewResponse,
  SkillsAnalyticsResponse,
  TelemetryEvent
} from "../src/shared/schema.js";

function makeConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    port: 4318,
    host: "127.0.0.1",
    dbPath: ":memory:",
    apiKeys: [],
    cookieSecure: false,
    staticDir: path.resolve(process.cwd(), "dist/client"),
    ...overrides
  };
}

function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

describe("skanvil-hub", () => {
  const stores: SqliteTelemetryStore[] = [];

  async function setup(configOverrides: Partial<HubConfig> = {}, dbPath = ":memory:") {
    const store = new SqliteTelemetryStore(dbPath);
    await store.init();
    stores.push(store);
    const config = makeConfig({ dbPath, ...configOverrides });
    const app = createHubApp(store, config);
    return { store, app, config };
  }

  afterEach(async () => {
    while (stores.length > 0) {
      await stores.pop()!.close();
    }
  });

  it("exposes healthcheck and security headers", async () => {
    const { app } = await setup();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "healthy" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("enforces Bearer API keys on POST /v1/events when configured", async () => {
    const { app } = await setup({ apiKeys: ["key-alpha", "key-beta"] });
    const sampleEvent: TelemetryEvent = {
      schemaVersion: 1,
      eventId: "ev-auth-1",
      timestamp: new Date().toISOString(),
      type: "skill.invoked",
      library: "@acme/skills",
      skanvilVersion: "1.1.1",
      skill: "front-forms",
      agent: "claude",
      outcome: "success"
    };

    const unauth = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [sampleEvent] })
    });
    expect(unauth.status).toBe(401);

    const wrong = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
      body: JSON.stringify({ events: [sampleEvent] })
    });
    expect(wrong.status).toBe(401);

    const ok = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-beta" },
      body: JSON.stringify({ events: [sampleEvent] })
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, accepted: 1, duplicates: 0 });
  });

  it("rejects invalid batches (400) and oversized payloads (413)", async () => {
    const { app } = await setup();

    const invalidJson = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    expect(invalidJson.status).toBe(400);

    const invalidSchema = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ type: "unknown" }] })
    });
    expect(invalidSchema.status).toBe(400);

    const oversized = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(2 * 1024 * 1024 + 32)
    });
    expect(oversized.status).toBe(413);
  });

  it("deduplicates repeated eventIds idempotently", async () => {
    const { app } = await setup();
    const ev: TelemetryEvent = {
      schemaVersion: 1,
      eventId: "dup-id-1",
      timestamp: new Date().toISOString(),
      type: "skill.invoked",
      library: "@acme/skills",
      skanvilVersion: "1.1.1",
      skill: "back-db",
      agent: "cursor",
      outcome: "success"
    };

    const first = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [ev] })
    });
    expect(await first.json()).toEqual({ ok: true, accepted: 1, duplicates: 0 });

    const second = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [ev] })
    });
    expect(await second.json()).toEqual({ ok: true, accepted: 0, duplicates: 1 });

    const overview = (await (await app.request("/api/dashboard/overview")).json()) as OverviewResponse;
    expect(overview.totalInvocations).toBe(1);
  });

  it("protects dashboard API with HttpOnly session cookie and Bearer admin token", async () => {
    const { app } = await setup({ apiKeys: ["ingest-1"], adminToken: "super-admin-token" });

    const statusBefore = await (await app.request("/api/auth/status")).json();
    expect(statusBefore).toEqual({ authRequired: true, authenticated: false, ingestionProtected: true });

    expect((await app.request("/api/dashboard/overview")).status).toBe(401);

    const badLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" })
    });
    expect(badLogin.status).toBe(401);

    const goodLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "super-admin-token" })
    });
    expect(goodLogin.status).toBe(200);
    const setCookie = goodLogin.headers.get("set-cookie");
    expect(setCookie).toContain("skanvil_hub_session=");
    expect(setCookie).toContain("HttpOnly");
    const cookiePair = setCookie!.split(";")[0];

    const withCookie = await app.request("/api/dashboard/overview", {
      headers: { cookie: cookiePair }
    });
    expect(withCookie.status).toBe(200);

    const withBearer = await app.request("/api/dashboard/libraries", {
      headers: { authorization: "Bearer super-admin-token" }
    });
    expect(withBearer.status).toBe(200);

    const logoutRes = await app.request("/api/auth/logout", { method: "POST" });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("computes zombies, budgets, feedback grouping, and deprecated-still-installed alerts", async () => {
    const { app } = await setup();

    const batch: TelemetryEvent[] = [
      {
        schemaVersion: 1,
        eventId: "snap-old",
        timestamp: isoDaysAgo(5),
        type: "library.snapshot",
        library: "@acme/skills",
        skanvilVersion: "1.1.1",
        gitSha: "111aaaa",
        gitBranch: "main",
        totals: {
          skills: 2,
          alwaysLoadedTokens: 180,
          bodyTokens: 700,
          bodyLines: 140,
          resourceFiles: 1,
          resourceTokens: 120,
          unreferencedFiles: 0
        },
        validation: { errors: 0, warnings: 1 },
        evals: { totalTriggers: 4, passedTriggers: 3, failedTriggers: 1 },
        skills: [
          {
            name: "front-forms",
            category: "front",
            status: "active",
            owner: "@ui",
            stage1Tokens: 90,
            bodyLines: 70,
            bodyTokens: 350,
            resourceFiles: 1,
            unreferencedFiles: 0,
            evalCases: 1,
            evalTriggers: 4,
            valid: true
          },
          {
            name: "back-zombie",
            category: "back",
            status: "active",
            owner: "@api",
            stage1Tokens: 90,
            bodyLines: 70,
            bodyTokens: 350,
            resourceFiles: 0,
            unreferencedFiles: 0,
            evalCases: 0,
            evalTriggers: 0,
            valid: true
          }
        ]
      },
      {
        schemaVersion: 1,
        eventId: "snap-latest",
        timestamp: isoDaysAgo(1),
        type: "library.snapshot",
        library: "@acme/skills",
        skanvilVersion: "1.1.1",
        gitSha: "222bbbb",
        gitBranch: "main",
        totals: {
          skills: 3,
          alwaysLoadedTokens: 275,
          bodyTokens: 950,
          bodyLines: 190,
          resourceFiles: 1,
          resourceTokens: 120,
          unreferencedFiles: 0
        },
        validation: { errors: 0, warnings: 0 },
        evals: { totalTriggers: 6, passedTriggers: 6, failedTriggers: 0 },
        skills: [
          {
            name: "front-forms",
            category: "front",
            status: "active",
            owner: "@ui",
            stage1Tokens: 95,
            bodyLines: 80,
            bodyTokens: 400,
            resourceFiles: 1,
            unreferencedFiles: 0,
            evalCases: 2,
            evalTriggers: 4,
            valid: true
          },
          {
            name: "back-zombie",
            category: "back",
            status: "active",
            owner: "@api",
            stage1Tokens: 110,
            bodyLines: 65,
            bodyTokens: 310,
            resourceFiles: 0,
            unreferencedFiles: 0,
            evalCases: 0,
            evalTriggers: 2,
            valid: true
          },
          {
            name: "legacy-auth",
            category: "transversal",
            status: "deprecated",
            replacedBy: "front-forms",
            owner: "@sec",
            stage1Tokens: 70,
            bodyLines: 45,
            bodyTokens: 240,
            resourceFiles: 0,
            unreferencedFiles: 0,
            evalCases: 0,
            evalTriggers: 0,
            valid: true
          }
        ]
      },
      {
        schemaVersion: 1,
        eventId: "sync-1",
        timestamp: isoDaysAgo(1),
        type: "sync.applied",
        library: "@acme/skills",
        skanvilVersion: "1.1.1",
        projectHash: "sha256:projclean",
        target: "claude",
        scope: "project",
        mode: "copy",
        added: ["front-forms"],
        updated: [],
        unchanged: [],
        removed: [],
        skipped: [],
        installedSkills: ["front-forms"],
        alwaysLoadedTokens: 95
      },
      {
        schemaVersion: 1,
        eventId: "sync-2",
        timestamp: isoDaysAgo(1),
        type: "sync.applied",
        library: "@acme/skills",
        skanvilVersion: "1.1.1",
        projectHash: "sha256:projstale",
        target: "cursor",
        scope: "project",
        mode: "copy",
        added: ["front-forms", "legacy-auth"],
        updated: [],
        unchanged: [],
        removed: [],
        skipped: [],
        installedSkills: ["front-forms", "legacy-auth"],
        alwaysLoadedTokens: 165
      },
      {
        schemaVersion: 1,
        eventId: "inv-1",
        timestamp: isoDaysAgo(0),
        type: "skill.invoked",
        library: "@acme/skills",
        skanvilVersion: "1.1.1",
        skill: "front-forms",
        agent: "claude",
        model: "claude-sonnet",
        projectHash: "sha256:projclean",
        outcome: "success",
        durationMs: 1000,
        toolCalls: 4,
        source: "hook"
      },
      {
        schemaVersion: 1,
        eventId: "inv-2",
        timestamp: isoDaysAgo(0),
        type: "skill.invoked",
        library: "@acme/skills",
        skanvilVersion: "1.1.1",
        skill: "front-forms",
        agent: "cursor",
        model: "claude-sonnet",
        projectHash: "sha256:projstale",
        outcome: "error",
        durationMs: 2000,
        toolCalls: 6,
        source: "hook"
      },
      {
        schemaVersion: 1,
        eventId: "fb-1",
        timestamp: isoDaysAgo(0),
        type: "skill.feedback",
        library: "@acme/skills",
        skanvilVersion: "1.1.1",
        skill: "front-forms",
        step: "Step 3",
        symptom: "Missing Zod resolver check",
        proposedFix: "Check zod version before generating schema",
        hasSuggestedEvalCase: true,
        projectHash: "sha256:projclean"
      },
      {
        schemaVersion: 1,
        eventId: "fb-2",
        timestamp: isoDaysAgo(0),
        type: "skill.feedback",
        library: "@acme/skills",
        skanvilVersion: "1.1.1",
        skill: "front-forms",
        step: "Step 3",
        symptom: "Missing Zod resolver check",
        hasSuggestedEvalCase: false,
        projectHash: "sha256:projstale"
      }
    ];

    const ingestRes = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: batch })
    });
    expect(ingestRes.status).toBe(200);
    expect(await ingestRes.json()).toEqual({ ok: true, accepted: batch.length, duplicates: 0 });

    const libs = (await (await app.request("/api/dashboard/libraries")).json()) as LibrariesResponse;
    expect(libs.libraries).toHaveLength(1);
    expect(libs.libraries[0].skillsCount).toBe(3);
    expect(libs.libraries[0].alwaysLoadedTokens).toBe(275);
    expect(libs.libraries[0].evalPassRate).toBe(1);
    expect(libs.libraries[0].syncedProjects).toBe(2);

    const overview = (await (await app.request("/api/dashboard/overview?days=30")).json()) as OverviewResponse;
    expect(overview.totalInvocations).toBe(2);
    expect(overview.successCount).toBe(1);
    expect(overview.errorCount).toBe(1);
    expect(overview.successRate).toBe(0.5);
    expect(overview.activeSkills).toBe(1);
    expect(overview.zombieSkills).toBe(1);
    expect(overview.wastedStage1Tokens).toBe(110);
    expect(overview.alwaysLoadedTokens).toBe(275);
    expect(overview.evalPassRate).toBe(1);
    expect(overview.feedbackCount).toBe(2);
    expect(overview.daily).toHaveLength(30);
    expect(overview.byAgent).toEqual([
      { name: "claude", count: 1 },
      { name: "cursor", count: 1 }
    ]);

    const skills = (await (await app.request("/api/dashboard/skills?days=30")).json()) as SkillsAnalyticsResponse;
    const front = skills.skills.find((s) => s.skill === "front-forms")!;
    const zombie = skills.skills.find((s) => s.skill === "back-zombie")!;
    const deprecated = skills.skills.find((s) => s.skill === "legacy-auth")!;
    expect(front.isZombie).toBe(false);
    expect(front.invocations).toBe(2);
    expect(front.frictionEvents).toBe(2);
    expect(front.avgDurationMs).toBe(1500);
    expect(front.syncedProjects).toBe(2);
    expect(zombie.isZombie).toBe(true);
    expect(zombie.stage1Tokens).toBe(110);
    expect(deprecated.isZombie).toBe(false);
    expect(deprecated.status).toBe("deprecated");

    const budgets = (await (await app.request("/api/dashboard/budgets?days=30")).json()) as BudgetsResponse;
    expect(budgets.snapshots.map((s) => s.gitSha)).toEqual(["111aaaa", "222bbbb"]);
    expect(budgets.snapshots[0].evalPassRate).toBe(0.75);
    expect(budgets.snapshots[1].evalPassRate).toBe(1);

    const feedback = (await (await app.request("/api/dashboard/feedback?days=30")).json()) as FeedbackResponse;
    expect(feedback.totalEvents).toBe(2);
    expect(feedback.groups).toHaveLength(1);
    expect(feedback.groups[0].count).toBe(2);
    expect(feedback.groups[0].suggestedEvalCaseCount).toBe(1);

    const adoption = (await (await app.request("/api/dashboard/adoption")).json()) as AdoptionResponse;
    expect(adoption.totalSyncedProjects).toBe(2);
    expect(adoption.deprecatedInstalled).toHaveLength(1);
    expect(adoption.deprecatedInstalled[0]).toMatchObject({
      projectHash: "sha256:projstale",
      target: "cursor",
      skill: "legacy-auth",
      replacedBy: "front-forms"
    });
  });

  it("persists data on disk SQLite and parses hub config defaults", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skanvil-hub-test-"));
    try {
      const dbPath = path.join(tmpDir, "nested", "hub.sqlite");
      const store1 = new SqliteTelemetryStore(dbPath);
      await store1.init();
      await store1.ingestEvents([
        {
          schemaVersion: 1,
          eventId: "disk-1",
          timestamp: new Date().toISOString(),
          type: "skill.invoked",
          library: "disk-lib",
          skanvilVersion: "1.1.1",
          skill: "transversal-check",
          agent: "gemini",
          outcome: "success"
        }
      ]);
      await store1.close();

      const store2 = new SqliteTelemetryStore(dbPath);
      await store2.init();
      try {
        const overview = await store2.getOverview({ days: 7 });
        expect(overview.totalInvocations).toBe(1);
      } finally {
        await store2.close();
      }

      const cfg = loadHubConfig({
        PORT: "5555",
        SKANVIL_HUB_API_KEYS: " k1 , k2 ",
        SKANVIL_HUB_ADMIN_TOKEN: "secret",
        SKANVIL_HUB_COOKIE_SECURE: "true"
      });
      expect(cfg.port).toBe(5555);
      expect(cfg.apiKeys).toEqual(["k1", "k2"]);
      expect(cfg.adminToken).toBe("secret");
      expect(cfg.cookieSecure).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
