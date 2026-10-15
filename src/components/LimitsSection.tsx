import type { Agent } from "../types";
import { useRateLimits } from "../utils/rateLimits";
import { useLiveContext } from "../utils/liveContext";
import { PROVIDER_LABELS } from "../utils/providers";

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Where each provider's plan usage comes from, plus a one-line fix when something is missing. */
export function LimitsSection({ providers }: { providers: Agent[] }) {
  const limits = useRateLimits();
  const contextLive = useLiveContext().length > 0;
  const claude = limits?.claude;
  const claudeOn = !!claude?.fiveHour || !!claude?.sevenDay;
  return (
    <>
      {providers.map((p) => {
        const l = limits?.[p];
        const on = p === "claude" ? claudeOn : !!l;
        const value = !on ? "off" : p === "claude" ? (l?.capturedAt ? `synced ${clock(l.capturedAt)}` : "connected") : l?.capturedAt ? `from its sessions · ${clock(l.capturedAt)}` : "from its sessions";
        return (
          <div key={p} className="profile-row">
            <span className="profile-row-label">{PROVIDER_LABELS[p]} {p === "copilot" ? "quota" : "limits"}</span>
            <span className="profile-row-value mono">
              <span className={`profile-dot ${on ? "ok" : "off"}`} aria-hidden="true" />
              {value}
            </span>
          </div>
        );
      })}
      {providers.includes("claude") && !claudeOn && (
        <p className="profile-hint">
          Run <code>/marey:limits</code> in Claude Code to show your real 5h and 7-day limits.
        </p>
      )}
      {claudeOn && !contextLive && (
        <p className="profile-hint">
          Context advice is waiting: re-run <code>/marey:limits</code>, then send a message.
        </p>
      )}
    </>
  );
}
