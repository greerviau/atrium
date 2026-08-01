// Editor tabs use the shared pointer gesture so editor and terminal tabs have
// identical reorder, merge, and split behavior.
export { beginTabDrag, draggingTabKey, activeTabDrag, clearTabDrag } from "../panes/tabDrag";
export type { ActiveTabDrag, TabDragOptions, TabDropTarget, TabDropZone, TabSurface } from "../panes/tabDrag";
