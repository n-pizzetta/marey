import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { clampSpan, isZoomed, panBy, zoomAround, type Span } from "./zoomRange";

/** Pixels a press must move before it is a drag rather than a click. */
const DRAG_PX = 4;

/**
 * The stretch of `full` a chart shows, zoomed in or not. `minSpan`: the narrowest stretch it zooms to.
 * A running session's `full` grows: a zoomed view stays where it is, the whole view follows. A zoom
 * belongs to its `resetKey` (the Usage range): another key shows the whole chart again.
 */
export function useZoomView(full: Span, minSpan: number, resetKey: string = "") {
  const [state, setState] = useState<{ view: Span; key: string } | null>(null);
  const view = state?.key === resetKey ? state.view : null;
  const shown = view ? clampSpan(view, full, minSpan) : full;
  const zoomed = view !== null && isZoomed(shown, full);
  const set = (v: Span) => setState({ view: v, key: resetKey });
  return {
    view: shown,
    zoomed,
    zoomTo: (a: number, b: number) => set(clampSpan([Math.min(a, b), Math.max(a, b)], full, minSpan)),
    zoomAround: (center: number, factor: number) => set(zoomAround(shown, center, factor, full, minSpan)),
    pan: (delta: number) => set(panBy(shown, delta, full)),
    reset: () => setState(null),
  };
}

type Zoom = ReturnType<typeof useZoomView>;

/**
 * The gestures of a zoomable chart, on the element `ref` points to: drag across it to zoom on a
 * stretch, pinch (or ctrl / ⌘ + wheel) to zoom around the pointer, swipe sideways to pan once zoomed,
 * double-click to zoom out. `plot` gives the plotting area's left edge and width in client pixels. A
 * press that doesn't move stays a click, so bars and markers keep theirs. `sel`: the stretch being
 * dragged, as fractions of the plot's width (0 at its left edge, 1 at its right).
 */
export function useZoomGestures<T extends HTMLElement | SVGElement>(ref: RefObject<T | null>, zoom: Zoom, plot: () => { left: number; width: number } | null) {
  const [sel, setSel] = useState<{ f0: number; f1: number } | null>(null);
  const press = useRef<{ x: number; id: number; dragging: boolean } | null>(null);
  // the wheel listener outlives renders: it reads the latest view and plot from here
  const latest = useRef({ zoom, plot });
  useEffect(() => {
    latest.current = { zoom, plot };
  });

  const toDomain = (clientX: number): number | null => {
    const p = plot();
    if (!p || p.width <= 0) return null;
    const f = Math.min(1, Math.max(0, (clientX - p.left) / p.width));
    return zoom.view[0] + f * (zoom.view[1] - zoom.view[0]);
  };

  // Attached to whichever element `ref` holds after each render: a chart can appear later (a running
  // session's first prompts) or be replaced.
  const attached = useRef<{ el: T; off: () => void } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (attached.current?.el === el) return;
    attached.current?.off();
    attached.current = null;
    if (!el) return;
    const onWheel = (e: Event) => {
      const w = e as WheelEvent;
      const { zoom: z, plot: getPlot } = latest.current;
      const p = getPlot();
      if (!p || p.width <= 0) return;
      const span = z.view[1] - z.view[0];
      if (w.ctrlKey || w.metaKey) {
        // a trackpad pinch arrives as a wheel with ctrlKey
        w.preventDefault();
        const center = z.view[0] + Math.min(1, Math.max(0, (w.clientX - p.left) / p.width)) * span;
        z.zoomAround(center, Math.exp(w.deltaY * 0.01));
      } else if (z.zoomed && Math.abs(w.deltaX) > Math.abs(w.deltaY)) {
        w.preventDefault();
        z.pan((w.deltaX / p.width) * span);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    attached.current = { el, off: () => el.removeEventListener("wheel", onWheel) };
  });
  useEffect(
    () => () => {
      attached.current?.off();
      attached.current = null;
    },
    [],
  );

  const fraction = (clientX: number) => {
    const p = plot();
    return p && p.width > 0 ? Math.min(1, Math.max(0, (clientX - p.left) / p.width)) : 0;
  };
  const handlers = {
    onPointerDown: (e: ReactPointerEvent<T>) => {
      if (e.button !== 0) return;
      press.current = { x: e.clientX, id: e.pointerId, dragging: false };
    },
    onPointerMove: (e: ReactPointerEvent<T>) => {
      const p = press.current;
      if (!p) return;
      if (!p.dragging && Math.abs(e.clientX - p.x) < DRAG_PX) return;
      if (!p.dragging) {
        p.dragging = true;
        e.currentTarget.setPointerCapture(p.id);
      }
      setSel({ f0: fraction(p.x), f1: fraction(e.clientX) });
    },
    onPointerUp: (e: ReactPointerEvent<T>) => {
      const p = press.current;
      press.current = null;
      setSel(null);
      if (!p?.dragging) return;
      const a = toDomain(p.x);
      const b = toDomain(e.clientX);
      if (a !== null && b !== null && a !== b) zoom.zoomTo(a, b);
    },
    onPointerCancel: () => {
      press.current = null;
      setSel(null);
    },
    onDoubleClick: () => zoom.reset(),
  };
  return { sel, handlers };
}
