import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "./components/BrandMark";
import { type FilterId } from "./components/SessionFilters";
import { AppHeader, type ReportStatus } from "./components/AppHeader";
import { ScopeBar } from "./components/ScopeBar";
import { StatsRow } from "./components/StatsStrip";
import { sortSessions, type Sort } from "./utils/sortSessions";
import { SessionDetail } from "./components/SessionDetail";
import { HelpOverlay } from "./components/HelpOverlay";
import { BurnSpikeBanner } from "./components/fleet/BurnSpikeBanner";
import { SpikeAnalysisOverlay } from "./components/fleet/SpikeAnalysisOverlay";
import { NowPage } from "./pages/NowPage";
import { SessionsPage } from "./pages/SessionsPage";
import { UsagePage } from "./pages/UsagePage";
import { HealthPage } from "./pages/HealthPage";
import { BadgesPage } from "./pages/BadgesPage";
import { loadSessions, loadSessionDetail } from "./data/loadSessions";
import type { Agent, Session } from "./types";
import { detectedProviders, isProvider, resolveProvider, sessionProvider, type Provider } from "./utils/providers";
import { useRecommendations } from "./utils/recommendations";
import type { Range } from "./utils/range";
import { filterByRange, scopeToRange } from "./utils/range";
import { registerProjects } from "./utils/fleetStats";
import { healthReport } from "./utils/healthRules";
import { useRateLimits } from "./utils/rateLimits";
import { useBurnTracker, type Spike } from "./utils/burnTracker";
import { useUnit } from "./utils/units";
import { NAV_PAGES, PAGE_IDS, SCOPED_PAGES, type Page } from "./utils/pages";
import { useBadges } from "./utils/gamify";
import { useProgressEvents } from "./utils/progress";
import "./gamify.css";
import "./App.css";
import "./shell.css";
import "./detail.css";
import "./layout.css";
import { Toaster } from "./components/Toaster";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { toastError } from "./utils/toast";

const POLL_MS = 5000;
const STORAGE_KEY = "marey:state";

const FILTER_IDS: FilterId[] = ["all", "live", "ghost", "friction", "failed", "lowquality"];
const RANGE_IDS: Range[] = ["today", "7d", "30d", "all"];
/** Sessions that can be compared side by side. Not applied to the ghost bulk-delete selection. */
const MAX_COMPARE = 3;
const DEFAULT_SORT: Sort = { key: "started", dir: "desc" };

interface PersistedState {
  page: Page;
  id: string | null;
  range: Range;
  filter: FilterId;
  provider: Provider;
  project: string | null;
  search: string;
}

/** `#<page>?query` or `#session/<id>?query`; the Now page has no path. */
function parseHash(): Partial<PersistedState> {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return {};
  const [path, query] = raw.split("?");
  const out: Partial<PersistedState> = {};
  const m = path.match(/^session\/([a-f0-9-]{36})$/i);
  if (m) out.id = m[1];
  else if ((PAGE_IDS as string[]).includes(path)) out.page = path as Page;
  else if (path === "") out.page = "now";
  if (query) {
    const params = new URLSearchParams(query);
    const r = params.get("range");
    if (r && (RANGE_IDS as string[]).includes(r)) out.range = r as Range;
    const f = params.get("filter");
    if (f && (FILTER_IDS as string[]).includes(f)) out.filter = f as FilterId;
    // Preserve links made before providers moved out of the session filters.
    if (f === "claude" || f === "codex") {
      out.provider = f;
      out.filter = "all";
    }
    const provider = params.get("provider");
    if (isProvider(provider)) out.provider = provider;
    const p = params.get("project");
    if (p) out.project = p;
    const q = params.get("q");
    if (q) out.search = q;
  }
  return out;
}

function loadPersisted(): Partial<PersistedState> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const state = JSON.parse(stored) as Omit<Partial<PersistedState>, "filter"> & { filter?: FilterId | Agent };
      if (state.filter === "claude" || state.filter === "codex") {
        return { ...state, provider: state.provider ?? state.filter, filter: "all" };
      }
      return state as Partial<PersistedState>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function writeHash(state: PersistedState) {
  const params = new URLSearchParams();
  if (state.range !== "7d") params.set("range", state.range);
  if (state.filter !== "all") params.set("filter", state.filter);
  if (state.provider !== "all") params.set("provider", state.provider);
  if (state.project) params.set("project", state.project);
  if (state.search) params.set("q", state.search);
  const qs = params.toString();
  const path = state.id ? `session/${state.id}` : state.page !== "now" ? state.page : "";
  const hash = path || qs ? `#${path}${qs ? `?${qs}` : ""}` : "";
  if (window.location.hash !== hash) {
    const full = hash || window.location.pathname + window.location.search;
    window.history.replaceState(null, "", full);
  }
}

