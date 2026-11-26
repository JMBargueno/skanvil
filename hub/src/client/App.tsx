import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  ApiError,
  fetchAuthStatus,
  fetchBudgetsHistory,
  fetchFeedbackSummary,
  fetchLibraries,
  fetchOverview,
  fetchSkillsAnalytics,
  fetchSyncAdoption,
  loginAdmin,
  logoutAdmin
} from "./api.js";
import { BudgetsEvalsView } from "./components/BudgetsEvalsView.js";
import { FeedbackView } from "./components/FeedbackView.js";
import { OverviewView } from "./components/OverviewView.js";
import { SetupModal } from "./components/SetupModal.js";
import { SkillsTableView } from "./components/SkillsTableView.js";
import { SyncAdoptionView } from "./components/SyncAdoptionView.js";
import type {
  AdoptionResponse,
  AuthStatusResponse,
  BudgetsResponse,
  FeedbackResponse,
  LibrarySummary,
  OverviewResponse,
  SkillsAnalyticsResponse
} from "../shared/schema.js";

type TabId = "overview" | "skills" | "budgets" | "feedback" | "adoption";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "skills", label: "Skills & Zombies" },
  { id: "budgets", label: "Budgets & Evals" },
  { id: "feedback", label: "Feedback Queue" },
  { id: "adoption", label: "Sync Adoption" }
];

export function App() {
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [tab, setTab] = useState<TabId>("overview");
  const [library, setLibrary] = useState("all");
  const [days, setDays] = useState(30);
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
        setFeedbackData(await fetchFeedbackSummary(library, days));
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
  }, [tab, library, days]);

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

  if (auth && auth.authRequired && !auth.authenticated) {
    return (
      <div className="auth-shell">
        <form className="card auth-card" onSubmit={(e) => void handleLogin(e)}>
          <div className="brand">
            <span className="brand-mark">S</span>
            <span>skanvil-hub</span>
            <span className="brand-sub">Self-Hosted</span>
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
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark">S</span>
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

            <button type="button" className="btn" onClick={() => void loadData()} disabled={loading}>
              Refresh
            </button>

            <button type="button" className="btn btn-primary" onClick={() => setSetupOpen(true)}>
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
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>
              Loading telemetry...
            </p>
          </div>
        ) : (
          <>
            {tab === "overview" && overview && <OverviewView data={overview} onOpenSetup={() => setSetupOpen(true)} />}
            {tab === "skills" && skillsData && <SkillsTableView data={skillsData} />}
            {tab === "budgets" && budgetsData && <BudgetsEvalsView data={budgetsData} />}
            {tab === "feedback" && feedbackData && <FeedbackView data={feedbackData} />}
            {tab === "adoption" && adoptionData && <SyncAdoptionView data={adoptionData} />}
          </>
        )}
      </main>

      <SetupModal open={setupOpen} onClose={() => setSetupOpen(false)} />
    </div>
  );
}
