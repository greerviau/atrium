import { writable } from "svelte/store";

const STORAGE_KEY = "atrium.general.restoreTabsOnStartup";

export const DEFAULT_RESTORE_TABS_ON_STARTUP = true;

/** Reads the persisted restore-on-startup flag. Falls back to the default on any missing/malformed data. */
export function loadRestoreTabsOnStartup(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RESTORE_TABS_ON_STARTUP;
    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : DEFAULT_RESTORE_TABS_ON_STARTUP;
  } catch {
    return DEFAULT_RESTORE_TABS_ON_STARTUP;
  }
}

/** Persists the restore-on-startup flag. Swallows quota/availability errors since this is best-effort. */
export function saveRestoreTabsOnStartup(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    // localStorage unavailable or quota exceeded; the setting simply won't persist.
  }
}

export const restoreTabsOnStartup = writable<boolean>(loadRestoreTabsOnStartup());

export function setRestoreTabsOnStartup(enabled: boolean): void {
  restoreTabsOnStartup.set(enabled);
  saveRestoreTabsOnStartup(enabled);
}
