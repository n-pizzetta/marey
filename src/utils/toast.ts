export const TOAST_EVENT = "marey:toast";

/** A badge unlock or a level-up: tinted with the tier color, with an optional action. */
export interface Achievement {
  icon: string;
  title: string;
  sub?: string;
  /** Badge tier color; "level" for a level-up. */
  tone: "bronze" | "silver" | "gold" | "platinum" | "level";
  action?: { label: string; run: () => void };
}

export type ToastDetail = { kind: "error"; message: string } | ({ kind: "achievement" } & Achievement);

function dispatch(detail: ToastDetail) {
  window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail }));
}

export function toastError(message: string) {
  dispatch({ kind: "error", message });
}

export function toastAchievement(a: Achievement) {
  dispatch({ kind: "achievement", ...a });
}
