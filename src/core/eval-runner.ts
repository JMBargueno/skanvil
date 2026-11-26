/**
 * Native pluggable LLM evaluation runner (`skanvil eval run`) for `evals.json` cases,
 * deterministic `mustContain`/`mustNotContain` checks, optional LLM-as-a-judge grading,
 * and with-skill vs without-skill ablation benchmarking.
 *
 * Uses built-in `fetch` with zero external runtime dependencies.
 *
 * @module
 */
import { EVAL_SPLITS, type EvalCase, type EvalSplit } from "./evals.js";
import type { Library } from "./library.js";
import { toLibrary, type LibraryRef } from "./skills.js";

/** Supported model providers for {@link runEvalCases}. */
export const EVAL_PROVIDERS = ["openai", "anthropic", "gemini", "ollama", "mock"] as const;

/** Model provider identifier supported by `skanvil eval run`. */
export type EvalProvider = (typeof EVAL_PROVIDERS)[number];

/** Completion request passed to a built-in provider or custom `complete` hook. */
export interface EvalCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  provider: EvalProvider;
  model: string;
}

/** Custom completion function accepted by {@link EvalRunOptions.complete}. */
export type EvalCompletionFn = (request: EvalCompletionRequest) => Promise<string>;

/** Options of {@link runEvalCases}. */
export interface EvalRunOptions {
  /** Provider (`openai`, `anthropic`, `gemini`, `ollama`, `mock`). Defaults to `SKANVIL_EVAL_PROVIDER` or `"mock"`. */
  provider?: EvalProvider | string;
  /** Model name. Defaults to `SKANVIL_EVAL_MODEL` or provider default. */
  model?: string;
  /** Override base HTTP endpoint (for OpenAI-compatible proxies or local Ollama). */
  baseUrl?: string;
  /** API key override (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `SKANVIL_EVAL_API_KEY`). */
  apiKey?: string;
  /** Only evaluate cases belonging to this skill folder. */
  skill?: string;
  /** Only evaluate cases tagged with `train` or `eval`. */
  split?: EvalSplit | string;
  /** Only run the single case matching this `id`. */
  caseId?: string;
  /** Run an additional without-skill baseline pass to measure instruction lift. */
  ablation?: boolean;
  /** Use the provider as an LLM judge against each case's `expected` criteria. */
  judge?: boolean;
  /** HTTP request timeout in ms. @defaultValue `30000` */
  timeoutMs?: number;
  /** Optional environment map override. */
  env?: NodeJS.ProcessEnv;
  /** Optional completion hook (bypasses network HTTP requests for testing or custom SDKs). */
  complete?: EvalCompletionFn;
}

/** Result of grading a single `evals.json` case. */
export interface EvalCaseRunOutcome {
  skill: string;
  caseId: string;
  split?: EvalSplit;
  prompt: string;
  passed: boolean;
  output: string;
  missingMustContain: string[];
  matchedMustNotContain: string[];
  judgeResult?: { passed: boolean; score: number; reason: string };
  ablation?: { baselinePassed: boolean; lift: number; baselineOutput: string };
  durationMs: number;
}

/** Summary returned by {@link runEvalCases}. */
export interface EvalRunResult {
  provider: EvalProvider;
  model: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number | null;
  ablationSummary?: {
    withSkillPassed: number;
    baselinePassed: number;
    netLift: number;
  };
  cases: EvalCaseRunOutcome[];
}

const DEFAULT_MODELS: Record<EvalProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-20250514",
  gemini: "gemini-2.5-flash",
  ollama: "llama3.2",
  mock: "mock-eval-v1"
};

function resolveProvider(raw: string | undefined, env: NodeJS.ProcessEnv): EvalProvider {
  const candidate = (raw?.trim() || env.SKANVIL_EVAL_PROVIDER?.trim() || "mock").toLowerCase();
  if (!(EVAL_PROVIDERS as readonly string[]).includes(candidate)) {
    throw new Error(`Unsupported eval provider '${candidate}'. Allowed values: ${EVAL_PROVIDERS.join(", ")}.`);
  }
  return candidate as EvalProvider;
}

function resolveApiKey(provider: EvalProvider, explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  const override = explicit?.trim() || env.SKANVIL_EVAL_API_KEY?.trim();
  if (override) return override;
  if (provider === "openai") return env.OPENAI_API_KEY?.trim() || "";
  if (provider === "anthropic") return env.ANTHROPIC_API_KEY?.trim() || "";
  if (provider === "gemini") return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || "";
  return "";
}

