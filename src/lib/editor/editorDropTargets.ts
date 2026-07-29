export interface EditorDropTarget {
  paneId: string | null;
}

/**
 * Hit-tests a viewport point against the editor area, parallel in spirit to
 * `explorerDropTargets.ts`'s `resolveExplorerDropTargetDir` and
 * `terminalDropTargets.ts`'s `terminalPaneAtScreenPoint`. `null` if the point
 * has no `.editor-area` ancestor at all (not an editor drop). Otherwise, the
 * hovered `.pane-leaf`'s own `data-pane-id` if the point landed on a specific
 * split pane, or `null` if it landed in the editor area but on no specific
 * pane yet (e.g. before any pane exists).
 */
export function resolveEditorDropTarget(clientX: number, clientY: number): EditorDropTarget | null {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit?.closest(".editor-area")) return null;
  const leaf = hit.closest<HTMLElement>(".pane-leaf[data-pane-id]");
  return { paneId: leaf?.dataset.paneId ?? null };
}
