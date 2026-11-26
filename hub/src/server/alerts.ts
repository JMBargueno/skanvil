import type { TelemetryEvent } from "../shared/schema.js";
import type { HubConfig } from "./config.js";
import type { TelemetryStore } from "./store/types.js";

export interface AlertDispatcherOptions {
  webhookUrl?: string;
  maxStage1Tokens?: number;
  minEvalPassRate?: number;
  onValidationErrors?: boolean;
  onDeprecatedSync?: boolean;
  fetchFn?: typeof fetch;
}

export class AlertDispatcher {
  private readonly webhookUrl?: string;
  private readonly maxStage1Tokens?: number;
  private readonly minEvalPassRate?: number;
  private readonly onValidationErrors: boolean;
  private readonly onDeprecatedSync: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(options: AlertDispatcherOptions = {}) {
    this.webhookUrl = options.webhookUrl;
    this.maxStage1Tokens = options.maxStage1Tokens;
    this.minEvalPassRate = options.minEvalPassRate;
    this.onValidationErrors = options.onValidationErrors ?? true;
    this.onDeprecatedSync = options.onDeprecatedSync ?? true;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  static fromConfig(config: HubConfig): AlertDispatcher {
    return new AlertDispatcher({
      webhookUrl: config.webhookUrl,
      maxStage1Tokens: config.alertMaxStage1Tokens,
      minEvalPassRate: config.alertMinEvalPassRate,
      onValidationErrors: config.alertOnValidationErrors,
      onDeprecatedSync: config.alertOnDeprecatedSync
    });
  }

  async evaluateEvents(store: TelemetryStore, events: readonly TelemetryEvent[]): Promise<string[]> {
    const alerts: string[] = [];

    for (const event of events) {
      if (event.type === "library.snapshot") {
        if (this.onValidationErrors && event.validation.errors > 0) {
          alerts.push(`${event.library}: ${event.validation.errors} validation error(s) detected in snapshot`);
        }
        if (this.maxStage1Tokens !== undefined && event.totals.alwaysLoadedTokens > this.maxStage1Tokens) {
          alerts.push(
            `${event.library}: Stage-1 always-loaded tokens (${event.totals.alwaysLoadedTokens}) exceed limit (${this.maxStage1Tokens})`
          );
        }
        if (this.minEvalPassRate !== undefined && event.evals.totalTriggers > 0) {
          const rate = event.evals.passedTriggers / event.evals.totalTriggers;
          if (rate < this.minEvalPassRate) {
            alerts.push(
              `${event.library}: eval trigger pass rate dropped to ${Math.round(rate * 100)}% (threshold ${Math.round(this.minEvalPassRate * 100)}%)`
            );
          }
        }
      } else if (event.type === "sync.applied" && this.onDeprecatedSync) {
        const adoption = await store.getSyncAdoption({ library: event.library, days: 30 });
        for (const item of adoption.deprecatedInstalled) {
          if (item.projectHash === event.projectHash && item.target === event.target) {
            const replacement = item.replacedBy ? ` (replaced by ${item.replacedBy})` : "";
            alerts.push(
              `${event.library}: deprecated skill '${item.skill}' synced in ${item.projectHash} [${item.target}]${replacement}`
            );
          }
        }
      }
    }

    return alerts;
  }

  async notifyBatch(store: TelemetryStore, events: readonly TelemetryEvent[]): Promise<string[]> {
    if (events.length === 0) return [];
    const alerts = await this.evaluateEvents(store, events);
    if (alerts.length === 0 || !this.webhookUrl) return alerts;

    const text = `[skanvil-hub] ${alerts.length} alert(s):\n${alerts.map((item) => `- ${item}`).join("\n")}`;
    try {
      await this.fetchFn(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          content: text,
          alerts,
          timestamp: new Date().toISOString()
        }),
        signal: AbortSignal.timeout(3000)
      });
    } catch {
      // Alerts must never break telemetry ingestion.
    }
    return alerts;
  }
}
