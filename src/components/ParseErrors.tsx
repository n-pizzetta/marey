import { useEffect, useRef, useState } from "react";
import { toastError } from "../utils/toast";

/** Top-bar badge (only rendered when there are errors) with a popover to trash the offending files. */
function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4h10" />
      <path d="M6.5 4V2.5h3V4" />
      <path d="M4.5 4l.6 8.5a1 1 0 001 .9h3.8a1 1 0 001-.9L11.5 4" />
      <path d="M7 7v4" />
      <path d="M9 7v4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

function ParseErrorRow({ fileName }: { fileName: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const trash = async () => {
    if (busy || done) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/parse-error/${encodeURIComponent(fileName)}/trash`, { method: "POST" });
      if (!res.ok) {
        toastError("Trash failed: " + (await res.text()));
        setBusy(false);
        return;
      }
      setDone(true);
    } catch (e) {
      toastError("Trash failed: " + (e as Error).message);
      setBusy(false);
    }
  };
  return (
    <li className={`parse-errors-pop-row ${done ? "trashed" : ""}`}>
      <span className="parse-errors-pop-name">{fileName}</span>
      <button
        className="parse-errors-pop-trash"
        onClick={trash}
        disabled={busy || done}
        title={done ? "Trashed" : "Move to .trash/"}
        aria-label={done ? "Trashed" : `Trash ${fileName}`}
      >
        {done ? (
          <CheckIcon />
        ) : busy ? (
          <span className="dim">…</span>
        ) : (
          <TrashIcon />
        )}
      </button>
    </li>
  );
}

export function ParseErrors({ errors }: { errors: string[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const updatePos = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ top: r.bottom + 8, right: Math.max(16, window.innerWidth - r.right) });
    };
    updatePos();
    const onClick = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't let App's Escape handler close the session view as well.
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="topline-chip parse-errors-chip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Session files the parser couldn't read"
      >
        <span className="glyph-error">!</span>
        <span className="tabular">{errors.length}</span>
      </button>
      {open && pos && (
        <div
          ref={popRef}
          className="parse-errors-popover"
          role="dialog"
          aria-label="Parse errors"
          style={{ top: pos.top, right: pos.right }}
        >
          <div className="parse-errors-pop-head">
            <span className="mono caps dim">Parse errors</span>
            <span className="mono dim tabular">{errors.length} total</span>
          </div>
          <p className="parse-errors-pop-desc mono dim">
            session-meta files the parser couldn't read (missing session_id / start_time, malformed JSON). Safe to ignore — these sessions are skipped.
          </p>
          <ul className="parse-errors-pop-list mono">
            {errors.slice(0, 20).map((e) => (
              <ParseErrorRow key={e} fileName={e} />
            ))}
          </ul>
          {errors.length > 20 && (
            <div className="mono dim parse-errors-pop-more">… +{errors.length - 20} more</div>
          )}
          <div className="parse-errors-pop-hint mono dim">
            Location: ~/.claude/usage-data/session-meta/
          </div>
        </div>
      )}
    </>
  );
}
