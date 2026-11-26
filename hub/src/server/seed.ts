import type { TelemetryEvent } from "../shared/schema.js";
import { loadHubConfig } from "./config.js";
import { createTelemetryStore } from "./store/factory.js";

function isoHoursAgo(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
}

export function buildDemoEvents(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];

  events.push(
    {
      schemaVersion: 1,
      eventId: "demo-snap-acme-1",
      timestamp: isoHoursAgo(14 * 24),
      type: "library.snapshot",
      library: "@acme/skills",
      skanvilVersion: "1.1.1",
      gitSha: "a12bc34",
      gitBranch: "main",
      totals: {
        skills: 4,
        alwaysLoadedTokens: 430,
        bodyTokens: 2100,
        bodyLines: 410,
        resourceFiles: 4,
        resourceTokens: 900,
        unreferencedFiles: 0
      },
      validation: { errors: 0, warnings: 1 },
      evals: { totalTriggers: 10, passedTriggers: 8, failedTriggers: 2 },
      skills: [
        {
          name: "front-react-forms",
          category: "front",
          status: "active",
          owner: "@frontend",
          stage1Tokens: 110,
          bodyLines: 120,
          bodyTokens: 600,
          resourceFiles: 2,
          unreferencedFiles: 0,
          evalCases: 3,
          evalTriggers: 4,
          valid: true
        },
        {
          name: "back-db-migrations",
          category: "back",
          status: "active",
          owner: "@platform",
          stage1Tokens: 115,
          bodyLines: 140,
          bodyTokens: 700,
          resourceFiles: 1,
          unreferencedFiles: 0,
          evalCases: 2,
          evalTriggers: 4,
          valid: true
        },
        {
          name: "front-legacy-enzyme",
          category: "front",
          status: "deprecated",
          replacedBy: "front-react-forms",
          owner: "@frontend",
          stage1Tokens: 95,
          bodyLines: 80,
          bodyTokens: 420,
          resourceFiles: 0,
          unreferencedFiles: 0,
          evalCases: 0,
          evalTriggers: 0,
          valid: true
        },
        {
          name: "ops-terraform-lint",
          category: "transversal",
          status: "active",
          owner: "@infra",
          stage1Tokens: 110,
          bodyLines: 70,
          bodyTokens: 380,
          resourceFiles: 1,
          unreferencedFiles: 0,
          evalCases: 1,
          evalTriggers: 2,
          valid: true
        }
      ]
    },
    {
      schemaVersion: 1,
      eventId: "demo-snap-acme-2",
      timestamp: isoHoursAgo(12),
      type: "library.snapshot",
      library: "@acme/skills",
      skanvilVersion: "1.1.1",
      gitSha: "f98de01",
      gitBranch: "main",
      totals: {
        skills: 5,
        alwaysLoadedTokens: 545,
        bodyTokens: 2520,
        bodyLines: 495,
        resourceFiles: 5,
        resourceTokens: 1150,
        unreferencedFiles: 0
      },
      validation: { errors: 0, warnings: 0 },
      evals: { totalTriggers: 12, passedTriggers: 11, failedTriggers: 1 },
      skills: [
        {
          name: "front-react-forms",
          category: "front",
          status: "active",
          owner: "@frontend",
          stage1Tokens: 105,
          bodyLines: 118,
          bodyTokens: 590,
          resourceFiles: 2,
          unreferencedFiles: 0,
          evalCases: 4,
          evalTriggers: 4,
          valid: true
        },
        {
          name: "back-db-migrations",
          category: "back",
          status: "active",
          owner: "@platform",
          stage1Tokens: 115,
          bodyLines: 140,
          bodyTokens: 700,
          resourceFiles: 1,
          unreferencedFiles: 0,
          evalCases: 3,
          evalTriggers: 4,
          valid: true
        },
        {
          name: "release-checklist",
          category: "transversal",
          status: "active",
          owner: "@release-eng",
          stage1Tokens: 120,
          bodyLines: 87,
          bodyTokens: 430,
          resourceFiles: 1,
          unreferencedFiles: 0,
          evalCases: 2,
          evalTriggers: 2,
          valid: true
        },
        {
          name: "front-legacy-enzyme",
          category: "front",
          status: "deprecated",
          replacedBy: "front-react-forms",
          owner: "@frontend",
          stage1Tokens: 95,
          bodyLines: 80,
          bodyTokens: 420,
          resourceFiles: 0,
          unreferencedFiles: 0,
          evalCases: 0,
          evalTriggers: 0,
          valid: true
        },
        {
          name: "ops-terraform-lint",
          category: "transversal",
          status: "active",
          owner: "@infra",
          stage1Tokens: 110,
          bodyLines: 70,
          bodyTokens: 380,
          resourceFiles: 1,
          unreferencedFiles: 0,
          evalCases: 1,
          evalTriggers: 2,
          valid: true
        }
      ]
    },
    {
      schemaVersion: 1,
      eventId: "demo-sync-1",
      timestamp: isoHoursAgo(18),
      type: "sync.applied",
      library: "@acme/skills",
      skanvilVersion: "1.1.1",
      projectHash: "sha256:checkout-web-01",
      target: "claude",
      scope: "project",
      mode: "copy",
      added: ["front-react-forms"],
      updated: ["release-checklist"],
      unchanged: ["back-db-migrations"],
      removed: [],
      skipped: [],
      installedSkills: ["front-react-forms", "back-db-migrations", "release-checklist"],
      alwaysLoadedTokens: 340
    },
    {
      schemaVersion: 1,
      eventId: "demo-sync-2",
      timestamp: isoHoursAgo(48),
      type: "sync.applied",
      library: "@acme/skills",
      skanvilVersion: "1.1.1",
      projectHash: "sha256:legacy-portal-02",
      target: "cursor",
      scope: "project",
      mode: "copy",
      added: ["front-react-forms", "front-legacy-enzyme"],
      updated: [],
      unchanged: [],
      removed: [],
      skipped: [],
      installedSkills: ["front-react-forms", "front-legacy-enzyme"],
      alwaysLoadedTokens: 200
    }
  );

  const agents = ["claude", "cursor", "gemini", "copilot"] as const;
  const models = ["claude-sonnet-4", "gemini-2.5-pro", "gpt-5-codex"] as const;
  const usedSkills = ["front-react-forms", "back-db-migrations", "release-checklist"] as const;

  for (let i = 0; i < 36; i += 1) {
    const skill = usedSkills[i % usedSkills.length];
    const agent = agents[i % agents.length];
    const model = models[i % models.length];
    const outcome = i % 9 === 0 ? "error" : i % 7 === 0 ? "friction" : "success";
    events.push({
      schemaVersion: 1,
      eventId: `demo-inv-${i + 1}`,
      timestamp: isoHoursAgo((i % 12) * 24 + (i % 6)),
      type: "skill.invoked",
      library: "@acme/skills",
      skanvilVersion: "1.1.1",
      skill,
      agent,
      model,
      projectHash: i % 2 === 0 ? "sha256:checkout-web-01" : "sha256:legacy-portal-02",
      outcome,
      durationMs: 900 + (i % 5) * 420,
      toolCalls: 3 + (i % 4),
      failedToolCalls: outcome === "error" ? 1 : 0,
      source: "hook"
    });
  }

  events.push(
    {
      schemaVersion: 1,
      eventId: "demo-fb-1",
      timestamp: isoHoursAgo(36),
      type: "skill.feedback",
      library: "@acme/skills",
      skanvilVersion: "1.1.1",
      skill: "back-db-migrations",
      step: "Step 3",
      symptom: "Missing transactional rollback check for multi-column index alteration",
      proposedFix: "Check Postgres CONCURRENTLY restriction before wrapping DDL inside transaction block.",
      hasSuggestedEvalCase: true,
      agent: "claude",
      model: "claude-sonnet-4",
      projectHash: "sha256:checkout-web-01"
    },
    {
      schemaVersion: 1,
      eventId: "demo-fb-2",
      timestamp: isoHoursAgo(10),
      type: "skill.feedback",
      library: "@acme/skills",
      skanvilVersion: "1.1.1",
      skill: "back-db-migrations",
      step: "Step 3",
      symptom: "Missing transactional rollback check for multi-column index alteration",
      hasSuggestedEvalCase: false,
      agent: "cursor",
      projectHash: "sha256:legacy-portal-02"
    },
    {
      schemaVersion: 1,
      eventId: "demo-fb-3",
      timestamp: isoHoursAgo(5),
      type: "skill.feedback",
      library: "@acme/skills",
      skanvilVersion: "1.1.1",
      skill: "front-react-forms",
      step: "Step 2",
      symptom: "Form validation example uses outdated zod error map field",
      proposedFix: "Switch custom message snippet to the Zod v4 `error` property.",
      hasSuggestedEvalCase: true,
      agent: "gemini",
      model: "gemini-2.5-pro"
    }
  );

  return events;
}

async function run(): Promise<void> {
  const events = buildDemoEvents();
  const targetUrl = process.env.SKANVIL_HUB_URL?.trim()?.replace(/\/+$/, "");

  if (targetUrl) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const apiKey = process.env.SKANVIL_HUB_API_KEY?.trim() || process.env.SKANVIL_TELEMETRY_KEY?.trim();
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const res = await fetch(`${targetUrl}/v1/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ events })
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    console.log(`Seeded ${events.length} demo events to ${targetUrl}:`, await res.json());
    return;
  }

  const config = loadHubConfig();
  const store = createTelemetryStore(config);
  await store.init();
  try {
    const res = await store.ingestEvents(events);
    console.log(`Seeded ${res.accepted} demo event(s) (${res.duplicates} duplicate(s)) into store.`);
  } finally {
    await store.close();
  }
}

const isEntrypoint =
  process.argv[1]?.replace(/\\/g, "/").endsWith("/seed.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("/seed.js");
if (isEntrypoint) {
  run().catch((err) => {
    console.error("Failed to seed demo telemetry:", err);
    process.exit(1);
  });
}
