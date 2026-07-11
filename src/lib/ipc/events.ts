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

/** Native menu bar items that need frontend behavior (plan section 7). */
export type MenuEventId = "menu:open-folder" | "menu:save" | "menu:new-terminal-tab";

export function onMenuEvent(
  id: MenuEventId,
  handler: () => void,
): Promise<UnlistenFn> {
  return listen(id, () => handler());
}
