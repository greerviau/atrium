import { writable } from "svelte/store";

const STORAGE_KEY = "atrium.markdown.proseWidth";

// The narrowest preset (60) must stay above the 54ch a 3-column narrow table
// can demand without wrapping — see MAX_NARROW_COLUMNS's docstring in
// editor/markdown/decorations.ts. Don't add a preset below 60 without
// re-checking that invariant.
export const PROSE_WIDTH_OPTIONS = [60, 80, 100, 120, "full"] as const;
export type ProseWidth = (typeof PROSE_WIDTH_OPTIONS)[number];
export const DEFAULT_PROSE_WIDTH: ProseWidth = 80;

function isProseWidth(value: unknown): value is ProseWidth {
  return (PROSE_WIDTH_OPTIONS as readonly unknown[]).includes(value);
}

/** Reads the persisted max-width preset. Falls back to the default on any missing/malformed/out-of-set data. */
export function loadProseWidth(): ProseWidth {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PROSE_WIDTH;
    const parsed = JSON.parse(raw);
    return isProseWidth(parsed) ? parsed : DEFAULT_PROSE_WIDTH;
  } catch {
    return DEFAULT_PROSE_WIDTH;
  }
}

/** Persists the max-width preset. Swallows quota/availability errors since this is best-effort. */
export function saveProseWidth(width: ProseWidth): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(width));
  } catch {
    // localStorage unavailable or quota exceeded; the setting simply won't persist.
  }
}

export const proseWidth = writable<ProseWidth>(loadProseWidth());

export function setProseWidth(width: ProseWidth): void {
  proseWidth.set(width);
  saveProseWidth(width);
}

/**
 * The `--atrium-prose-max-width` value for a preset. `"full"` maps to
 * `100cqw`, not a large `ch` number, so it stays genuinely uncapped across
 * the full zoom range — a `ch` figure scales with zoom (issue #70), so no
 * fixed `ch` ceiling is ever truly "unlimited".
 */
export function proseWidthCssValue(width: ProseWidth): string {
  return width === "full" ? "100cqw" : `${width}ch`;
}
