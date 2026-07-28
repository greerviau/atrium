import { writable } from "svelte/store";

const STORAGE_KEY = "atrium.markdown.defaultView";

export type MarkdownDefaultView = "rendered" | "source";

export const DEFAULT_MARKDOWN_VIEW: MarkdownDefaultView = "rendered";

/** Reads the persisted default markdown view mode. Falls back to the default on any missing/malformed data. */
export function loadMarkdownDefaultView(): MarkdownDefaultView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_MARKDOWN_VIEW;
    const parsed = JSON.parse(raw);
    if (parsed !== "rendered" && parsed !== "source") {
      return DEFAULT_MARKDOWN_VIEW;
    }
    return parsed;
  } catch {
    return DEFAULT_MARKDOWN_VIEW;
  }
}

/** Persists the default markdown view mode. Swallows quota/availability errors since this is best-effort. */
export function saveMarkdownDefaultView(view: MarkdownDefaultView): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // localStorage unavailable or quota exceeded; the setting simply won't persist.
  }
}

export const markdownDefaultView = writable<MarkdownDefaultView>(loadMarkdownDefaultView());

export function setMarkdownDefaultView(view: MarkdownDefaultView): void {
  markdownDefaultView.set(view);
  saveMarkdownDefaultView(view);
}
