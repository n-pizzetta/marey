import { useCallback, useEffect, useRef, useState } from "react";
import { TOAST_EVENT, type ToastDetail } from "../utils/toast";
import { useDocumentVisible } from "../utils/visibility";

type Toast = ToastDetail & { id: number };

let nextId = 1;
const LIFETIME_MS = 6000;

/** The live region stays mounted so screen readers announce the first toast too. */
export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      setToasts((t) => [...t, { ...detail, id: nextId++ }]);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((x) => x.id !== id)), []);
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => <ToastItem key={t.id} toast={t} onDismiss={dismiss} />)}
    </div>
  );
}

/** Dismisses itself after its lifetime, paused while hovered, focused or in a background tab. */
function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  const visible = useDocumentVisible();
  const remaining = useRef(LIFETIME_MS);
  useEffect(() => {
    if (held || !visible) return;
    const start = Date.now();
    const timer = setTimeout(() => onDismiss(t.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - start;
    };
  }, [held, visible, onDismiss, t.id]);

  const hold = {
    onMouseEnter: () => setHeld(true),
    onMouseLeave: () => setHeld(false),
    onFocus: () => setHeld(true),
    onBlur: () => setHeld(false),
  };
  const close = <button className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>✕</button>;

  return (
    <div className="toast" {...hold}>
      <span>{t.message}</span>
      {close}
    </div>
  );
}
