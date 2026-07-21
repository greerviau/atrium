import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
  | "menu:find-in-files"
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
