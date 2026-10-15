import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "../types";
import { projectColor } from "../utils/fleetStats";
import { AGENTS, PROVIDER_LABELS } from "../utils/providers";
import { projectTotal, type ProjectOption } from "../utils/projectOptions";

interface Props {
  projects: ProjectOption[];
  value: string | null;
  onChange: (project: string | null) => void;
  /** Offers "All projects" first; its count is the sum. */
  allowAll?: boolean;
}


/** The highlighted part of a name that matches the search. */
function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + query.length)}</mark>{text.slice(i + query.length)}</>;
}

/** Project picker with a search field: type to filter, ↑ ↓ to move, Enter to pick, Esc to close. */
export function ProjectPicker({ projects, value, onChange, allowAll = false }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const q = query.trim().toLowerCase();
  const items = useMemo(() => {
    const list: Array<ProjectOption & { all?: boolean }> = projects.filter((p) => !q || p.name.toLowerCase().includes(q));
    if (allowAll && !q) {
      const counts: Partial<Record<Agent, number>> = {};
      for (const p of projects) for (const a of AGENTS) if (p.counts[a]) counts[a] = (counts[a] ?? 0) + (p.counts[a] ?? 0);
      list.unshift({ name: "All projects", counts, all: true });
    }
    return list;
  }, [projects, q, allowAll]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const toggle = () => {
    setQuery("");
    setActive(0);
    setOpen((o) => !o);
  };
  const pick = (item: (typeof items)[number] | undefined) => {
    if (!item) return;
    onChange(item.all ? null : item.name);
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { setActive((i) => Math.min(i + 1, items.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setActive((i) => Math.max(i - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter") { pick(items[active]); e.preventDefault(); }
    else if (e.key === "Escape") { setOpen(false); button.current?.focus(); e.stopPropagation(); }
  };

  return (
    <div className="pp-wrap" ref={wrap}>
      <button
        ref={button}
        className={`scope-select pp-btn ${value ? "set" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="scope-select-label">Project</span>
        {value && <span className="project-dot" style={{ background: projectColor(value) }} aria-hidden="true" />}
        <span className="pp-value">{value ?? "All"}</span>
      </button>
      {open && (
        <div className="pp" role="dialog" aria-label="Pick a project">
          <input
            ref={input}
            className="pp-q"
            type="search"
            placeholder="Search projects"
            autoComplete="off"
            aria-label="Search projects"
            aria-controls="pp-list"
            aria-activedescendant={items[active] ? `pp-opt-${active}` : undefined}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKey}
          />
          <ul className="pp-list scrollbar" id="pp-list" role="listbox">
            {items.map((p, i) => (
              <li
                key={p.all ? "*all" : p.name}
                id={`pp-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={(p.all ? value === null : p.name === value) ? "cur" : undefined}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => pick(p)}
              >
                {p.all ? <span className="project-dot pp-all" aria-hidden="true" /> : <span className="project-dot" style={{ background: projectColor(p.name) }} aria-hidden="true" />}
                <span className="pp-name">{p.all ? p.name : <Highlight text={p.name} query={q} />}</span>
                <span className="pp-cnt" title={AGENTS.filter((a) => p.counts[a]).map((a) => `${PROVIDER_LABELS[a]}: ${p.counts[a]}`).join("\n")}>
                  {AGENTS.filter((a) => p.counts[a]).map((a) => (
                    <span key={a}><span className={`provider-dot ${a}`} aria-hidden="true" />{p.counts[a]}</span>
                  ))}
                </span>
              </li>
            ))}
            {items.length === 0 && <li className="pp-none" aria-disabled="true">No project matches “{query}”</li>}
          </ul>
          <div className="pp-foot">{projects.length} project{projects.length === 1 ? "" : "s"} · {projects.reduce((n, p) => n + projectTotal(p), 0)} sessions</div>
        </div>
      )}
    </div>
  );
}
