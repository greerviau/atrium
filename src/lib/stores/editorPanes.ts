import { writable } from "svelte/store";
import type { EditorPaneNode } from "../editor/editorPaneTree";

/**
 * Which editor split pane last had focus. `App.svelte` owns the writes
 * (mirroring how it owns `terminalPaneTree`/`focusedPaneId`); this is a
 * store rather than a prop threaded down through `EditorPaneSplit` ->
 * `EditorPanel` because `EditorPane.svelte` — several components deep —
 * needs it directly to decide whether it's the one pane, among possibly
 * several showing the same path, allowed to drive the global
 * cursor-position store and consume a pending "jump to line" request.
 */
export const focusedEditorPaneId = writable<string | null>(null);

/**
 * The editor's own pane tree. `App.svelte` still owns every write to it
 * (splitting, closing, resizing, the tabsState-reconciliation effects); it
 * lives in a store rather than local component state for the same reason
 * `focusedEditorPaneId` does — `EditorPane.svelte` needs to look at the
 * *whole* tree, not just its own pane, to determine which single instance
 * among several showing the same path owns responding to a save request
 * (see `saveOwnerLeafId` in `editorPaneTree.ts`).
 */
export const editorPaneTree = writable<EditorPaneNode | null>(null);
