import { writable } from "svelte/store";

/**
 * The pending unsaved-changes confirmation, if any. `"tab"` covers closing a
 * single dirty tab via its "×" button; `"window"` covers closing the window
 * or quitting the app while one or more tabs are dirty. `null` means no
 * dialog is showing.
 */
export type ClosePromptRequest =
  | { kind: "tab"; path: string }
  | { kind: "window"; paths: string[] };

export const closePrompt = writable<ClosePromptRequest | null>(null);
