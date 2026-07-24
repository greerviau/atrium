/**
 * Private `dataTransfer` MIME type for an explorer-row-to-terminal path
 * drag, read by the terminal's drop handler (`TerminalPane.svelte`).
 * Deliberately not `text/plain`: that generic type is offered to every drop
 * target in the app, including CodeMirror's built-in drop handler, which
 * would insert the path into an open editor buffer instead of letting only
 * the terminal read it.
 *
 * The explorer row no longer produces this type — its own drag source was
 * rebuilt on Pointer Events (see `explorerDrag.ts`) because Tauri's native
 * `dragDropEnabled` disables HTML5 Drag and Drop in the packaged app,
 * breaking the explorer's row-to-row move (issue #189). That leaves this
 * constant with a reader but no writer: the row→terminal drag-to-paste-path
 * feature (issue #98/#120) is consequently broken by the same root cause,
 * tracked separately as issue #220.
 */
export const EXPLORER_PATH_DRAG_TYPE = "application/x-atrium-path";
