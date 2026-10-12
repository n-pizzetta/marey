import type { ReactNode } from "react";
import type { Level, Streak } from "../utils/gamify";
import { PRODUCT_NAME } from "../utils/brand";
import { keepFocus } from "../utils/keepFocus";
import { NAV_PAGES, type Page } from "../utils/pages";
import { BrandMark } from "./BrandMark";
import { ParseErrors } from "./ParseErrors";
import { ProfileMenu } from "./ProfileMenu";
import { UpdateNotice } from "./UpdateNotice";
import type { Agent } from "../types";
import type { Provider } from "../utils/providers";
import { ProviderSwitcher } from "./ProviderSwitcher";
import { WindowMenu } from "./WindowMenu";

export interface ReportStatus {
  exists: boolean;
  mtime?: string;
}

interface Props {
  page: Page;
  onPageChange: (p: Page) => void;
  providers: Agent[];
  provider: Provider;
  onProviderChange: (provider: Provider) => void;
  showClaude: boolean;
  /** Running sessions waiting on the user, shown on the Now tab. */
  needsYou: number;
  /** The panel the limits pill opens (the current 5h window); `close` hides it. */
  windowPanel: (close: () => void) => ReactNode;
  /** Sessions in the scope, shown on the Sessions tab. */
  sessionCount: number;
  /** Failing or warning health checks in the scope, shown on the Health tab. */
  healthIssues: number;
  /** Badge unlocks not seen on the Progress page yet. */
  unseenUnlocks: number;
  level: Level | null;
  streak: Streak | null;
  source: "real" | "mock";
  generatedAt?: string;
  reportStatus: ReportStatus;
  parseErrors?: string[];
  onHelp: () => void;
}

function formatAge(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 10_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

/** Line icons for the page navigation, drawn on a 24 grid. */
const NAV_ICONS: Record<Page, ReactNode> = {
  now: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  sessions: <path d="M5 6.5h14M5 12h14M5 17.5h9" />,
  usage: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="2.8" />
      <path d="M5 6.5v5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5M5 11.5v5.5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5.5" />
    </>
  ),
  health: <path d="M3.5 12h4l2.5-6 4 12 2.5-6h4" />,
  badges: <path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5v1.5a3 3 0 0 0 3 3M16 6h3v1.5a3 3 0 0 1-3 3M12 13v4M8.5 20h7" />,
};

/** Brand, page navigation, usage limits and the profile menu: the one fixed bar of the app. */
export function AppHeader({
  page,
  onPageChange,
  providers,
  provider,
  onProviderChange,
  showClaude,
  needsYou,
  windowPanel,
  sessionCount,
  healthIssues,
  unseenUnlocks,
  level,
  streak,
  source,
  generatedAt,
  reportStatus,
  parseErrors,
  onHelp,
}: Props) {
  return (
    <header className="app-header">
      <div className="app-brand">
        <BrandMark size={28} />
        <span className="app-brand-name">{PRODUCT_NAME}</span>
        <ProviderSwitcher providers={providers} value={provider} onChange={onProviderChange} />
      </div>

      <nav className="app-nav" aria-label="Pages">
        {NAV_PAGES.map((p, i) => (
          <button
            key={p.id}
            className={`app-nav-item ${page === p.id ? "active" : ""}`}
            aria-current={page === p.id ? "page" : undefined}
            onMouseDown={keepFocus}
            onClick={() => onPageChange(p.id)}
            title={`${p.label} (${i + 1})`}
          >
            <svg className="app-nav-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              {NAV_ICONS[p.id]}
            </svg>
            {p.label}
            {p.id === "now" && needsYou > 0 && (
              <span className="app-nav-count warn mono tabular" title={`${needsYou} session${needsYou > 1 ? "s" : ""} waiting for you`}>{needsYou}</span>
            )}
            {p.id === "sessions" && <span className="app-nav-count mono tabular">{sessionCount}</span>}
            {p.id === "health" && healthIssues > 0 && (
              <span className="app-nav-count warn mono tabular" title={`${healthIssues} check${healthIssues > 1 ? "s" : ""} to look at`}>
                {healthIssues}
              </span>
            )}
            {p.id === "badges" && unseenUnlocks > 0 && (
              <span className="app-nav-count new mono tabular" title={`${unseenUnlocks} new badge${unseenUnlocks > 1 ? "s" : ""}`}>
                {unseenUnlocks}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="app-header-right">
        <UpdateNotice />
        {showClaude && <WindowMenu>{windowPanel}</WindowMenu>}
        {parseErrors && parseErrors.length > 0 && <ParseErrors errors={parseErrors} />}
        <ProfileMenu
          level={level}
          streak={streak}
          source={source}
          parsedAgo={formatAge(generatedAt)}
          reportStatus={reportStatus}
          showClaude={showClaude}
          onHelp={onHelp}
          onOpenPage={onPageChange}
        />
      </div>
    </header>
  );
}
