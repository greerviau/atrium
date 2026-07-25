import { writable } from "svelte/store";
import { localWorkspaceId, workspaceOpenFolderDialog, workspaceSetRoot } from "../ipc/commands";
import { loadRecents } from "./recents";

export interface WorkspaceState {
  id: string;
  root: string | null;
}

export const workspace = writable<WorkspaceState>({
  id: localWorkspaceId(),
  root: null,
});

/** Opens the native folder picker and registers the chosen folder as the workspace root. */
export async function openWorkspaceFolder(): Promise<void> {
  const path = await workspaceOpenFolderDialog();
  if (path === null) {
    return;
  }
  await openWorkspacePath(path);
}

/** Registers `path` as the workspace root directly, skipping the native picker (recent-projects rows, Dock menu). */
export async function openWorkspacePath(path: string): Promise<void> {
  const id = localWorkspaceId();
  await workspaceSetRoot(id, path);
  workspace.set({ id, root: path });
  // Refreshing here (not in each caller) keeps every recents-list consumer -
  // the title-bar switcher included - in sync immediately after a switch,
  // matching `workspace_set_root`'s own "single choke point" design on the
  // Rust side. Ancillary to the actual open, so a failed refresh is
  // swallowed rather than surfaced - the workspace switch itself already
  // succeeded by this point.
  loadRecents().catch(() => {});
}
