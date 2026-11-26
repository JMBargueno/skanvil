import type {
  AdoptionResponse,
  AuthStatusResponse,
  BudgetsResponse,
  FeedbackResponse,
  LibrariesResponse,
  OverviewResponse,
  SkillsAnalyticsResponse
} from "../shared/schema.js";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // ignore non-JSON error body
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

function buildQuery(library: string, days?: number): string {
  const params = new URLSearchParams();
  if (library && library !== "all") params.set("library", library);
  if (days !== undefined) params.set("days", String(days));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function fetchAuthStatus(): Promise<AuthStatusResponse> {
  return requestJson<AuthStatusResponse>("/api/auth/status");
}

export function loginAdmin(token: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ token })
  });
}

export function logoutAdmin(): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>("/api/auth/logout", {
    method: "POST"
  });
}

export function fetchLibraries(): Promise<LibrariesResponse> {
  return requestJson<LibrariesResponse>("/api/dashboard/libraries");
}

export function fetchOverview(library: string, days: number): Promise<OverviewResponse> {
  return requestJson<OverviewResponse>(`/api/dashboard/overview${buildQuery(library, days)}`);
}

export function fetchSkillsAnalytics(library: string, days: number): Promise<SkillsAnalyticsResponse> {
  return requestJson<SkillsAnalyticsResponse>(`/api/dashboard/skills${buildQuery(library, days)}`);
}

export function fetchBudgetsHistory(library: string, days: number): Promise<BudgetsResponse> {
  return requestJson<BudgetsResponse>(`/api/dashboard/budgets${buildQuery(library, days)}`);
}

export function fetchFeedbackSummary(library: string, days: number): Promise<FeedbackResponse> {
  return requestJson<FeedbackResponse>(`/api/dashboard/feedback${buildQuery(library, days)}`);
}

export function fetchSyncAdoption(library: string): Promise<AdoptionResponse> {
  return requestJson<AdoptionResponse>(`/api/dashboard/adoption${buildQuery(library)}`);
}
