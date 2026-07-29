import { writable } from "svelte/store";

const STORAGE_KEY = "atrium.editor.lineNumbersEnabled";

export const DEFAULT_LINE_NUMBERS_ENABLED = true;

/** Reads the persisted line-numbers flag. Falls back to the default on any missing/malformed data. */
export function loadLineNumbersEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LINE_NUMBERS_ENABLED;
    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : DEFAULT_LINE_NUMBERS_ENABLED;
  } catch {
    return DEFAULT_LINE_NUMBERS_ENABLED;
  }
}

/** Persists the line-numbers flag. Swallows quota/availability errors since this is best-effort. */
export function saveLineNumbersEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    // localStorage unavailable or quota exceeded; the setting simply won't persist.
  }
}

export const lineNumbersEnabled = writable<boolean>(loadLineNumbersEnabled());

export function setLineNumbersEnabled(enabled: boolean): void {
  lineNumbersEnabled.set(enabled);
  saveLineNumbersEnabled(enabled);
}
