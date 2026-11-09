export type ModelPrice = { in: number; out: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number };
export type CostTokens = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
};

export type ModelRow = { label: string; in: number; out: number; cacheRead: number; window?: number; longPrompt?: { over: number; in: number; out: number; cacheRead: number } };

export const MODELS: Record<string, ModelRow>;
export const DEFAULT_MODEL: string;
export function setModelOverrides(overrides: unknown): Record<string, { label: string; in: number; out: number; cacheRead: number; window?: number }>;
export function isKnownModel(model: string | null | undefined): boolean;
export function withSpeed<T extends string | null | undefined>(model: T, speed: unknown): T | string;
export function baseModel(model: string | null | undefined): string;
export function contextWindowOf(model: string | null | undefined): number | null;
export function normalizeModel(id: string | null | undefined): string | null;
export function promptTokens(t: CostTokens | null | undefined): number;
export function priceFor(model: string, prompt?: number): ModelPrice;
export function modelLabel(model: string | null | undefined): string;
export function modelFamily(model: string | null | undefined): string;
export function costOf(model: string, t: CostTokens | null | undefined, prompt?: number): number;