function App() {
  const initial = useMemo(() => ({ ...loadPersisted(), ...parseHash() }), []);
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [source, setSource] = useState<"real" | "mock" | "loading">("loading");
  const [generatedAt, setGeneratedAt] = useState<string | undefined>();
  const [parseErrors, setParseErrors] = useState<string[] | undefined>();
  const [page, setPage] = useState<Page>(initial.page && PAGE_IDS.includes(initial.page) ? initial.page : "now");
  const [selectedId, setSelectedIdInternal] = useState<string | null>(initial.id ?? null);
  const [filter, setFilter] = useState<FilterId>(initial.filter ?? "all");
  const [preferredProvider, setPreferredProvider] = useState<Provider>(isProvider(initial.provider) ? initial.provider : "all");
  const [projectFilter, setProjectFilter] = useState<string | null>(initial.project ?? null);
  const [range, setRange] = useState<Range>(initial.range ?? "7d");
  const [search, setSearch] = useState(initial.search ?? "");
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [helpOpen, setHelpOpen] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [reportStatus, setReportStatus] = useState<ReportStatus>({ exists: false });
  const [analysisSpike, setAnalysisSpike] = useState<Spike | null>(null);
  const unit = useUnit();
  const limits = useRateLimits();
  const providers = useMemo(() => detectedProviders(allSessions), [allSessions]);
  const provider = resolveProvider(preferredProvider, providers);
  const providerSessions = useMemo(
    () => provider === "all" ? allSessions : allSessions.filter((s) => sessionProvider(s) === provider),
    [allSessions, provider],
  );
  const showClaude = provider !== "codex" && providers.includes("claude");
  /** Sessions that count against the Claude usage limits: 5h window, burn rate, spikes. Codex has its own. */
  const limitSessions = useMemo(() => allSessions.filter((s) => s.agent !== "codex"), [allSessions]);
  const burn = useBurnTracker(limitSessions, limits);
  // Refetched after each parse; announces unlocks and level-ups wherever the user is.
  const claudeBadges = useBadges(allSessions);
  const badges = showClaude ? claudeBadges : null;
  // Claude Code only for now: Codex rollouts expose no incidents yet.
  const allRecommendations = useRecommendations(generatedAt);
  const recommendations = showClaude ? allRecommendations : null;
  const openProgress = () => {
    setSelectedIdInternal(null);
    setPage("badges");
  };
  // Not while loading: the Toaster isn't mounted yet, so announcements would be lost.
  const progress = useProgressEvents(source === "loading" ? null : badges, openProgress);

  useEffect(() => {
    // The choice, not the resolved provider: a Claude-only history must not pin "claude" once Codex shows up.
    const state: PersistedState = { page, id: selectedId, range, filter, provider: preferredProvider, project: projectFilter, search };
    writeHash(state);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }, [page, selectedId, range, filter, preferredProvider, projectFilter, search]);

  /** Leaving the ghost filter with a bigger selection than a comparison can hold trims it. */
  const changeFilter = (f: FilterId) => {
    setFilter(f);
    if (f !== "ghost") setCompareIds((prev) => (prev.size > MAX_COMPARE ? new Set([...prev].slice(0, MAX_COMPARE)) : prev));
  };

  const resetFilters = () => {
    changeFilter("all");
    setProjectFilter(null);
    setSearch("");
  };

  const changeProvider = (next: Provider) => {
    setPreferredProvider(next);
    resetFilters();
    setCompareIds(new Set());
    setCompareMode(false);
    setSelectedIdInternal(null);
    setAnalysisSpike(null);
  };

  const setSelectedId = (id: string | null) => {
    setSelectedIdInternal(id);
  };

  useEffect(() => {
    const onHash = () => {
      const parsed = parseHash();
      const next = parsed.id ?? null;
      if (next !== selectedId) setSelectedIdInternal(next);
      if (parsed.page) setPage(parsed.page);
      setPreferredProvider(parsed.provider ?? "all");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const r = await loadSessions();
      if (cancelled) return;
      registerProjects(r.sessions.map((x) => x.project || "unknown"));
      setAllSessions(r.sessions);
      setSource(r.source);
      setGeneratedAt(r.generatedAt);
      setParseErrors(r.parseErrors);
      if (r.sessions.length > 0) {
        setSelectedIdInternal((id) => (id && !r.sessions.some((s) => s.id === id) ? null : id));
      }
      try {
        const rs = await fetch("/api/report-status").then((x) => x.json());
        if (!cancelled) {
          setReportStatus({ exists: !!rs.exists, mtime: rs.mtime ?? undefined });
        }
      } catch {
        /* ignore — likely served as static export without API */
      }
    }
    refresh();
    const hot = (import.meta as ImportMeta & { hot?: { on: (e: string, cb: () => void) => void; off?: (e: string, cb: () => void) => void } }).hot;
    const hmrActive = !!hot;
    const id = hmrActive ? null : setInterval(refresh, POLL_MS);
    const onPush = () => refresh();
    if (hot) hot.on("marey:sessions-updated", onPush);
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
      if (hot?.off) hot.off("marey:sessions-updated", onPush);
    };
  }, []);

  const inRange = useMemo(() => filterByRange(providerSessions, range), [range, providerSessions]);

  const q = search.trim().toLowerCase();
  const unsorted = useMemo(() => inRange.filter((s) => {
    if (projectFilter && s.project !== projectFilter) return false;
    if (q) {
      const hay = `${s.goal} ${s.project} ${s.summary}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === "live") return !!s.live;
    if (filter === "ghost") return !!s.ghost;
    if (filter === "friction") return s.frictions.length > 0;
    if (filter === "failed") return !s.ghost && (s.outcome === "not_achieved" || s.outcome === "partially_achieved");
    if (filter === "lowquality") return !!s.quality && s.quality.score < 70;
    return true;
  }), [inRange, projectFilter, q, filter]);
  // The table order is also the ↑ / ↓ order inside a session.
  const filtered = useMemo(() => sortSessions(unsorted, sort, unit), [unsorted, sort, unit]);
  // Aggregates only count what was spent inside the range (per turn).
  const scopedFiltered = useMemo(() => scopeToRange(filtered, range), [filtered, range]);
  const healthIssues = useMemo(
    () => healthReport(scopedFiltered, providerSessions).rules.filter((r) => r.status === "fail" || r.status === "warn").length,
    [scopedFiltered, providerSessions],
  );
  const activeFilterCount = (filter !== "all" ? 1 : 0) + (projectFilter ? 1 : 0) + (search ? 1 : 0);

  const selectedSummary: Session | null = selectedId
    ? filtered.find((s) => s.id === selectedId) ??
      inRange.find((s) => s.id === selectedId) ??
      allSessions.find((s) => s.id === selectedId) ??
      null
    : null;

  const [detail, setDetail] = useState<{ id: string; data: Session | null } | null>(null);
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    loadSessionDetail(selectedId)
      .then((d) => { if (!cancelled) setDetail({ id: selectedId, data: d }); })
      .catch(() => {
        if (cancelled) return;
        setDetail({ id: selectedId, data: null });
        toastError("Could not load the session details. Showing the summary only.");
      });
    return () => { cancelled = true; };
  }, [selectedId]);
  const selectedDetail = detail && detail.id === selectedId ? detail.data : null;

  const selected: Session | null = selectedSummary || selectedDetail
    ? ({
        timeline: [],
        prompts: [],
        turns: [],
        toolSequence: [],
        fileHistory: [],
        ...selectedSummary,
        ...selectedDetail,
      } as Session)
    : null;

  const selectedIdx = selected ? filtered.findIndex((s) => s.id === selected.id) : -1;
  const navigate = (dir: "prev" | "next") => {
    if (selectedIdx < 0 || filtered.length === 0) return;
    const target = dir === "next" ? selectedIdx + 1 : selectedIdx - 1;
    if (target < 0 || target >= filtered.length) return;
    setSelectedId(filtered[target].id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const isNav = e.key === "ArrowDown" || e.key === "j" || e.key === "ArrowUp" || e.key === "k";
      if (isNav) {
        // only hijack arrows while a session is open, so pages can still scroll
        if (!selectedId || helpOpen) return;
        e.preventDefault();
        navigate(e.key === "ArrowDown" || e.key === "j" ? "next" : "prev");
      }
      else if (e.key === "Escape") {
        if (helpOpen) return;
        if (selectedId) setSelectedId(null);
      }
      else if (/^[1-9]$/.test(e.key) && !selectedId && !helpOpen) {
        const target = NAV_PAGES[Number(e.key) - 1];
        if (target) setPage(target.id);
      }
      else if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        setHelpOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx, filtered.length, selectedId, helpOpen]);

  if (source === "loading") {
    return (
      <div className="app">
        <div className="loading-screen">
          <BrandMark size={44} />
          <div className="mono dim" style={{ marginTop: 14 }}>Reading Claude Code and Codex sessions…</div>
        </div>
      </div>
    );
  }

  const scoped = SCOPED_PAGES.has(page);

  return (
    <div className="app">
      <AppHeader
        page={page}
        onPageChange={setPage}
        providers={providers}
        provider={provider}
        onProviderChange={changeProvider}
        showClaude={showClaude}
        sessionCount={filtered.length}
        healthIssues={healthIssues}
        unseenUnlocks={page === "badges" ? 0 : progress.unseen.size}
        level={badges?.level ?? null}
        streak={badges?.streak ?? null}
        source={source}
        generatedAt={generatedAt}
        reportStatus={reportStatus}
        parseErrors={parseErrors}
        onHelp={() => setHelpOpen(true)}
      />
      {scoped && (
        <ScopeBar
          range={range}
          onRangeChange={setRange}
          filter={filter}
          onFilterChange={changeFilter}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          search={search}
          onSearchChange={setSearch}
          inRange={inRange}
          count={filtered.length}
          onReset={resetFilters}
        />
      )}
      <main className={`app-content scrollbar ${page === "sessions" ? "fill" : ""}`}>
        {showClaude && burn.activeSpike && (
          <BurnSpikeBanner
            spike={burn.activeSpike}
            onInvestigate={() => setAnalysisSpike(burn.activeSpike)}
            onDismiss={burn.dismissSpike}
          />
        )}
        {scoped && (
          <StatsRow
            sessions={scopedFiltered}
            totalInRange={inRange.length}
            range={range}
            activeFilterCount={activeFilterCount}
          />
        )}
        {page === "now" && (
          <NowPage
            allSessions={providerSessions}
            provider={provider}
            showClaude={showClaude}
            recommendations={recommendations}
            onOpenHealth={() => setPage("health")}
            limitSessions={limitSessions}
            limits={limits}
            badges={badges}
            onSelectSession={setSelectedId}
            onShowAllSessions={() => setPage("sessions")}
            onOpenProgress={openProgress}
          />
        )}
        {page === "sessions" && (
          <SessionsPage
            sessions={filtered}
            allSessions={providerSessions}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
            sort={sort}
            onSortChange={setSort}
            onProjectClick={(p) => setProjectFilter((cur) => (cur === p ? null : p))}
            compareMode={compareMode}
            onToggleCompareMode={() => {
              setCompareMode((v) => {
                if (v) setCompareIds(new Set());
                return !v;
              });
            }}
            compareIds={compareIds}
            onToggleCompare={(id) => {
              if (!compareIds.has(id) && filter !== "ghost" && compareIds.size >= MAX_COMPARE) {
                toastError(`You can compare up to ${MAX_COMPARE} sessions. Deselect one first.`);
                return;
              }
              setCompareIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onRemoveCompare={(id) =>
              setCompareIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              })
            }
            compareLimit={filter === "ghost" ? undefined : MAX_COMPARE}
            ghostsFocused={filter === "ghost"}
            onBulkDelete={async (ids) => {
              const res = await fetch("/api/ghost/bulk-delete", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids }),
              });
              if (!res.ok) {
                toastError("Bulk delete failed: " + (await res.text()));
                return;
              }
              setCompareIds(new Set());
            }}
          />
        )}
        {page === "usage" && (
          <UsagePage sessions={scopedFiltered} allSessions={providerSessions} range={range} onSelectSession={setSelectedId} />
        )}
        {page === "health" && (
          <HealthPage sessions={scopedFiltered} allSessions={providerSessions} recommendations={recommendations} onSelectSession={setSelectedId} />
        )}
        {page === "badges" && (
          <BadgesPage
            allSessions={providerSessions}
            provider={provider}
            badges={badges}
            unseen={progress.unseen}
            onViewed={progress.markViewed}
            onSelectSession={setSelectedId}
          />
        )}
      </main>
      {showClaude && analysisSpike && (
        <SpikeAnalysisOverlay
          spike={analysisSpike}
          sessions={scopedFiltered.filter((s) => s.agent !== "codex")}
          onClose={() => setAnalysisSpike(null)}
          onSelectSession={(id) => {
            setAnalysisSpike(null);
            setSelectedId(id);
          }}
        />
      )}
      {selected && (
        <div className="session-overlay-host">
          <ErrorBoundary key={selected.id} onClose={() => setSelectedId(null)}>
          <SessionDetail
            session={selected}
            fullscreen={true}
            onClose={() => setSelectedId(null)}
            onNavigate={navigate}
            hasPrev={selectedIdx > 0}
            hasNext={selectedIdx >= 0 && selectedIdx < filtered.length - 1}
            position={selectedIdx + 1}
            total={filtered.length}
          />
          </ErrorBoundary>
        </div>
      )}
      <Toaster />
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

export default App;