function defaultMockComplete(req: EvalCompletionRequest): Promise<string> {
  if (req.systemPrompt.startsWith("You are an impartial evaluator")) {
    return Promise.resolve(
      JSON.stringify({ passed: true, score: 1, reason: "Mock judge verified expected criteria cleanly." })
    );
  }
  if (!req.systemPrompt.trim()) {
    return Promise.resolve(`[mock:${req.model}] Generic baseline response for prompt: ${req.userPrompt}`);
  }
  return Promise.resolve(
    `[mock:${req.model}] Response following skill instructions:\n${req.systemPrompt.slice(0, 1200)}\n\nTask: ${req.userPrompt}`
  );
}

function buildProviderCompleter(
  provider: EvalProvider,
  model: string,
  baseUrl: string | undefined,
  apiKey: string,
  timeoutMs: number
): EvalCompletionFn {
  if (provider === "mock") return defaultMockComplete;

  return async (req) => {
    const signal = AbortSignal.timeout(timeoutMs);

    if (provider === "openai") {
      if (!apiKey) throw new Error("OPENAI_API_KEY or --api-key is required for provider 'openai'.");
      const root = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const res = await fetch(`${root}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
            { role: "user", content: req.userPrompt }
          ]
        }),
        signal
      });
      if (!res.ok) throw new Error(`OpenAI API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? "";
    }

    if (provider === "anthropic") {
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY or --api-key is required for provider 'anthropic'.");
      const root = (baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
      const res = await fetch(`${root}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
          messages: [{ role: "user", content: req.userPrompt }]
        }),
        signal
      });
      if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      return data.content?.map((c) => c.text ?? "").join("\n") ?? "";
    }

    if (provider === "gemini") {
      if (!apiKey) throw new Error("GEMINI_API_KEY or --api-key is required for provider 'gemini'.");
      const root = (baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
      const res = await fetch(`${root}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          ...(req.systemPrompt ? { systemInstruction: { parts: [{ text: req.systemPrompt }] } } : {}),
          contents: [{ role: "user", parts: [{ text: req.userPrompt }] }]
        }),
        signal
      });
      if (!res.ok) throw new Error(`Gemini API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("\n") ?? "";
    }

    // Ollama local endpoint
    const root = (baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
    const res = await fetch(`${root}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
          { role: "user", content: req.userPrompt }
        ]
      }),
      signal
    });
    if (!res.ok) throw new Error(`Ollama API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  };
}

function evaluateDeterministic(output: string, testCase: EvalCase) {
  const lower = output.toLowerCase();
  const missingMustContain = (testCase.mustContain ?? []).filter((needle) => !lower.includes(needle.toLowerCase()));
  const matchedMustNotContain = (testCase.mustNotContain ?? []).filter((needle) =>
    lower.includes(needle.toLowerCase())
  );
  return {
    missingMustContain,
    matchedMustNotContain,
    passed: missingMustContain.length === 0 && matchedMustNotContain.length === 0
  };
}

async function runJudge(
  complete: EvalCompletionFn,
  provider: EvalProvider,
  model: string,
  testCase: EvalCase,
  candidateOutput: string
): Promise<{ passed: boolean; score: number; reason: string }> {
  const judgeSystem =
    'You are an impartial evaluator grading whether an assistant response satisfies all expected criteria. Reply with JSON only: {"passed": boolean, "score": number, "reason": string}.';
  const judgePrompt = [
    `Prompt:\n${testCase.prompt}`,
    "",
    `Expected criteria:\n${testCase.expected.map((item) => `- ${item}`).join("\n")}`,
    "",
    `Candidate response:\n${candidateOutput}`
  ].join("\n");

  const raw = await complete({
    systemPrompt: judgeSystem,
    userPrompt: judgePrompt,
    provider,
    model
  });

  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { passed?: unknown; score?: unknown; reason?: unknown };
      if (typeof parsed.passed === "boolean") {
        const score = typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : parsed.passed ? 1 : 0;
        const reason = typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "Graded by LLM judge.";
        return { passed: parsed.passed, score, reason };
      }
    } catch {
      // fall back below
    }
  }
  return { passed: false, score: 0, reason: `Could not parse JSON judge verdict: ${raw.slice(0, 120)}` };
}

/**
 * Executes `evals.json` evaluation cases natively against a pluggable LLM provider (OpenAI,
 * Anthropic, Gemini, Ollama, `mock`, or custom `complete` callback), optionally performing blind
 * with-skill vs without-skill ablation and LLM-as-a-judge rubric scoring.
 *
 * @param ref - Library instance or root path.
 * @param options - Provider configuration, filters, `ablation`, and `judge` options.
 * @returns Aggregated pass rates, ablation lift, and per-case results.
 * @throws Error when an unknown split/provider is requested or required API credentials are missing.
 */
export async function runEvalCases(ref: LibraryRef, options: EvalRunOptions = {}): Promise<EvalRunResult> {
  const library: Library = await toLibrary(ref);
  const env = options.env ?? process.env;
  if (options.split && !(EVAL_SPLITS as readonly string[]).includes(options.split)) {
    throw new Error(`Invalid split '${options.split}'. Allowed values: ${EVAL_SPLITS.join(", ")}.`);
  }

  const provider = resolveProvider(options.provider, env);
  const model = options.model?.trim() || env.SKANVIL_EVAL_MODEL?.trim() || DEFAULT_MODELS[provider];
  const baseUrl = options.baseUrl?.trim() || env.SKANVIL_EVAL_BASE_URL?.trim() || undefined;
  const apiKey = resolveApiKey(provider, options.apiKey, env);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const complete = options.complete ?? buildProviderCompleter(provider, model, baseUrl, apiKey, timeoutMs);

  const folders = options.skill ? [options.skill] : await library.listSkillFolders();
  const cases: EvalCaseRunOutcome[] = [];
  let baselinePassedCount = 0;

  for (const folder of folders) {
    if (!library.categories.fromFolder(folder).validated || !(await library.hasSkill(folder))) continue;
    const evals = await library.readSkillEvals(folder);
    const items = evals?.cases ?? [];
    if (items.length === 0) continue;

    for (const testCase of items) {
      if (options.split && testCase.split !== options.split) continue;
      if (options.caseId && testCase.id !== options.caseId) continue;

      const renderedSkill = testCase.params
        ? await library.readSkillRendered(folder, testCase.params)
        : await library.readSkillRendered(folder).catch(() => library.readSkill(folder));

      const started = Date.now();
      const output = await complete({
        systemPrompt: renderedSkill.toString(),
        userPrompt: testCase.prompt,
        provider,
        model
      });
      const durationMs = Date.now() - started;

      const det = evaluateDeterministic(output, testCase);
      let judgeResult: { passed: boolean; score: number; reason: string } | undefined;
      if (options.judge) {
        judgeResult = await runJudge(complete, provider, model, testCase, output);
      }
      const passed = det.passed && (judgeResult ? judgeResult.passed : true);

      let ablation: { baselinePassed: boolean; lift: number; baselineOutput: string } | undefined;
      if (options.ablation) {
        const baselineOutput = await complete({
          systemPrompt: "",
          userPrompt: testCase.prompt,
          provider,
          model
        });
        const baseDet = evaluateDeterministic(baselineOutput, testCase);
        const baseJudge = options.judge
          ? await runJudge(complete, provider, model, testCase, baselineOutput)
          : undefined;
        const baselinePassed = baseDet.passed && (baseJudge ? baseJudge.passed : true);
        if (baselinePassed) baselinePassedCount += 1;
        ablation = {
          baselinePassed,
          lift: (passed ? 1 : 0) - (baselinePassed ? 1 : 0),
          baselineOutput
        };
      }

      cases.push({
        skill: folder,
        caseId: testCase.id,
        ...(testCase.split ? { split: testCase.split } : {}),
        prompt: testCase.prompt,
        passed,
        output,
        missingMustContain: det.missingMustContain,
        matchedMustNotContain: det.matchedMustNotContain,
        ...(judgeResult ? { judgeResult } : {}),
        ...(ablation ? { ablation } : {}),
        durationMs
      });
    }
  }

  const total = cases.length;
  const passed = cases.filter((c) => c.passed).length;
  return {
    provider,
    model,
    total,
    passed,
    failed: total - passed,
    passRate: total > 0 ? passed / total : null,
    ...(options.ablation
      ? {
          ablationSummary: {
            withSkillPassed: passed,
            baselinePassed: baselinePassedCount,
            netLift: passed - baselinePassedCount
          }
        }
      : {}),
    cases
  };
}
