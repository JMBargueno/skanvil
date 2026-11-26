import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  ApiError,
  exportDownloadUrl,
  fetchAuthStatus,
  fetchBudgetsHistory,
  fetchFeedbackSummary,
  fetchLibraries,
  fetchOverview,
  fetchSkillDetail,
  fetchSkillsAnalytics,
  fetchSyncAdoption,
  loginAdmin,
  logoutAdmin,
  updateFeedbackTriage
} from "./api.js";
import { BudgetsEvalsView } from "./components/BudgetsEvalsView.js";
import { FeedbackView } from "./components/FeedbackView.js";
import { OverviewView } from "./components/OverviewView.js";
import { SetupModal } from "./components/SetupModal.js";
import { SkillDetailModal } from "./components/SkillDetailModal.js";
import { SkillsTableView } from "./components/SkillsTableView.js";
import { SyncAdoptionView } from "./components/SyncAdoptionView.js";
import type {
  AdoptionResponse,
  AuthStatusResponse,
  BudgetsResponse,
  FeedbackGroupRow,
  FeedbackResponse,
  FeedbackStatus,
  LibrarySummary,
  OverviewResponse,
  SkillDetailResponse,
  SkillsAnalyticsResponse
} from "../shared/schema.js";

type TabId = "overview" | "skills" | "budgets" | "feedback" | "adoption";
type GlassTheme = "dark" | "light";

const THEME_STORAGE_KEY = "skanvil-hub-theme";

function readInitialTheme(): GlassTheme {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore storage refusal
  }
  return "dark";
}

function AmbientBackdrop() {
  return (
    <div className="ambient-bg" aria-hidden="true">
      <div className="ambient-orb ambient-orb-1" />
      <div className="ambient-orb ambient-orb-2" />
      <div className="ambient-orb ambient-orb-3" />
      <div className="ambient-orb ambient-orb-4" />
      <div className="ambient-grain" />
    </div>
  );
}

function BrandLogoMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" strokeLinejoin="round" />
        <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function TabIcon({ id }: { id: TabId }) {
  switch (id) {
    case "overview":
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="7" height="7" rx="2" />
          <rect x="14" y="3" width="7" height="7" rx="2" />
          <rect x="3" y="14" width="7" height="7" rx="2" />
          <rect x="14" y="14" width="7" height="7" rx="2" />
        </svg>
      );
    case "skills":
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          aria-hidden="true"
        >
          <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
        </svg>
      );
    case "budgets":
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          aria-hidden="true"
        >
          <path d="M3 17l6-6 4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M17 7h4v4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "feedback":
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          aria-hidden="true"
        >
          <path
            d="M4 5h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "adoption":
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          aria-hidden="true"
        >
          <path d="M12 3v12m0 0l-4-4m4 4l4-4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
        </svg>
      );
  }
}

function ControlIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "skills", label: "Skills & Zombies" },
  { id: "budgets", label: "Budgets & Evals" },
  { id: "feedback", label: "Feedback Queue" },
  { id: "adoption", label: "Sync Adoption" }
];

