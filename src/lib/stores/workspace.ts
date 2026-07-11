import { writable } from "svelte/store";
import { localWorkspaceId, workspaceOpenFolderDialog, workspaceSetRoot } from "../ipc/commands";

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
  const id = localWorkspaceId();
  await workspaceSetRoot(id, path);
  workspace.set({ id, root: path });
}
