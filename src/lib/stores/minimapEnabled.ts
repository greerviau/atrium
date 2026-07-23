import { writable } from "svelte/store";

const STORAGE_KEY = "atrium.editor.minimapEnabled";

export const DEFAULT_MINIMAP_ENABLED = true;

/** Reads the persisted minimap-enabled flag. Falls back to the default on any missing/malformed data. */
export function loadMinimapEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_MINIMAP_ENABLED;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "boolean") {
      return DEFAULT_MINIMAP_ENABLED;
    }
    return parsed;
  } catch {
    return DEFAULT_MINIMAP_ENABLED;
  }
}

/** Persists the minimap-enabled flag. Swallows quota/availability errors since this is best-effort. */
export function saveMinimapEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    // localStorage unavailable or quota exceeded; the setting simply won't persist.
  }
}

export const minimapEnabled = writable<boolean>(loadMinimapEnabled());

export function setMinimapEnabled(enabled: boolean): void {
  minimapEnabled.set(enabled);
  saveMinimapEnabled(enabled);
}
