/**
 * A tool call's input, field by field, for the Tools tab: the text an agent wrote (a command, a
 * prompt, the old and new text of an edit, a file's content) as a block of its own, short values
 * on one line each.
 */

export interface InputField {
  key: string;
  value: string;
  /** Shown as a block: the field holds text to read, not a short value. */
  block: boolean;
}

/** Fields that hold what the call is about: always a block, even on one line. */
const TEXT_KEYS = new Set(["command", "cmd", "prompt", "content", "old_string", "new_string", "patch", "script", "plan", "code", "task", "message", "body", "text"]);
const SHORT = 100;

export function inputFields(input: unknown): InputField[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== "object" || Array.isArray(input)) return [{ key: "input", value: format(input), block: true }];
  const out: InputField[] = [];
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined || v === null || v === "") continue;
    const value = format(v);
    const block = typeof v === "object" || TEXT_KEYS.has(key) || value.includes("\n") || value.length > SHORT;
    out.push({ key, value, block });
  }
  return out;
}

function format(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}
