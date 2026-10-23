/**
 * Single source of truth for model names and public API pricing (Claude for
 * Claude Code, GPT for Codex), shared by the parser (Node) and the dashboard
 * (bundled by Vite).
 *
 * Prices are USD per million tokens (Anthropic and OpenAI first-party API
 * rates). Cache writes are derived from the input rate: 1.25x (5-minute TTL),
 * 2x (1-hour TTL). Cache reads vary by model, so they are listed. A row with
 * `longPrompt` bills a request whose prompt (input + cache reads + cache
 * writes) is over `over` tokens at that tier instead (Haiku 5.5).
 *
 * When Anthropic or OpenAI ships a model: add a row here. Unknown ids still get a
 * readable name (see normalizeModel) and the latest price of their family.
 */
export const MODELS = {
  "fable-5.1":  { label: "Fable 5.1",  in: 10, out: 50, cacheRead: 0.25 },
  "fable-5":    { label: "Fable 5",    in: 10, out: 50, cacheRead: 1 },
  "mythos-5.1": { label: "Mythos 5.1", in: 10, out: 50, cacheRead: 0.25 },
  "mythos-5":   { label: "Mythos 5",   in: 10, out: 50, cacheRead: 1 },
  "opus-5.5":   { label: "Opus 5.5",   in: 4,  out: 20, cacheRead: 0.2 },
  "opus-5":     { label: "Opus 5",     in: 5,  out: 25, cacheRead: 0.5 },
  "opus-4.8":   { label: "Opus 4.8",   in: 5,  out: 25, cacheRead: 0.5 },
  "opus-4.7":   { label: "Opus 4.7",   in: 5,  out: 25, cacheRead: 0.5 },
  "opus-4.6":   { label: "Opus 4.6",   in: 5,  out: 25, cacheRead: 0.5 },
  "opus-4.5":   { label: "Opus 4.5",   in: 5,  out: 25, cacheRead: 0.5 },
  "opus-4.1":   { label: "Opus 4.1",   in: 15, out: 75, cacheRead: 1.5 },
  "opus-4":     { label: "Opus 4",     in: 15, out: 75, cacheRead: 1.5 },
  "sonnet-5.5": { label: "Sonnet 5.5", in: 2,  out: 10, cacheRead: 0.1 },
  "sonnet-5":   { label: "Sonnet 5",   in: 2,  out: 10, cacheRead: 0.2 },
  "sonnet-4.6": { label: "Sonnet 4.6", in: 3,  out: 15, cacheRead: 0.3 },
  "sonnet-4.5": { label: "Sonnet 4.5", in: 3,  out: 15, cacheRead: 0.3 },
  "sonnet-4":   { label: "Sonnet 4",   in: 3,  out: 15, cacheRead: 0.3 },
  "haiku-5.5":  { label: "Haiku 5.5",  in: 0.1, out: 0.5, cacheRead: 0.01, longPrompt: { over: 100_000, in: 0.5, out: 2.5, cacheRead: 0.05 } },
  "haiku-4.5":  { label: "Haiku 4.5",  in: 1,  out: 5,  cacheRead: 0.1 },
  "haiku-3.5":  { label: "Haiku 3.5",  in: 0.8, out: 4, cacheRead: 0.08 },
  // Retired 3.x models (Sonnet 3.7 / 3.5, Opus 3, Haiku 3) have no published price any more:
  // they fall back to their family's latest, marked as an estimate.
  // OpenAI rows: developers.openai.com/api/docs/models/<id>. Prompts over 272k
  // input tokens and fast mode cost more; not modelled (no tier in rollouts).
  "gpt-6-astra":   { label: "GPT-6 Astra",   in: 10,  out: 50,  cacheRead: 1 },
  "gpt-6-sol":     { label: "GPT-6 Sol",     in: 2,   out: 10,  cacheRead: 0.2 },
  "gpt-6-luna":    { label: "GPT-6 Luna",    in: 0.1, out: 0.5, cacheRead: 0.01 },
  // Promotional price "at least through November 21, 2026"; list price is $5 / $30.
  "gpt-5.6-sol":   { label: "GPT-5.6 Sol",   in: 4,   out: 20,  cacheRead: 0.4 },
  "gpt-5.6-terra": { label: "GPT-5.6 Terra", in: 2,   out: 12,  cacheRead: 0.2 },
  "gpt-5.6-luna":  { label: "GPT-5.6 Luna",  in: 0.2, out: 1.2, cacheRead: 0.02 },
  "gpt-5.5":       { label: "GPT-5.5",       in: 5,   out: 30,  cacheRead: 0.5 },
  "gpt-5.4":       { label: "GPT-5.4",       in: 2.5, out: 15,  cacheRead: 0.25 },
};

const BUILTIN = Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, structuredClone(v)]));

export const DEFAULT_MODEL = "opus-5.5";

/** What Claude Code's bare aliases (`opus`, `sonnet[1m]`, …) resolve to today. */
const FAMILY_LATEST = {
  fable: "fable-5.1",
  mythos: "mythos-5.1",
  opus: "opus-5.5",
  sonnet: "sonnet-5.5",
  haiku: "haiku-5.5",
  gpt: "gpt-5.4",
  // Codex's internal models (codex-auto-review): priced like GPT, not like the default.
  codex: "gpt-5.4",
};

