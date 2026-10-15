import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "../types";
import { tokensIn5h, sumTokens } from "./fleetStats";
import { windowStartFrom, type RateLimits } from "./rateLimits";

export const SPIKE_DELTA_THRESHOLD_PP = 4;   // amber banner
export const SPIKE_DELTA_CRITICAL_PP = 10;   // red banner
export const SPIKE_WINDOW_MIN = 5;
export const SAMPLE_INTERVAL_MS = 5_000;
export const BUFFER_LENGTH = Math.ceil((60 * 60_000) / SAMPLE_INTERVAL_MS); // 1 h of samples

export type Sample = {
  ts: number;
  fillPct: number;
  tokens5h: number;
  cost5h: number;
};

export type Spike = {
  id: string;
  detectedAt: number;
  fromMs: number;
  toMs: number;
  fromPct: number;
  toPct: number;
  deltaPct: number;
  deltaTokens: number;
  deltaCost: number;
  critical: boolean;
};

function makeSpike(prev: Sample, curr: Sample): Spike {
  const deltaPct = curr.fillPct - prev.fillPct;
  return {
    id: `${prev.ts}-${curr.ts}`,
    detectedAt: curr.ts,
    fromMs: prev.ts,
    toMs: curr.ts,
    fromPct: prev.fillPct,
    toPct: curr.fillPct,
    deltaPct,
    deltaTokens: Math.max(0, curr.tokens5h - prev.tokens5h),
    deltaCost: Math.max(0, curr.cost5h - prev.cost5h),
    critical: deltaPct * 100 >= SPIKE_DELTA_CRITICAL_PP,
  };
}

export type BurnState = {
  current: Sample | null;
  buffer: Sample[];
  activeSpike: Spike | null;
  dismissSpike: () => void;
};

// Sample closest to (but not after) SPIKE_WINDOW_MIN minutes before the latest one.
function baselineSample(buffer: Sample[]): Sample | null {
  const last = buffer[buffer.length - 1];
  const targetTs = last.ts - SPIKE_WINDOW_MIN * 60_000;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].ts <= targetTs) return buffer[i];
  }
  return null;
}

// Both ends of a spike slide every tick, so dismissal is time-based rather than id-based:
// a dismissed spike stays hidden for one window, unless it escalates to critical.
type Dismissal = { until: number; critical: boolean };

/** Samples the real 5h limit usage and flags fast climbs. Inactive until limits are connected. */
export function useBurnTracker(sessions: Session[], limits: RateLimits | null): BurnState {
  const sessionsRef = useRef(sessions);
  const limitsRef = useRef(limits);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { limitsRef.current = limits; }, [limits]);
  const enabled = !!limits?.claude?.fiveHour;

  const [buffer, setBuffer] = useState<Sample[]>([]);
  const [dismissal, setDismissal] = useState<Dismissal | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      const now = Date.now();
      const l = limitsRef.current;
      const five = l?.claude?.fiveHour;
      if (!five) return;
      const burn = tokensIn5h(sessionsRef.current, now, windowStartFrom(l));
      const sample: Sample = {
        ts: now,
        fillPct: five.usedPct / 100,
        tokens5h: sumTokens(burn.tokens),
        cost5h: burn.cost,
      };
      setBuffer((prev) => {
        const next = [...prev, sample];
        if (next.length > BUFFER_LENGTH) next.splice(0, next.length - BUFFER_LENGTH);
        return next;
      });
    }, SAMPLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled]);

  const dismissSpike = useCallback(() => {
    if (buffer.length < 2) return;
    const last = buffer[buffer.length - 1];
    const prev = baselineSample(buffer);
    if (!prev) return;
    const sp = makeSpike(prev, last);
    setDismissal({ until: last.ts + SPIKE_WINDOW_MIN * 60_000, critical: sp.critical });
  }, [buffer]);

  if (!enabled || buffer.length === 0) {
    return { current: null, buffer: [], activeSpike: null, dismissSpike };
  }

  const last = buffer[buffer.length - 1];
  const prev = baselineSample(buffer);
  let activeSpike: Spike | null = null;
  if (prev) {
    const deltaPp = (last.fillPct - prev.fillPct) * 100;
    if (deltaPp >= SPIKE_DELTA_THRESHOLD_PP) {
      const candidate = makeSpike(prev, last);
      const suppressed =
        dismissal !== null &&
        last.ts < dismissal.until &&
        (!candidate.critical || dismissal.critical);
      if (!suppressed) activeSpike = candidate;
    }
  }

  return { current: last, buffer, activeSpike, dismissSpike };
}
