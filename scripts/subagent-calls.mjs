/**
 * Sub-agent tool calls, nested under the main-thread call that started the sub-agent (Claude Code's
 * Agent / Task, Codex's spawn_agent), so a session's tool calls are listed once each, sub-agents
 * included, and add up to its tool counts.
 *
 * Pure and dependency-free: used by the parser, and by tests.
 */

export const SUBAGENT_TOOLS = new Set(["Agent", "Task", "spawn_agent"]);

/** Within this, a sub-agent's first event counts as started by a call (clock skew between files). */
const START_SLACK_MS = 2_000;

const norm = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/** The call's prompt (full when it was cut for the preview) starts like the sub-agent's first message, or the reverse. */
function samePrompt(entry, prompt) {
  const a = norm(entry.full ?? entry.preview);
  if (!a || !prompt) return false;
  return a.length <= prompt.length ? prompt.startsWith(a) : a.startsWith(prompt);
}

/**
 * @param {Array<{ t: number, tool: string, preview: string, full?: string, agentId?: string }>} main
 *   main-thread calls in time order, `agentId` when the call's result named the sub-agent it ran
 * @param {Array<{ agentId?: string | null, prompt?: string | null, description?: string | null, firstT: number, label?: string | null, calls: object[] }>} subs
 *   one per sub-agent transcript: its id, its first message, the description it was given, its first
 *   event, a label, its calls
 * @returns the main calls, each sub-agent's calls in `children` of the call that started it, with the
 *   sub-agent's id in `subagentId`. A sub-agent no call can be found for gets a row of its own,
 *   `orphan: true`, which is not a call itself.
 */
export function nestSubagentCalls(main, subs) {
  const out = main.map((e) => ({ ...e }));
  const starters = out.filter((e) => SUBAGENT_TOOLS.has(e.tool));
  const taken = new Set();
  const latestBefore = (t, ok) => {
    for (let i = starters.length - 1; i >= 0; i--) {
      const e = starters[i];
      if (!taken.has(e) && e.t <= t + START_SLACK_MS && ok(e)) return e;
    }
    return undefined;
  };
  // 1. the id Claude Code writes in the call's result, for every sub-agent first, so none takes another's call;
  // then 2. the prompt it was given, 3. its description (a call the plugin hook captured has no id, and its
  // input as JSON for preview), 4. the last call before it started
  const byId = new Map();
  for (const sub of subs) {
    const e = sub.agentId && starters.find((s) => s.agentId === sub.agentId && !taken.has(s));
    if (e) {
      taken.add(e);
      byId.set(sub, e);
    }
  }
  for (const sub of [...subs].sort((a, b) => a.firstT - b.firstT)) {
    const prompt = norm(sub.prompt);
    const described = norm(sub.description);
    const calls = sub.calls.map((c) => {
      const copy = { ...c };
      delete copy.agentId;
      return copy;
    });
    const parent =
      byId.get(sub) ||
      (prompt && latestBefore(sub.firstT, (e) => samePrompt(e, prompt))) ||
      (described && latestBefore(sub.firstT, (e) => norm(e.full ?? e.preview).includes(described))) ||
      latestBefore(sub.firstT, () => true);
    const id = sub.agentId ? { subagentId: sub.agentId } : {};
    if (parent) {
      taken.add(parent);
      parent.children = calls;
      Object.assign(parent, id);
      if (sub.label) parent.agentLabel = sub.label;
    } else {
      out.push({ t: sub.firstT, tool: "Agent", preview: sub.label || prompt.slice(0, 160) || "Sub-agent", orphan: true, children: calls, ...id });
    }
  }
  out.sort((a, b) => a.t - b.t);
  for (const e of out) delete e.agentId;
  return out;
}

/** Tool calls in a nested sequence: every row but an orphan's, plus every sub-agent call. */
export function countNestedCalls(seq) {
  let n = 0;
  for (const e of seq) n += (e.orphan ? 0 : 1) + (e.children?.length ?? 0);
  return n;
}
