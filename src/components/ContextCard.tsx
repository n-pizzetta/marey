import { useEffect, useId, useRef, useState } from "react";
import { adviseContext, expiringSoon, fmtLeft, THRESHOLDS, type ContextAdvice, type ContextSnapshot } from "../../scripts/context-advice.mjs";
import { formatTokens } from "../utils/format";
import { useSnapshotMap } from "../utils/liveContext";
import { useNow } from "../utils/useNow";
import "../context.css";

function fillColor(usedPct: number | null): string {
  if (usedPct === null) return "var(--c-text-faint)";
  if (usedPct >= THRESHOLDS.act) return "var(--c-red)";
  if (usedPct >= THRESHOLDS.watch) return "var(--c-amber)";
  return "var(--c-cyan)";
}

function cacheText(a: ContextAdvice): string | null {
  if (a.cache.state === "warm") return a.cache.secsLeft !== null ? `cache ${fmtLeft(a.cache.secsLeft)}` : "cache warm";
  if (a.cache.state === "cold") return "cache cold";
  return null;
}

function cacheTone(a: ContextAdvice): "warm" | "soon" | "cold" | "unknown" {
  if (a.cache.state === "warm") return a.cache.secsLeft !== null && a.cache.secsLeft < expiringSoon(a.cache.ttl) ? "soon" : "warm";
  return a.cache.state;
}

/** Third line of a session row: context fill, cache countdown, and the verdict when it is not "keep going". */
export function ContextLine({ snap, now }: { snap: ContextSnapshot; now: number }) {
  const a = adviseContext(snap, now);
  const used = a.context.usedPct;
  const text = cacheText(a);
  return (
    <div className={`ctx-line level-${a.level}`} title={`${a.label}\n${a.reasons.join("\n")}`}>
      <span className="ctx-bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, used ?? 0)}%`, background: fillColor(used) }} />
      </span>
      <span className="ctx-line-pct mono tabular">ctx {used === null ? "—" : `${used}%`}</span>
      {text && (
        <span className={`ctx-cache mono tabular ${cacheTone(a)}`}>
          <i />
          {text}
        </span>
      )}
      {a.level !== "ok" && <span className="ctx-line-hint">{a.label}</span>}
    </div>
  );
}

/** Window sizes read as round figures: 1M, 200k. */
function formatWindow(n: number): string {
  return n >= 1e6 ? `${Number((n / 1e6).toFixed(2))}M` : `${Math.round(n / 1e3)}k`;
}

/** The faint dot between figures (the session view's meta line and context figures). */
export function StatusSep({ className = "" }: { className?: string }) {
  return <span className={`status-sep ${className}`} aria-hidden="true">·</span>;
}

function Ring({ pct }: { pct: number | null }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const frac = Math.min(1, (pct ?? 0) / 100);
  return (
    <svg className="ctx-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" stroke="var(--c-hairline-strong)" strokeWidth="2.5" />
      <circle
        cx="9" cy="9" r={r} fill="none" stroke={fillColor(pct)} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

const REASONS_W = 360;

/**
 * Context figures for the session view's title row: fill, cache state and countdown, and the verdict.
 * The verdict pill opens its reasons, the cold-start cost and the snapshot's age in a popover (also in
 * its tooltip).
 */
export function ContextSummary({ snap }: { snap: ContextSnapshot }) {
  const now = useNow(15_000);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const reasonsId = useId();

  useEffect(() => {
    if (!open) return;
    // under the pill, right-aligned with it, kept on screen
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(REASONS_W, window.innerWidth - 32);
      setPos({ top: r.bottom + 8, left: Math.max(16, Math.min(r.right - width, window.innerWidth - width - 16)), width });
    };
    place();
    const onDown = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const a = adviseContext(snap, now);
  const idleMs = now - snap.capturedAt;
  const used = a.context.usedPct;
  const text = cacheText(a);
  const recache = a.cache.recacheTokens !== null && a.cache.state !== "unknown" ? formatTokens(a.cache.recacheTokens) : null;
  // once the cache is cold or about to expire, a reason already says what the next message re-caches
  const coldStart = recache && cacheTone(a) === "warm" ? `Cold start ≈ ${recache} tokens: what the next message re-caches once the cache is cold.` : null;
  const updated = idleMs > 60_000 ? `Updated ${fmtLeft(idleMs / 1000)} ago.` : null;
  const details = [...a.reasons, coldStart, updated].filter((s): s is string => !!s);
  const fill = `${formatTokens(a.context.tokens)}${a.context.size ? ` / ${formatWindow(a.context.size)}` : ""}`;
  const fillTitle = `Context window used by the last turn: ${formatTokens(a.context.tokens)}${a.context.size ? ` of ${formatTokens(a.context.size)}` : ""} tokens`;
  return (
    <div className="status-context">
      <span className="status-fig status-fill tabular" title={fillTitle}>
        <Ring pct={used} />
        <span className="status-fill-label">Context</span>
        <b>{used === null ? "—" : `${used}%`}</b>
      </span>
      <StatusSep className="status-fill-tokens" />
      <span className="status-fig status-fill-tokens tabular" title={fillTitle}>{fill}</span>
      {text && (
        <>
          <StatusSep className="status-cache" />
          <span
            className={`ctx-cache status-cache tabular ${cacheTone(a)}`}
            title={[a.cache.ttl ? `Prompt cache ttl ${a.cache.ttl}` : null, recache ? `Cold start ≈ ${recache} tokens` : null].filter(Boolean).join("\n") || undefined}
          >
            {text}
          </span>
        </>
      )}
      <button
        ref={btnRef}
        className={`status-verdict level-${a.level}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? reasonsId : undefined}
        title={`${a.label}\n${details.join("\n")}`}
      >
        <span className="status-verdict-dot" aria-hidden="true" />
        <span className="status-verdict-label">{a.label}</span>
        <svg className="status-verdict-chevron" aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9.5l6 6 6-6" />
        </svg>
      </button>
      {open && pos && (
        <div ref={popRef} className="status-reasons" id={reasonsId} role="dialog" aria-label="Context verdict" style={pos}>
          <strong className={`status-reasons-label level-${a.level}`}>{a.label}</strong>
          <ul>
            {details.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The context figures of one session, when the status line wrapper reported on it recently. */
export function SessionContext({ sessionId }: { sessionId: string }) {
  const snap = useSnapshotMap().get(sessionId);
  return snap ? <ContextSummary snap={snap} /> : null;
}
