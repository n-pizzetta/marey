/**
 * Context quality, measured from the transcript alone.
 *
 * One tracker per main-thread transcript, fed while parsing. Each signal
 * scores 0-100 (100 = no waste) and estimates the tokens it wasted (chars / 4).
 * The score is their weighted mean. Same shape as the SessionQuality type.
 */

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tool results above this many characters are "bloated": they sit in context for every later turn. */
const BLOATED_CHARS = 25_000;
/** Sessions shorter than this many assistant turns get no score: too little to mean anything. */
const MIN_TURNS = 5;
const STANDARD_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

const WEIGHTS = {
  context_fill: 0.3,
  stale_reads: 0.2,
  bloated_results: 0.2,
  compaction_depth: 0.2,
  duplicates: 0.1,
};

const LABELS = {
  context_fill: "Context fill",
  stale_reads: "Stale file reads",
  bloated_results: "Bloated tool results",
  compaction_depth: "Compaction depth",
  duplicates: "Duplicate tool calls",
};

const tokensOf = (chars) => Math.round(chars / 4);
const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));

/** The context fill signal: 100 up to half the window, 0 at 95%. */
function fillSignal(peak, window) {
  const fillPct = (peak / window) * 100;
  return {
    kind: "context_fill",
    score: clamp(fillPct <= 50 ? 100 : 100 - ((fillPct - 50) / 45) * 100),
    detail: `Peak context ${Math.round(peak / 1000)}k of ${window / 1000}k (${Math.round(fillPct)}%)`,
    wasteTokens: 0,
    label: LABELS.context_fill,
  };
}

/** Score, grade and fill band from the signals. */
function summarize(signals, { peak, window, compactions }) {
  const fillPct = (peak / window) * 100;
  const score = signals.reduce((a, s) => a + s.score * WEIGHTS[s.kind], 0);
  return {
    score: Math.round(score * 10) / 10,
    grade: score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F",
    fillPct,
    band: fillPct < 50 ? "healthy" : fillPct < 70 ? "watch" : fillPct < 85 ? "degrading" : "critical",
    wasteTokens: signals.reduce((a, s) => a + s.wasteTokens, 0),
    compactions,
    peak,
    window,
    signals,
  };
}

/**
 * The quality re-scored against a known context window (the transcript has none: `finish` infers
 * 200k unless the peak proves 1M). Unchanged when the window is the same, or smaller than the peak.
 */
export function withWindow(quality, window) {
  if (!quality || !window || quality.window === window || !(quality.peak > 0) || quality.peak > window) return quality;
  const signals = quality.signals.map((s) => (s.kind === "context_fill" ? fillSignal(quality.peak, window) : s));
  return summarize(signals, { peak: quality.peak, window, compactions: quality.compactions });
}

/** Identity of a tool call for duplicate detection; null when it has no stable input. */
function callKey(name, input) {
  if (typeof input.command === "string") return `${name}:${input.command}`;
  if (typeof input.pattern === "string") return `${name}:${input.pattern}:${input.path ?? ""}:${input.glob ?? ""}`;
  if (typeof input.url === "string") return `${name}:${input.url}`;
  if (typeof input.query === "string") return `${name}:${input.query}`;
  return null;
}

export function createQualityTracker() {
  /** Read key (path + range) → still valid (no edit to that path since). */
  const reads = new Map();
  const calls = new Set();
  /** tool_use id → bucket whose waste is the result size. */
  const pending = new Map();
  const waste = { stale_reads: 0, bloated_results: 0, duplicates: 0 };
  const count = { stale_reads: 0, bloated_results: 0, duplicates: 0, reads: 0 };
  let compactions = 0;

  return {
    onToolUse(name, input, id) {
      if (EDIT_TOOLS.has(name)) {
        const path = input.file_path ?? input.notebook_path;
        for (const key of reads.keys()) if (key.startsWith(`${path}\0`)) reads.delete(key);
        // The workspace changed: re-running a command is no longer a duplicate.
        calls.clear();
        return;
      }
      if (name === "Read" && typeof input.file_path === "string") {
        count.reads++;
        const key = `${input.file_path}\0${input.offset ?? ""}\0${input.limit ?? ""}`;
        if (reads.has(key)) {
          count.stale_reads++;
          if (id) pending.set(id, "stale_reads");
        }
        reads.set(key, true);
        return;
      }
      const key = callKey(name, input);
      if (!key) return;
      if (calls.has(key)) {
        count.duplicates++;
        if (id) pending.set(id, "duplicates");
      }
      calls.add(key);
    },

    onToolResult(id, chars) {
      const bucket = pending.get(id);
      if (chars > BLOATED_CHARS) count.bloated_results++;
      // Each result's waste goes to one signal only: a stale or duplicate result is wasted whole.
      if (bucket) {
        waste[bucket] += tokensOf(chars);
        pending.delete(id);
      } else if (chars > BLOATED_CHARS) {
        waste.bloated_results += tokensOf(chars - BLOATED_CHARS);
      }
    },

    onCompaction() {
      compactions++;
    },

    /** turns: main-thread turns with `tokens`. Returns null for sessions too short to score. */
    finish(turns) {
      if (turns.length < MIN_TURNS) return null;
      let peak = 0;
      for (const t of turns) {
        const ctx = t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite;
        if (ctx > peak) peak = ctx;
      }
      // The window isn't in the transcript: a context over 200k proves a 1M window. The parser
      // corrects it from the live snapshots when it can (withWindow).
      const window = peak > STANDARD_WINDOW ? LARGE_WINDOW : STANDARD_WINDOW;

      const signals = [
        fillSignal(peak, window),
        {
          kind: "stale_reads",
          score: clamp(100 - count.stale_reads * 10),
          detail: `${count.stale_reads} of ${count.reads} reads re-read an unchanged file`,
          wasteTokens: waste.stale_reads,
        },
        {
          kind: "bloated_results",
          score: clamp(100 - count.bloated_results * 15),
          detail: `${count.bloated_results} tool results over ${BLOATED_CHARS / 1000}k characters`,
          wasteTokens: waste.bloated_results,
        },
        {
          kind: "compaction_depth",
          score: [100, 70, 40][compactions] ?? 10,
          detail: compactions === 0 ? "No compaction" : `${compactions} compaction${compactions > 1 ? "s" : ""}: earlier detail was summarized away`,
          wasteTokens: 0,
        },
        {
          kind: "duplicates",
          score: clamp(100 - count.duplicates * 10),
          detail: `${count.duplicates} identical tool calls repeated with no edit in between`,
          wasteTokens: waste.duplicates,
        },
      ].map((s) => ({ ...s, label: LABELS[s.kind] }));

      return summarize(signals, { peak, window, compactions });
    },
  };
}
