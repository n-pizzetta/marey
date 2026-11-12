// A call's input in the Tools tab, field by field (src/utils/callInput.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { inputFields } from "../src/utils/callInput.ts";

test("an edit shows its path on one line and its old and new text as blocks", () => {
  const fields = inputFields({ file_path: "/repo/a.ts", old_string: "x", new_string: "y\nz", replace_all: false });
  assert.deepEqual(fields, [
    { key: "file_path", value: "/repo/a.ts", block: false },
    { key: "old_string", value: "x", block: true },
    { key: "new_string", value: "y\nz", block: true },
    { key: "replace_all", value: "false", block: false },
  ]);
});

test("a command is a block even on one line; empty values are left out; objects are JSON", () => {
  assert.deepEqual(inputFields({ command: "git status", description: "", timeout: null }), [{ key: "command", value: "git status", block: true }]);
  assert.deepEqual(inputFields({ questions: [{ q: "a" }] }), [{ key: "questions", value: '[\n  {\n    "q": "a"\n  }\n]', block: true }]);
  assert.deepEqual(inputFields("raw"), [{ key: "input", value: "raw", block: true }]);
  assert.deepEqual(inputFields(undefined), []);
});
