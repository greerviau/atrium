import { writable } from "svelte/store";

const STORAGE_KEY = "atrium.editor.wordWrapEnabled";

export const DEFAULT_WORD_WRAP_ENABLED = false;

/** Reads the persisted word-wrap flag. Falls back to the default on any missing/malformed data. */
export function loadWordWrapEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WORD_WRAP_ENABLED;
    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : DEFAULT_WORD_WRAP_ENABLED;
  } catch {
    return DEFAULT_WORD_WRAP_ENABLED;
  }
}

/** Persists the word-wrap flag. Swallows quota/availability errors since this is best-effort. */
export function saveWordWrapEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    // localStorage unavailable or quota exceeded; the setting simply won't persist.
  }
}

export const wordWrapEnabled = writable<boolean>(loadWordWrapEnabled());

export function setWordWrapEnabled(enabled: boolean): void {
  wordWrapEnabled.set(enabled);
  saveWordWrapEnabled(enabled);
}
