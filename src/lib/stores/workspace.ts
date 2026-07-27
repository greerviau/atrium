import { get, writable } from "svelte/store";
import { localWorkspaceId, workspaceOpenFolderDialog, workspaceSetRoot } from "../ipc/commands";
import { loadRecents } from "./recents";
// `tabs.ts` already imports `workspace` from this module (used inside
// `openFile`'s body via `get(workspace).root`), so this import closes a
// circular module reference. Both sides only touch the other's export
// inside a function body, never at module-evaluation time, so the cycle
// resolves correctly under Vite/Vitest's ESM handling.
import { tabsState } from "./tabs";
import { closePrompt } from "./closePrompt";

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

async function performWorkspaceSwitch(path: string): Promise<void> {
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

/** Registers `path` as the workspace root directly, skipping the native picker (recent-projects rows, Dock menu). */
export async function openWorkspacePath(path: string): Promise<void> {
  if (path === get(workspace).root) return;
  const dirty = get(tabsState).tabs.filter((t) => t.isDirty);
  if (dirty.length > 0) {
    closePrompt.set({ kind: "workspace", paths: dirty.map((t) => t.path), targetPath: path });
    return;
  }
  await performWorkspaceSwitch(path);
}

/** Proceeds with a switch already confirmed via the unsaved-changes prompt (`kind: "workspace"`). */
export async function confirmWorkspaceSwitch(path: string): Promise<void> {
  await performWorkspaceSwitch(path);
}
