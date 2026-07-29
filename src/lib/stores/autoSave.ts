import { writable } from "svelte/store";

const STORAGE_KEY = "atrium.editor.autoSaveEnabled";

export const DEFAULT_AUTO_SAVE_ENABLED = false;
export const AUTO_SAVE_DELAY_MS = 1000;

/** Reads the persisted auto-save flag. Falls back to the default on any missing/malformed data. */
export function loadAutoSaveEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AUTO_SAVE_ENABLED;
    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : DEFAULT_AUTO_SAVE_ENABLED;
  } catch {
    return DEFAULT_AUTO_SAVE_ENABLED;
  }
}

/** Persists the auto-save flag. Swallows quota/availability errors since this is best-effort. */
export function saveAutoSaveEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    // localStorage unavailable or quota exceeded; the setting simply won't persist.
  }
}

export const autoSaveEnabled = writable<boolean>(loadAutoSaveEnabled());

export function setAutoSaveEnabled(enabled: boolean): void {
  autoSaveEnabled.set(enabled);
  saveAutoSaveEnabled(enabled);
}

/**
 * Paths for which the most recent auto-save attempt failed. Auto-save must
 * not re-arm for a path in this set until an explicit save for that same
 * path succeeds (see EditorPane.svelte's save-request effect, the one place
 * every save — manual or auto-triggered — actually lands) — otherwise a
 * persistent failure (read-only file, stale external grant) would retry and
 * re-toast on every debounce window indefinitely. Not persisted: it exists
 * only for the lifetime of the failure, and a fresh app launch should not
 * carry over a stale block.
 *
 * Known accepted limitation: no eviction on tab close. If a tab is closed
 * while blocked and the same path is reopened later, it stays blocked until
 * an explicit save for that path succeeds again. This is a narrow,
 * self-correcting edge case (one manual save clears it) and not worth the
 * added complexity of wiring tab-close cleanup for it.
 */
const blockedPaths = new Set<string>();

export function isAutoSaveBlocked(path: string): boolean {
  return blockedPaths.has(path);
}

export function blockAutoSave(path: string): void {
  blockedPaths.add(path);
}

export function unblockAutoSave(path: string): void {
  blockedPaths.delete(path);
}
