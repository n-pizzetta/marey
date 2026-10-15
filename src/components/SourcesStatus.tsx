import type { SourceIssue } from "../utils/sourceIssues";

/** One status line ("All sources live · parsed 38s ago"), then only what needs a look, with its fix. */
export function SourcesStatus({ issues, parsedAgo }: { issues: SourceIssue[]; parsedAgo: string }) {
  const warn = issues.some((i) => i.level === "warn");
  return (
    <div className="profile-status-block">
      <div className="profile-status-line">
        <span className={`profile-dot ${warn ? "warn" : "ok"}`} aria-hidden="true" />
        <span>{warn ? "Some sources need a look" : "All sources live"}{parsedAgo ? ` · parsed ${parsedAgo}` : ""}</span>
      </div>
      {issues.map((i) => (
        <p key={i.key} className={`profile-issue ${i.level}`}>
          {i.text}
          {i.fix && <> {i.fix}</>}
        </p>
      ))}
    </div>
  );
}
