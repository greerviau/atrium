import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";

export type FsChangeKind = "create" | "modify" | "remove" | "rename";

export interface FsChangeEvent {
  workspaceId: string;
  path: string;
  kind: FsChangeKind;
}

export function onFsChanged(
  handler: (event: FsChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<FsChangeEvent>("fs:changed", (event) => handler(event.payload));
}

/** Native menu bar items that need frontend behavior. */
export type MenuEventId =
  | "menu:open-folder"
  | "menu:save"
  | "menu:new-terminal-tab"
  | "menu:split-terminal"
  | "menu:find-in-files"
  | "menu:toggle-explorer"
  | "menu:toggle-terminal"
  | "menu:zoom-in"
  | "menu:zoom-out"
  | "menu:zoom-reset"
  | "menu:theme:auto"
  | "menu:theme:atrium-dark"
  | "menu:theme:atrium-light"
  | "menu:theme:atrium-high-contrast";

export function onMenuEvent(
  id: MenuEventId,
  handler: () => void,
): Promise<UnlistenFn> {
  return listen(id, () => handler());
}

/** A macOS Dock-menu pick resolved while the app was already running. */
export function onDockOpenPath(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("dock:open-path", (event) => handler(event.payload));
}

/**
 * Fires when the user tries to close the window or quit the app (Rust
 * always intercepts both paths and defers the decision here, since it has
 * no visibility into which tabs are dirty).
 */
export function onCloseRequested(handler: () => void): Promise<UnlistenFn> {
  return listen("app:close-requested", () => handler());
}

/**
 * Fires on an OS-level file drop onto the window (e.g. dragging from
 * Finder). Window/webview-scoped, not per-element — the payload's
 * `position` is a screen point the caller hit-tests against the DOM itself
 * (see terminalDropTargets.ts).
 */
export function onDragDropEvent(handler: (event: DragDropEvent) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => handler(event.payload));
}
