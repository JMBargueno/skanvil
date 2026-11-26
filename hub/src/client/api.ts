import type {
  AdoptionResponse,
  AuthStatusResponse,
  BudgetsResponse,
  FeedbackResponse,
  FeedbackStatus,
  FeedbackTriageRequest,
  LibrariesResponse,
  OverviewResponse,
  SkillDetailResponse,
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

function buildQuery(library: string, days?: number, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  if (library && library !== "all") params.set("library", library);
  if (days !== undefined) params.set("days", String(days));
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function exportDownloadUrl(format: "csv" | "json", library: string, days: number): string {
  return `/api/dashboard/export${buildQuery(library, days, { format })}`;
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

export function fetchSkillDetail(library: string, skill: string, days: number): Promise<SkillDetailResponse> {
  const qs = new URLSearchParams({ library, skill, days: String(days) }).toString();
  return requestJson<SkillDetailResponse>(`/api/dashboard/skill-detail?${qs}`);
}

export function fetchBudgetsHistory(library: string, days: number): Promise<BudgetsResponse> {
  return requestJson<BudgetsResponse>(`/api/dashboard/budgets${buildQuery(library, days)}`);
}

export function fetchFeedbackSummary(
  library: string,
  days: number,
  status: "all" | FeedbackStatus = "all"
): Promise<FeedbackResponse> {
  return requestJson<FeedbackResponse>(
    `/api/dashboard/feedback${buildQuery(library, days, { status: status === "all" ? undefined : status })}`
  );
}

export function updateFeedbackTriage(payload: FeedbackTriageRequest): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>("/api/dashboard/feedback/triage", {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function fetchSyncAdoption(library: string): Promise<AdoptionResponse> {
  return requestJson<AdoptionResponse>(`/api/dashboard/adoption${buildQuery(library)}`);
}
