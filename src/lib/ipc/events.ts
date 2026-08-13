import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { canonicalizePath } from "../util/path";

/**
 * The matching normalization boundary for `commands.ts`'s IPC calls: every
 * path-typed field on a subscribed event is folded through
 * `canonicalizePath` here before it reaches any handler, so downstream code
 * can rely on the canonical form (see `src/lib/util/path.ts`'s module
 * header).
 */

export type FsChangeKind = "create" | "modify" | "remove" | "rename";

export interface FsChangeEvent {
  workspaceId: string;
  path: string;
  kind: FsChangeKind;
  /** Only set when `kind === "rename"`: the path this entry was renamed from. */
  fromPath?: string;
}

export function onFsChanged(
  handler: (event: FsChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<FsChangeEvent>("fs:changed", (event) =>
    handler({
      ...event.payload,
      path: canonicalizePath(event.payload.path),
      fromPath:
        event.payload.fromPath === undefined ? undefined : canonicalizePath(event.payload.fromPath),
    }),
  );
}

/** Native menu bar items that need frontend behavior. */
export type MenuEventId =
  | "menu:open-folder"
  | "menu:save"
  | "menu:settings"
  | "menu:close-tab"
  | "menu:new-terminal-tab"
  | "menu:split-terminal"
  | "menu:split-up"
  | "menu:split-down"
  | "menu:split-left"
  | "menu:split-right"
  | "menu:find-in-files"
  | "menu:go-to-file"
  | "menu:toggle-explorer"
  | "menu:toggle-terminal"
  | "menu:zoom-in"
  | "menu:zoom-out"
  | "menu:zoom-reset"
  | "menu:help:shortcuts"
  | "menu:help:github"
  | "menu:help:report-issue";

export function onMenuEvent(
  id: MenuEventId,
  handler: () => void,
): Promise<UnlistenFn> {
  return listen(id, () => handler());
}

/**
 * A path the OS resolved while the app was already running: a macOS Dock
 * menu or `RunEvent::Opened` request, or a Linux/Windows launch argument
 * forwarded by the secondary process. The path may be a file or folder;
 * the handler classifies which
 * before deciding what to do with it (`App.svelte`'s `doHandleOsOpenPath`).
 */
export function onDockOpenPath(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("dock:open-path", (event) => handler(canonicalizePath(event.payload)));
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
  return getCurrentWebview().onDragDropEvent((event) =>
    handler(
      event.payload.type === "drop"
        ? { ...event.payload, paths: event.payload.paths.map(canonicalizePath) }
        : event.payload,
    ),
  );
}
