import { get } from "svelte/store";
import { fileTree } from "../stores/fileTree";
import { dirOf } from "../util/path";

/**
 * Hit-tests a viewport point against the explorer and resolves it to the
 * directory a Finder drop landing there should be imported into, parallel in
 * spirit to `terminalDropTargets.ts`'s `insertPathsAtScreenPoint` but
 * resolving a directory path rather than dispatching to a registered
 * callback — the explorer is always a single instance, and the target
 * directory depends on exactly which row the point landed on.
 *
 * - `null` if the point has no `.file-tree` ancestor at all (not an explorer
 *   drop).
 * - A row's own path if it's a directory row, or that row's parent directory
 *   if it's a file row.
 * - The current workspace root otherwise (the empty space below the last
 *   row, the same region `FileTree.svelte`'s `onEmptyAreaContextMenu`
 *   already targets).
 */
export function resolveExplorerDropTargetDir(clientX: number, clientY: number): string | null {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit?.closest(".file-tree")) {
    return null;
  }

  const row = hit.closest<HTMLElement>(".row[data-path]");
  if (row) {
    const path = row.dataset.path!;
    return row.dataset.isDir === "true" ? path : dirOf(path);
  }

  return get(fileTree).root?.entry.path ?? null;
}