export function App() {
  const [theme, setTheme] = useState<GlassTheme>(() => readInitialTheme());
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [tab, setTab] = useState<TabId>("overview");
  const [library, setLibrary] = useState("all");
  const [days, setDays] = useState(30);
  const [feedbackStatus, setFeedbackStatus] = useState<"all" | FeedbackStatus>("all");
  const [setupOpen, setSetupOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [skillsData, setSkillsData] = useState<SkillsAnalyticsResponse | null>(null);
  const [budgetsData, setBudgetsData] = useState<BudgetsResponse | null>(null);
  const [feedbackData, setFeedbackData] = useState<FeedbackResponse | null>(null);
  const [adoptionData, setAdoptionData] = useState<AdoptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<SkillDetailResponse | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", theme === "light" ? "#e9eff8" : "#060913");
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore storage refusal
    }
  }, [theme]);

  const checkAuth = useCallback(async () => {
    try {
      const status = await fetchAuthStatus();
      setAuth(status);
      return status;
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
      return null;
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const libsRes = await fetchLibraries();
      setLibraries(libsRes.libraries);

      if (tab === "overview") {
        setOverview(await fetchOverview(library, days));
      } else if (tab === "skills") {
        setSkillsData(await fetchSkillsAnalytics(library, days));
      } else if (tab === "budgets") {
        setBudgetsData(await fetchBudgetsHistory(library, days));
      } else if (tab === "feedback") {
        setFeedbackData(await fetchFeedbackSummary(library, days, feedbackStatus));
      } else if (tab === "adoption") {
        setAdoptionData(await fetchSyncAdoption(library));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuth((prev) => (prev ? { ...prev, authenticated: false } : prev));
      } else {
        setError((err as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [tab, library, days, feedbackStatus]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (auth && (!auth.authRequired || auth.authenticated)) {
      void loadData();
    } else if (auth && auth.authRequired && !auth.authenticated) {
      setLoading(false);
    }
  }, [auth, loadData]);

  const handleOpenSkillDetail = async (libName: string, skillName: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    setDetailData(null);
    try {
      setDetailData(await fetchSkillDetail(libName, skillName, days));
    } catch (err) {
      setDetailError((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleTriageChange = async (group: FeedbackGroupRow, nextStatus: FeedbackStatus) => {
    await updateFeedbackTriage({
      groupKey: group.groupKey,
      library: group.library,
      skill: group.skill,
      step: group.step,
      symptom: group.symptom,
      status: nextStatus
    });
    setFeedbackData(await fetchFeedbackSummary(library, days, feedbackStatus));
  };

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      await loginAdmin(tokenInput);
      setTokenInput("");
      await checkAuth();
    } catch (err) {
      setAuthError((err as Error).message);
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = async () => {
    await logoutAdmin().catch(() => undefined);
    setOverview(null);
    setSkillsData(null);
    setBudgetsData(null);
    setFeedbackData(null);
    setAdoptionData(null);
    await checkAuth();
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  if (auth && auth.authRequired && !auth.authenticated) {
    return (
      <>
        <AmbientBackdrop />
        <div className="auth-shell">
          <form className="card auth-card" onSubmit={(e) => void handleLogin(e)}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div className="brand">
                <BrandLogoMark />
                <span>skanvil-hub</span>
                <span className="brand-sub">Self-Hosted</span>
              </div>
              <button
                type="button"
                className="btn btn-icon"
                onClick={toggleTheme}
                aria-label={theme === "dark" ? "Switch to Light Frost theme" : "Switch to Dark Glass theme"}
                title={theme === "dark" ? "Light Frost" : "Dark Glass"}
              >
                <ControlIcon>
                  {theme === "dark" ? (
                    <>
                      <circle cx="12" cy="12" r="4" />
                      <path
                        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
                        strokeLinecap="round"
                      />
                    </>
                  ) : (
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" strokeLinejoin="round" />
                  )}
                </ControlIcon>
              </button>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Enter your <span className="code-chip">SKANVIL_HUB_ADMIN_TOKEN</span> to access dashboard telemetry.
            </p>
            <input
              type="password"
              className="input"
              placeholder="Admin token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              required
              autoFocus
            />
            {authError && <div className="error-text">{authError}</div>}
            <button type="submit" className="btn btn-primary" disabled={authSubmitting}>
              {authSubmitting ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
      </>
    );
  }

  return (
    <>
      <AmbientBackdrop />
      <div className="app-shell">
        <header className="topbar">
          <div className="topbar-inner">
            <div className="brand">
              <BrandLogoMark />
              <span>skanvil-hub</span>
              <span className="brand-sub">Self-Hosted</span>
            </div>

            <div className="controls">
              <select
                className="select"
                aria-label="Filter by skills library"
                value={library}
                onChange={(e) => setLibrary(e.target.value)}
              >
                <option value="all">All libraries ({libraries.length})</option>
                {libraries.map((item) => (
                  <option key={item.library} value={item.library}>
                    {item.library}
                  </option>
                ))}
              </select>

              <select
                className="select"
                aria-label="Time window"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </select>

              <a className="btn" href={exportDownloadUrl("csv", library, days)} download="skanvil-telemetry.csv">
                <ControlIcon>
                  <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" strokeLinecap="round" strokeLinejoin="round" />
                </ControlIcon>
                Export CSV
              </a>

              <a className="btn" href={exportDownloadUrl("json", library, days)} download="skanvil-telemetry.json">
                <ControlIcon>
                  <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" strokeLinecap="round" strokeLinejoin="round" />
                </ControlIcon>
                Export JSON
              </a>

              <button type="button" className="btn" onClick={() => void loadData()} disabled={loading}>
                <ControlIcon>
                  <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                </ControlIcon>
                Refresh
              </button>

              <button
                type="button"
                className="btn btn-icon"
                onClick={toggleTheme}
                aria-label={theme === "dark" ? "Switch to Light Frost theme" : "Switch to Dark Glass theme"}
                title={theme === "dark" ? "Switch to Light Frost" : "Switch to Dark Glass"}
              >
                <ControlIcon>
                  {theme === "dark" ? (
                    <>
                      <circle cx="12" cy="12" r="4" />
                      <path
                        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
                        strokeLinecap="round"
                      />
                    </>
                  ) : (
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" strokeLinejoin="round" />
                  )}
                </ControlIcon>
              </button>

              <button type="button" className="btn btn-primary" onClick={() => setSetupOpen(true)}>
                <ControlIcon>
                  <path d="M8 17l-4-5 4-5M16 7l4 5-4 5M14 4l-4 16" strokeLinecap="round" strokeLinejoin="round" />
                </ControlIcon>
                Connect CLI
              </button>

              {auth?.authRequired && (
                <button type="button" className="btn" onClick={() => void handleLogout()}>
                  Sign out
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="main-container">
          {auth && !auth.authRequired && !bannerDismissed && (
            <div className="banner banner-warn">
              <span>
                Running in <strong>open local dev mode</strong>. Set{" "}
                <span className="code-chip">SKANVIL_HUB_ADMIN_TOKEN</span> and{" "}
                <span className="code-chip">SKANVIL_HUB_API_KEYS</span> before exposing this instance to a team network.
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setBannerDismissed(true)}>
                Dismiss
              </button>
            </div>
          )}

          <nav className="tabs" aria-label="Dashboard sections">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`tab ${tab === item.id ? "tab-active" : ""}`}
                onClick={() => setTab(item.id)}
              >
                <TabIcon id={item.id} />
                {item.label}
                {item.id === "overview" && overview && overview.zombieSkills > 0 && (
                  <span className="badge badge-warn">{overview.zombieSkills} zombie</span>
                )}
                {item.id === "adoption" && adoptionData && adoptionData.deprecatedInstalled.length > 0 && (
                  <span className="badge badge-danger">{adoptionData.deprecatedInstalled.length}</span>
                )}
              </button>
            ))}
          </nav>

          {error && (
            <div className="banner banner-danger">
              <span>Failed to load telemetry: {error}</span>
              <button type="button" className="btn btn-sm" onClick={() => void loadData()}>
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div className="card loading-card">
              <div className="spinner" aria-hidden="true" />
              <p className="muted" style={{ margin: 0 }}>
                Loading telemetry...
              </p>
            </div>
          ) : (
            <>
              {tab === "overview" && overview && (
                <OverviewView data={overview} onOpenSetup={() => setSetupOpen(true)} />
              )}
              {tab === "skills" && skillsData && (
                <SkillsTableView data={skillsData} onSelectSkill={(lib, sk) => void handleOpenSkillDetail(lib, sk)} />
              )}
              {tab === "budgets" && budgetsData && <BudgetsEvalsView data={budgetsData} />}
              {tab === "feedback" && feedbackData && (
                <FeedbackView
                  data={feedbackData}
                  statusFilter={feedbackStatus}
                  onStatusFilterChange={setFeedbackStatus}
                  onTriageChange={handleTriageChange}
                />
              )}
              {tab === "adoption" && adoptionData && <SyncAdoptionView data={adoptionData} />}
            </>
          )}
        </main>

        <SetupModal open={setupOpen} onClose={() => setSetupOpen(false)} />
        <SkillDetailModal
          open={detailOpen}
          loading={detailLoading}
          error={detailError}
          detail={detailData}
          onClose={() => setDetailOpen(false)}
        />
      </div>
    </>
  );
}
