export const TOAST_EVENT = "marey:toast";

export type ToastDetail = { kind: "error"; message: string };

function dispatch(detail: ToastDetail) {
  window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail }));
}

export function toastError(message: string) {
  dispatch({ kind: "error", message });
}