/**
 * `claude-opus-5-5[1m]` → `opus-5.5`, `claude-haiku-4-5-20251001` → `haiku-4.5`,
 * `opus[1m]` → `opus-5.5`, `claude-sonnet-4-0` → `sonnet-4`, and the 3.x order
 * `claude-3-7-sonnet-20250219` → `sonnet-3.7`. Returns null for non-model markers
 * like `<synthetic>`.
 */
export function normalizeModel(id) {
  if (!id || typeof id !== "string" || id.startsWith("<")) return null;
  const m = id.toLowerCase().replace(/^claude-/, "").replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
  if (FAMILY_LATEST[m]) return FAMILY_LATEST[m];
  const parts = m.match(/^([a-z]+)-(\d+)(?:-(\d+))?$/);
  const old = parts ? null : m.match(/^(\d+)(?:-(\d+))?-([a-z]+)$/);
  const [family, major, minor] = parts ? [parts[1], parts[2], parts[3]] : old ? [old[3], old[1], old[2]] : [];
  if (!family) return m;
  return minor && minor !== "0" ? `${family}-${major}.${minor}` : `${family}-${major}`;
}

/**
 * Replace user overrides (from ~/.claude/marey/models.json) on top of the
 * built-in table. Keys may be raw ids (`claude-opus-6`) or normalized
 * (`opus-6`); rows need numeric `in`, `out`, `cacheRead` ($/MTok) and an
 * optional `label`. Invalid rows are skipped. Returns the accepted rows.
 */
export function setModelOverrides(overrides) {
  for (const k of Object.keys(MODELS)) delete MODELS[k];
  for (const [k, v] of Object.entries(BUILTIN)) MODELS[k] = structuredClone(v);
  const accepted = {};
  if (!overrides || typeof overrides !== "object") return accepted;
  for (const [key, v] of Object.entries(overrides)) {
    const id = normalizeModel(key);
    const valid = v && [v.in, v.out, v.cacheRead].every((n) => typeof n === "number" && n >= 0);
    if (!id || key.startsWith("$") || !valid) continue;
    const label = typeof v.label === "string" && v.label ? v.label : modelLabel(id);
    MODELS[id] = accepted[id] = { label, in: v.in, out: v.out, cacheRead: v.cacheRead };
  }
  return accepted;
}

/** False when the model has no row and its cost is an estimate (family fallback). */
export function isKnownModel(model) {
  return !!model && Object.hasOwn(MODELS, model);
}

/** What a request's prompt counts for a `longPrompt` tier: its input, cache reads and cache writes. */
export function promptTokens(t) {
  return (t?.input ?? 0) + (t?.cacheRead ?? 0) + (t?.cacheWrite ?? 0);
}

/**
 * Per-token-kind prices ($/MTok). `cacheWrite` is the 5-minute rate. `prompt` is one request's prompt
 * size (`promptTokens`): past a model's `longPrompt.over`, that tier applies.
 */
export function priceFor(model, prompt = 0) {
  const row = MODELS[model] ?? MODELS[FAMILY_LATEST[String(model).split("-")[0]]] ?? MODELS[DEFAULT_MODEL];
  const p = row.longPrompt && prompt > row.longPrompt.over ? row.longPrompt : row;
  return { in: p.in, out: p.out, cacheRead: p.cacheRead, cacheWrite: p.in * 1.25, cacheWrite1h: p.in * 2 };
}

export function modelLabel(model) {
  if (!model) return "unknown";
  if (MODELS[model]) return MODELS[model].label;
  if (model.startsWith("gpt-")) return `GPT-${model.slice(4)}`;
  if (model.startsWith("codex-")) return `Codex ${model.slice(6).replace(/-/g, " ")}`;
  const [family, version] = model.split("-");
  return version ? `${family[0].toUpperCase()}${family.slice(1)} ${version}` : model;
}

/** Family key (`opus`, `sonnet`, …) for colour coding. */
export function modelFamily(model) {
  return String(model ?? "").split("-")[0];
}

/**
 * Cost in USD of one request's usage (a turn): a model with a `longPrompt` tier is priced from that
 * request's prompt size, so a sum of several requests must be priced turn by turn, or with `prompt`
 * 0 (the base tier) when there are no turns. Uses the 5m / 1h cache-write split when the token
 * bundle has it (`cacheWrite5m`, `cacheWrite1h`); any remainder is billed at the 5m rate.
 */
export function costOf(model, t, prompt = promptTokens(t)) {
  if (!t) return 0;
  const p = priceFor(model, prompt);
  const cw = t.cacheWrite ?? 0;
  const cw1h = Math.min(cw, t.cacheWrite1h ?? 0);
  return (
    ((t.input ?? 0) * p.in +
      (t.output ?? 0) * p.out +
      (t.cacheRead ?? 0) * p.cacheRead +
      (cw - cw1h) * p.cacheWrite +
      cw1h * p.cacheWrite1h) /
    1e6
  );
}
