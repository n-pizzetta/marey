import type { ReactNode } from "react";
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
import { LimitsPill } from "./LimitsGauge";

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
  /** Sessions in the scope, shown on the Sessions tab. */
  sessionCount: number;
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
  context: (
    <>
      <path d="M12 4l8 4-8 4-8-4 8-4z" />
      <path d="M4 12l8 4 8-4M4 16l8 4 8-4" />
    </>
  ),
};

/** Brand, page navigation, plan usage and the settings menu: the one fixed bar of the app. */
export function AppHeader({
  page,
  onPageChange,
  providers,
  provider,
  onProviderChange,
  showClaude,
  needsYou,
  sessionCount,
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
          </button>
        ))}
      </nav>

      <div className="app-header-right">
        <UpdateNotice />
        <LimitsPill providers={provider === "all" ? providers : [provider]} compact onOpen={page === "now" ? undefined : () => onPageChange("now")} />
        {parseErrors && parseErrors.length > 0 && <ParseErrors errors={parseErrors} />}
        <ProfileMenu
          source={source}
          parsedAgo={formatAge(generatedAt)}
          reportStatus={reportStatus}
          showClaude={showClaude}
          providers={providers}
          onHelp={onHelp}
        />
      </div>
    </header>
  );
}
