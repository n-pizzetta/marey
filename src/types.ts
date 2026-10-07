export type Outcome = "fully_achieved" | "mostly_achieved" | "partially_achieved" | "not_achieved" | "in_progress" | "unknown";

export type GhostKind = "empty" | "crashed";

/** Coding agent that wrote the session: Claude Code (~/.claude) or Codex (~/.codex). */
export type Agent = "claude" | "codex";

export type FrictionKind =
  | "wrong_approach"
  | "buggy_code"
  | "missing_context"
  | "tool_error"
  | "user_interruption";

export interface Friction {
  kind: FrictionKind;
  at: number;
  detail: string;
}

/** Any Claude Code tool name; MCP tools are grouped per server as `mcp:<server>`. */
export type ToolName = string;

export interface TimelineEvent {
  t: number;
  kind: "prompt" | "tool" | "friction" | "commit" | "agent";
  tool?: ToolName;
  label: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface QualitySignal {
  kind: string;
  label: string;
  score: number;
  detail: string;
  wasteTokens: number;
}

export interface SessionQuality {
  score: number;
  grade: string;
  fillPct: number | null;
  band: string | null;
  wasteTokens: number;
  /** Number of /compact (manual or auto) in the session. */
  compactions?: number;
  signals: QualitySignal[];
}

export interface ToolCall {
  t: number;
  tool: string;
  preview: string;
  full?: string;
  result?: { text: string; truncated: boolean; isError: boolean; bytes?: number };
  source?: "plugin";
  /** Calls made by the sub-agent this call started (Agent / Task / spawn_agent). */
  children?: ToolCall[];
  /** The sub-agent's type and description, when Claude Code wrote them. */
  agentLabel?: string;
  /** A sub-agent whose starting call wasn't found: this row stands for it and is not a call itself. */
  orphan?: boolean;
}

/** needs-you: an open question, plan or permission prompt; your-turn: done, waiting for a prompt; working: busy. */
export interface LiveState {
  state: "needs-you" | "your-turn" | "working";
  reason?: "question" | "plan" | "permission";
  /** The question, the plan's title, the call to allow or in progress, or the start of the last reply. */
  text: string | null;
  since: string;
}

export interface Session {
  id: string;
  /** Absent in mock data and older payloads: Claude Code. */
  agent?: Agent;
  project: string;
  cwd: string;
  startedAt: string;
  /** Active time: each gap between transcript events counts for at most 5 min. */
  durationMs: number;
  /** Longest stretch of main-thread activity with no pause over 15 min: how long someone worked in one go. */
  longestRunMs?: number;
  /** Wall-clock span from the first to the last event (or now, while live). */
  wallMs?: number;
  /** Normalized id, e.g. `opus-5.5` (see scripts/models.mjs). */
  model: string;
  /** Tokens and cost per model, set by scopeToRange for aggregate views. */
  modelUsage?: Record<string, { tokens: number; cost: number }>;
  /** Models used without a pricing row: cost is an estimate. */
  unpricedModels?: string[];
  outcome: Outcome;
  satisfaction: number;
  goal: string;
  summary: string;
  messages: number;
  toolCounts: Record<ToolName, number>;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
  };
  costUsd: number;
  baselineCostUsd?: number;
  frictions: Friction[];
  timeline: TimelineEvent[];
  subAgents: number;
  filesChanged: number;
  commits: number;
  /** Bash commands by kind (main thread only); detail payload only, used for badges. */
  shell?: { prs: number; tests: number; lints: number; infra: number };
  live?: boolean;
  ghost?: boolean;
  ghostKind?: GhostKind;
  /** The transcript is gone: numbers come from /insights session-meta (no cache tokens). */
  transcriptMissing?: boolean;
  lastEventAt?: string;
  /** Claude Code or Codex CLI version from the transcript (last seen). */
  version?: string;
  /** Context window reported by the agent (Codex only); else inferred from the peak. */
  contextWindow?: number;
  /** Running sessions: when the Claude Code process started (pid file). */
  processStartedAt?: string;
  runningTool?: { tool: string; preview: string; t: number } | null;
  /** Running sessions: what the session needs from the user (scripts/parse-sessions.mjs, liveStateOf). */
  liveState?: LiveState | null;
  /** Running Claude Code sessions: the name Claude Code gives them (pid file). */
  liveName?: string;
  clearedFrom?: string;
  clearedInto?: string;
  quality?: SessionQuality | null;
  fileHistory?: Array<{ hash: string; versions: number[]; path?: string }>;
  prompts?: Array<{ t: number; text: string; preview: string }>;
  /** Main-thread calls in order; a call that started a sub-agent holds that sub-agent's calls in `children`. */
  toolSequence?: ToolCall[];
  pluginCapture?: {
    entries: number;
    lastEventAt: string;
    stoppedAt: string | null;
  } | null;
  turns?: Array<{
    t: number;
    /** Model of this turn (sessions can switch models). */
    model?: string;
    /** Turn made by a sub-agent (from <session>/subagents/*.jsonl). */
    sidechain?: boolean;
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cacheWrite5m?: number;
      cacheWrite1h?: number;
    };
    tools: string[];
    promptIdx?: number;
    inBytes?: number;
    outBytes?: number;
    inPreview?: string;
    outPreview?: string;
  }>;
}
