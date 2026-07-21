import { writable } from "svelte/store";

const STORAGE_KEY = "atrium.textSize.zoom";

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.0;
export const ZOOM_STEP = 0.1;
export const DEFAULT_ZOOM = 1.0;

/** Clamps to [MIN_ZOOM, MAX_ZOOM] and rounds to one decimal place to avoid float drift from repeated ZOOM_STEP additions. */
export function clampZoom(zoom: number): number {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  return Math.round(clamped * 10) / 10;
}

/** Reads the persisted zoom level, validating shape and clamping. Falls back to the default zoom on any missing/malformed data. */
export function loadZoom(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ZOOM;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
      return DEFAULT_ZOOM;
    }
    return clampZoom(parsed);
  } catch {
    return DEFAULT_ZOOM;
  }
}

/** Persists the zoom level. Swallows quota/availability errors since zoom persistence is best-effort. */
export function saveZoom(zoom: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(zoom));
  } catch {
    // localStorage unavailable or quota exceeded; zoom simply won't persist.
  }
}

export const zoom = writable<number>(loadZoom());

export function zoomIn(): void {
  zoom.update((z) => {
    const next = clampZoom(z + ZOOM_STEP);
    saveZoom(next);
    return next;
  });
}

export function zoomOut(): void {
  zoom.update((z) => {
    const next = clampZoom(z - ZOOM_STEP);
    saveZoom(next);
    return next;
  });
}

export function resetZoom(): void {
  zoom.set(DEFAULT_ZOOM);
  saveZoom(DEFAULT_ZOOM);
}
