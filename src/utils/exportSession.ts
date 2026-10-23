import type { Session } from "../types";
import { formatDuration, formatTokens, formatCost, outcomeLabel } from "./format";
import { flattenCalls } from "./toolCalls";
import { toastError } from "./toast";
import { loadSessionDetail } from "../data/loadSessions";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRelTime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(sec).padStart(2, "0")}s`;
}

export function exportSessionHtml(session: Session): string {
  const prompts = session.prompts ?? [];
  const toolSeq = session.toolSequence ?? [];
  const files = session.fileHistory ?? [];
  const totalTools = Object.values(session.toolCounts).reduce((a, b) => a + b, 0);

  const promptRows = prompts
    .map(
      (p) =>
        `<div class="prompt"><div class="t">${formatRelTime(p.t)}</div><pre>${esc(p.text ?? p.preview)}</pre></div>`,
    )
    .join("\n");

  // every call the count counts: a sub-agent's calls follow the call that started it, marked ↳
  const toolRows = flattenCalls(toolSeq)
    .map((t) => {
      const resultBlock = t.result
        ? `<pre class="result${t.result.isError ? " err" : ""}">${esc(t.result.text)}${t.result.truncated ? " …" : ""}</pre>`
        : "";
      return `<div class="tool"><span class="t">${formatRelTime(t.t)}</span><span class="name">${t.sub ? "↳ " : ""}${esc(t.tool)}</span><span class="prev">${esc(t.preview)}</span>${resultBlock}</div>`;
    })
    .join("\n");

  const fileRows = files
    .map((f) => {
      const name = f.path ? esc(f.path) : esc(f.hash);
      return `<li><code>${name}</code> <span class="dim">${f.versions.length} version${f.versions.length > 1 ? "s" : ""}</span></li>`;
    })
    .join("\n");

  const frictionRows = session.frictions
    .map(
      (f) =>
        `<li><strong>${esc(f.kind.replace(/_/g, " "))}</strong> <span class="dim">${esc(f.detail)}</span></li>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Marey · ${esc(session.goal.slice(0, 60))}</title>
<style>
  :root {
    --fg: #e6e6e6; --bg: #0d0f11; --dim: #7a7f86; --panel: #14171b; --hair: #222730;
    --cyan: #00d9e8; --amber: #ffb020; --green: #00d97e; --red: #e5484d;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro", Inter, system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 40px 20px; }
  main { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); margin: 28px 0 12px; border-bottom: 1px solid var(--hair); padding-bottom: 6px; }
  .mono, code, pre { font-family: "JetBrains Mono", "SF Mono", Menlo, monospace; }
  .dim { color: var(--dim); }
  .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 16px 0 24px; }
  .cell { background: var(--panel); padding: 10px; border-radius: 6px; }
  .cell .k { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); }
  .cell .v { font-size: 16px; font-weight: 600; margin-top: 4px; }
  .summary { background: var(--panel); padding: 12px 14px; border-radius: 6px; font-size: 13px; line-height: 1.5; }
  .prompt { background: var(--panel); border-left: 2px solid var(--cyan); padding: 10px 12px; margin-bottom: 8px; border-radius: 3px; }
  .prompt .t { font-size: 10px; color: var(--dim); margin-bottom: 4px; }
  .prompt pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .tool { display: grid; grid-template-columns: 70px 80px 1fr; gap: 12px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--hair); }
  .tool .t { color: var(--dim); }
  .tool .name { color: var(--fg); font-weight: 600; }
  .tool .prev { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool .result { grid-column: 2 / -1; margin: 4px 0 8px; padding: 6px 8px; background: #0a0d10; border-left: 2px solid var(--cyan); font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; color: var(--dim); }
  .tool .result.err { border-color: var(--red); color: var(--red); }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--hair); }
  footer { margin-top: 40px; font-size: 11px; color: var(--dim); text-align: center; }
</style>
</head>
<body>
<main>
  <h1>${esc(session.goal)}</h1>
  <div class="dim mono">${esc(session.project)} · ${esc(new Date(session.startedAt).toLocaleString())}</div>

  <div class="meta">
    <div class="cell"><div class="k">Outcome</div><div class="v">${esc(session.ghost ? "ghost" : outcomeLabel(session.outcome))}</div></div>
    <div class="cell"><div class="k">Duration</div><div class="v">${formatDuration(session.durationMs)}</div></div>
    <div class="cell"><div class="k">Tokens</div><div class="v">${formatTokens(session.tokens.input + session.tokens.output)}</div></div>
    <div class="cell"><div class="k">Cost</div><div class="v">${formatCost(session.costUsd)}</div></div>
  </div>

  <h2>Summary</h2>
  <div class="summary">${esc(session.summary)}</div>

  ${session.quality ? `<h2>Quality (measured)</h2>
  <div class="summary">Grade <strong>${esc(session.quality.grade)}</strong> · Score ${session.quality.score.toFixed(1)}${session.quality.band ? ` · Band ${esc(session.quality.band)}` : ""}</div>` : ""}

  ${frictionRows ? `<h2>Frictions (LLM-assessed)</h2><ul>${frictionRows}</ul>` : ""}

  ${prompts.length > 0 ? `<h2>Prompts (${prompts.length})</h2>${promptRows}` : ""}

  ${toolSeq.length > 0 ? `<h2>Tool calls (${totalTools})</h2>${toolRows}` : ""}

  ${fileRows ? `<h2>Files edited</h2><ul>${fileRows}</ul>` : ""}

  <footer>
    Exported from Marey · session <code>${esc(session.id)}</code>
  </footer>
</main>
</body>
</html>`;
}

/** The view can hold the list summary only (detail still loading, or failed): the export loads the full session. */
export async function downloadSessionHtml(session: Session) {
  let full = session;
  try {
    const detail = await loadSessionDetail(session.id);
    if (detail) full = { ...session, ...detail };
  } catch {
    toastError("Could not load the full session: the export holds its summary only.");
  }
  const html = exportSessionHtml(full);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeGoal = session.goal.slice(0, 40).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  a.download = `session-${safeGoal || session.id.slice(0, 8)}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
