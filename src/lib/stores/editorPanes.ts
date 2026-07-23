import { writable } from "svelte/store";

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
