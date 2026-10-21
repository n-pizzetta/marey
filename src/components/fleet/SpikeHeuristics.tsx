import type { Session } from "../../types";
import { cacheHit, inputTokens, sumTokens } from "../../utils/fleetStats";
import { formatTokens } from "../../utils/format";

export type HeuristicHit = {
  kind: "cache_miss" | "subagent" | "large_tool_result" | "read_heavy" | "output_verbose" | "bash_explosion";
  severity: "warn" | "info";
  title: string;
  detail: string;
  recommend: string;
};

const LARGE_TOOL_RESULT_BYTES = 50_000;
const READ_HEAVY_BYTES = 100_000;
const BASH_EXPLOSION_BYTES = 30_000;
const OUTPUT_VERBOSE_SHARE = 0.3;
const CACHE_MISS_DROP_PP = 10;

function turnsInWindow(s: Session, fromMs: number, toMs: number) {
  if (!s.turns) return [];
  const startMs = new Date(s.startedAt).getTime();
  return s.turns.filter((t) => {
    const ts = startMs + t.t;
    return ts >= fromMs && ts <= toMs;
  });
}

function toolSequenceInWindow(s: Session, fromMs: number, toMs: number) {
  if (!s.toolSequence) return [];
  const startMs = new Date(s.startedAt).getTime();
  return s.toolSequence.filter((e) => {
    const ts = startMs + e.t;
    return ts >= fromMs && ts <= toMs;
  });
}

export function runHeuristics(
  sessions: Session[],
  fromMs: number,
  toMs: number,
): HeuristicHit[] {
  const hits: HeuristicHit[] = [];

  // Aggregate window-wide signals
  const windowTokensTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const subAgentSessions = new Set<string>();
  let largestToolResult = { bytes: 0, tool: "", project: "" };
  let totalReadBytes = 0;
  let totalBashBytes = 0;
  let bashExploded = { bytes: 0, project: "" };

  // Per-session cache hit baseline (whole session) vs window cache hit
  const cacheMissHits: Array<{ project: string; sessionHit: number; spikeHit: number; pool: number }> = [];

  for (const s of sessions) {
    const wTurns = turnsInWindow(s, fromMs, toMs);
    if (wTurns.length === 0) continue;

    const wTokens = wTurns.reduce(
      (a, t) => ({
        input: a.input + t.tokens.input,
        output: a.output + t.tokens.output,
        cacheRead: a.cacheRead + t.tokens.cacheRead,
        cacheWrite: a.cacheWrite + t.tokens.cacheWrite,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    windowTokensTotal.input += wTokens.input;
    windowTokensTotal.output += wTokens.output;
    windowTokensTotal.cacheRead += wTokens.cacheRead;
    windowTokensTotal.cacheWrite += wTokens.cacheWrite;

    // Sub-agent
    for (const t of wTurns) {
      if (t.tools.includes("Agent")) subAgentSessions.add(s.id);
    }

    // Cache miss vs session baseline
    const wPool = inputTokens(wTokens);
    if (wPool >= 50_000 && inputTokens(s.tokens) >= 100_000) {
      const wHit = cacheHit(wTokens);
      const sHit = cacheHit(s.tokens);
      if ((sHit - wHit) * 100 >= CACHE_MISS_DROP_PP) {
        cacheMissHits.push({ project: s.project, sessionHit: sHit, spikeHit: wHit, pool: wPool });
      }
    }

    // Tool result bytes from toolSequence
    const wSeq = toolSequenceInWindow(s, fromMs, toMs);
    for (const e of wSeq) {
      const bytes = e.result?.bytes ?? 0;
      if (bytes > largestToolResult.bytes) {
        largestToolResult = { bytes, tool: e.tool, project: s.project };
      }
      if (e.tool === "Read") totalReadBytes += bytes;
      if (e.tool === "Bash") {
        totalBashBytes += bytes;
        if (bytes > bashExploded.bytes) bashExploded = { bytes, project: s.project };
      }
    }
  }

  // 1. Cache miss
  if (cacheMissHits.length > 0) {
    const worst = cacheMissHits.sort((a, b) => (b.sessionHit - b.spikeHit) - (a.sessionHit - a.spikeHit))[0];
    hits.push({
      kind: "cache_miss",
      severity: "warn",
      title: "Cache hit dropped during spike",
      detail: `${worst.project}: window cache hit ${(worst.spikeHit * 100).toFixed(0)}% vs session baseline ${(worst.sessionHit * 100).toFixed(0)}% on ${formatTokens(worst.pool)} input pool.`,
      recommend: "Avoid adding fresh content (system prompt edits, large pasted snippets) mid-session — invalidates the prompt cache, so the context is billed again as a cache write.",
    });
  }

  // 2. Sub-agent
  if (subAgentSessions.size > 0) {
    hits.push({
      kind: "subagent",
      severity: "info",
      title: `Sub-agent spawned (${subAgentSessions.size} session${subAgentSessions.size > 1 ? "s" : ""})`,
      detail: `Agent tool was used during the spike — sub-agents have their own context and cost on top of the parent.`,
      recommend: "Verify the sub-agent prompt is tightly scoped. Consider whether the same work could run inline with grep/glob to avoid duplicating context.",
    });
  }

  // 3. Large tool result
  if (largestToolResult.bytes >= LARGE_TOOL_RESULT_BYTES) {
    hits.push({
      kind: "large_tool_result",
      severity: "warn",
      title: `Large tool result captured`,
      detail: `${largestToolResult.tool} returned ${(largestToolResult.bytes / 1024).toFixed(1)} kB in ${largestToolResult.project} — this content is fed back into the model and tokenised.`,
      recommend: "Constrain tool output: pipe Bash through head/grep/jq, search before reading files of unknown size, use offset/limit on Read.",
    });
  }

  // 4. Read heavy
  if (totalReadBytes >= READ_HEAVY_BYTES) {
    hits.push({
      kind: "read_heavy",
      severity: "warn",
      title: `Heavy file reads in window`,
      detail: `Read returned ${(totalReadBytes / 1024).toFixed(1)} kB cumulatively — every kB feeds back into the prompt.`,
      recommend: "Locate candidate files and patterns with a search first (rg / fd, or a search sub-agent), then read only the relevant sections (offset/limit).",
    });
  }

  // 5. Output verbose
  const totalAll = sumTokens(windowTokensTotal);
  if (totalAll > 50_000) {
    const outShare = windowTokensTotal.output / totalAll;
    if (outShare >= OUTPUT_VERBOSE_SHARE) {
      hits.push({
        kind: "output_verbose",
        severity: "warn",
        title: "Long assistant outputs",
        detail: `Output tokens were ${(outShare * 100).toFixed(0)}% of all spike tokens (${formatTokens(windowTokensTotal.output)}). Output is the most expensive token kind.`,
        recommend: "Ask for terser responses ('under 200 words', no preamble). Avoid dumping entire files back unless asked.",
      });
    }
  }

  // 6. Bash explosion
  if (bashExploded.bytes >= BASH_EXPLOSION_BYTES) {
    hits.push({
      kind: "bash_explosion",
      severity: "warn",
      title: "Bash output explosion",
      detail: `${bashExploded.project}: a single Bash command produced ${(bashExploded.bytes / 1024).toFixed(1)} kB. Total Bash output in window: ${(totalBashBytes / 1024).toFixed(1)} kB.`,
      recommend: "Pipe through head/tail/grep, redirect to a file then Read targeted lines, or summarise with awk/jq before returning.",
    });
  }

  return hits;
}
