/** A stretch of a chart's x domain, [from, to]. Pure, so the tests can import it. */
export type Span = [number, number];

/** `v` moved and shrunk to fit in `full`, and widened to at least `minSpan` (or the whole of `full`). */
export function clampSpan(v: Span, full: Span, minSpan: number): Span {
  const fullW = full[1] - full[0];
  const w = Math.min(fullW, Math.max(minSpan, v[1] - v[0]));
  let from = Math.min(Math.max(full[0], (v[0] + v[1]) / 2 - w / 2), full[1] - w);
  if (!Number.isFinite(from)) from = full[0];
  return [from, from + w];
}

/** `v` scaled by `factor` (below 1 zooms in) around `center`, which stays where it is. */
export function zoomAround(v: Span, center: number, factor: number, full: Span, minSpan: number): Span {
  const c = Math.min(Math.max(center, v[0]), v[1]);
  return clampSpan([c - (c - v[0]) * factor, c + (v[1] - c) * factor], full, minSpan);
}

/** `v` moved by `delta`, kept inside `full`. */
export function panBy(v: Span, delta: number, full: Span): Span {
  const w = v[1] - v[0];
  const from = Math.min(Math.max(full[0], v[0] + delta), full[1] - w);
  return [from, from + w];
}

/** Whether `v` shows less than the whole of `full`. */
export function isZoomed(v: Span, full: Span): boolean {
  return v[0] > full[0] + 1e-9 || v[1] < full[1] - 1e-9;
}
