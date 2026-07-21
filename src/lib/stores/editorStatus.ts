import { writable } from "svelte/store";

export interface CursorPosition {
  line: number;
  col: number;
  /** Extent of a non-empty selection; `null` for a plain caret. */
  selection: { lines: number; chars: number } | null;
}

/**
 * Live cursor/selection position for the active tab's editor pane, per the
 * status-bar spec (section 4.4). `null` when no tab is active.
 */
export const cursorPosition = writable<CursorPosition | null>(null);

export function setCursorPosition(pos: CursorPosition): void {
  cursorPosition.set(pos);
}

export function clearCursorPosition(): void {
  cursorPosition.set(null);
}
