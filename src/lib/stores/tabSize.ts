import { writable } from "svelte/store";

const STORAGE_KEY = "atrium.editor.tabSize";

export const TAB_SIZE_OPTIONS = [2, 4, 8] as const;
export type TabSize = (typeof TAB_SIZE_OPTIONS)[number];
export const DEFAULT_TAB_SIZE: TabSize = 2;

function isTabSize(value: unknown): value is TabSize {
  return typeof value === "number" && (TAB_SIZE_OPTIONS as readonly number[]).includes(value);
}

/** Reads the persisted tab-size value. Falls back to the default on any missing/malformed/out-of-set data. */
export function loadTabSize(): TabSize {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TAB_SIZE;
    const parsed = JSON.parse(raw);
    return isTabSize(parsed) ? parsed : DEFAULT_TAB_SIZE;
  } catch {
    return DEFAULT_TAB_SIZE;
  }
}

/** Persists the tab-size value. Swallows quota/availability errors since this is best-effort. */
export function saveTabSize(size: TabSize): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
  } catch {
    // localStorage unavailable or quota exceeded; the setting simply won't persist.
  }
}

export const tabSize = writable<TabSize>(loadTabSize());

export function setTabSize(size: TabSize): void {
  tabSize.set(size);
  saveTabSize(size);
}
