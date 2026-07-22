/**
 * Private `dataTransfer` MIME type for an explorer-row-to-terminal path
 * drag, shared between the explorer (drag source) and the terminal (drop
 * target). Deliberately not `text/plain`: that generic type is offered to
 * every drop target in the app, including CodeMirror's built-in drop
 * handler, which would insert the path into an open editor buffer instead
 * of letting only the terminal read it.
 */
export const EXPLORER_PATH_DRAG_TYPE = "application/x-atrium-path";
