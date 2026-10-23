import type { Session } from "../types";
import { priceFor, promptTokens, type ModelPrice } from "../../scripts/models.mjs";

export type KindCost = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Cache writes at the 5-minute rate, except the 1-hour share (2x input) when known. */
export function cacheWriteCost(p: ModelPrice, t: { cacheWrite: number; cacheWrite1h?: number }) {
  const oneHour = Math.min(t.cacheWrite, t.cacheWrite1h ?? 0);
  return ((t.cacheWrite - oneHour) * p.cacheWrite + oneHour * p.cacheWrite1h) / 1e6;
}

/**
 * API value per token kind of one request (a turn), at its prompt's tier. For a sum of requests
 * priced as one, pass `prompt` 0: the base tier.
 */
export function costPerKind(model: string, tokens: Session["tokens"], prompt = promptTokens(tokens)): KindCost {
  const p = priceFor(model, prompt);
  return {
    input: (tokens.input / 1e6) * p.in,
    output: (tokens.output / 1e6) * p.out,
    cacheRead: (tokens.cacheRead / 1e6) * p.cacheRead,
    cacheWrite: cacheWriteCost(p, tokens),
  };
}

export function addKindCost(a: KindCost, b: KindCost): KindCost {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

export const ZERO_KIND_COST: KindCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Per-kind cost priced turn by turn with each turn's model, so it adds up to costUsd. */
export function sessionCostPerKind(session: Session): KindCost {
  if (!session.turns?.length) return costPerKind(session.model, session.tokens, 0);
  return session.turns.reduce((acc, t) => addKindCost(acc, costPerKind(t.model ?? session.model, t.tokens)), ZERO_KIND_COST);
}
