import { writable } from "svelte/store";
import { dirOf } from "../util/path";

/**
 * Path of the explorer row currently being dragged (via the app's private
 * EXPLORER_PATH_DRAG_TYPE), or null when no explorer-internal drag is in
 * progress. `dataTransfer.getData` is only readable at `drop`, not at
 * `dragover`/`dragenter` (per the HTML5 DnD spec) — but a dragover handler
 * still needs to know *which* path is being dragged, to decide whether the
 * row underneath is a valid move target and how to highlight it. This store,
 * set on dragstart and cleared on dragend, is what makes that possible for a
 * same-document drag.
 */
export const draggingPath = writable<string | null>(null);

/**
 * True if dropping `sourcePath` onto `targetDir` is a move worth performing:
 * not onto itself, not onto one of its own descendants, and not onto the
 * directory it's already directly inside (a no-op today, not an implicit
 * move). Also correctly rejects moving the workspace root anywhere, without
 * special-casing it: every other directory in the tree is either the root
 * itself or one of its descendants, both already excluded.
 */
export function isValidMoveTarget(sourcePath: string, targetDir: string): boolean {
  if (targetDir === sourcePath) return false;
  if (targetDir.startsWith(`${sourcePath}/`)) return false;
  if (targetDir === dirOf(sourcePath)) return false;
  return true;
}
