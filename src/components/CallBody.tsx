import { useState } from "react";
import type { ToolCall } from "../types";
import { useCallDetail } from "../utils/callDetail";
import { inputFields } from "../utils/callInput";
import { formatBytes } from "../utils/format";

/**
 * An open call: its input field by field and its result, whole, fetched when the row opens. Until
 * then, and without a server, the preview the session's payload carries. "Raw JSON" shows the call
 * as the transcript wrote it, nothing reread.
 */
export function CallBody({ sessionId, entry }: { sessionId: string; entry: ToolCall }) {
  const { data, loading, failed } = useCallDetail(sessionId, entry.id, true);
  const isError = data ? data.isError : !!entry.result?.isError;
  const fields = data ? inputFields(data.input) : [];
  const [raw, setRaw] = useState(false);
  const hasRaw = data?.raw != null;
  return (
    <div className={`tool-seq-body ${loading ? "loading" : ""}`}>
      {hasRaw && (
        <div className="tool-seq-raw-toggle">
          <button className="link-btn mono" onClick={() => setRaw((v) => !v)} aria-pressed={raw}>
            {raw ? "Fields" : "Raw JSON"}
          </button>
        </div>
      )}
      {raw && hasRaw ? (
        <div className="tool-seq-field">
          <div className="tool-seq-field-key mono dim">as written in the transcript</div>
          <pre className="tool-seq-command tool-seq-raw mono">{JSON.stringify(data!.raw, null, 2)}</pre>
        </div>
      ) : data && fields.length > 0 ? (
        <div className="tool-seq-input">
          {fields.map((f) =>
            f.block ? (
              <div key={f.key} className="tool-seq-field">
                <div className="tool-seq-field-key mono dim">{f.key}</div>
                <pre className="tool-seq-command mono">{f.value}</pre>
              </div>
            ) : (
              <div key={f.key} className="tool-seq-field tool-seq-field-inline mono">
                <span className="tool-seq-field-key dim">{f.key}</span> {f.value}
              </div>
            ),
          )}
        </div>
      ) : (
        !data && <pre className="tool-seq-command mono">{entry.full ?? entry.preview}</pre>
      )}
      {data?.output ? (
        <div className="tool-seq-field">
          <div className="tool-seq-field-key mono dim">result{data.output.cut ? ` · first ${formatBytes(data.output.text.length)} of ${formatBytes(data.output.cut)}` : ""}</div>
          <pre className={`tool-seq-result mono ${isError ? "is-error" : ""}`}>{data.output.text || "(empty)"}</pre>
        </div>
      ) : (
        !data &&
        entry.result && (
          <pre className={`tool-seq-result mono ${isError ? "is-error" : ""}`}>
            {entry.result.text}
            {entry.result.truncated && <span className="dim"> …{failed ? "" : " loading the rest"}</span>}
          </pre>
        )
      )}
    </div>
  );
}
