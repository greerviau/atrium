import { get, writable } from "svelte/store";
import {
  fsCreateFile,
  fsCreateDir,
  fsRename,
  fsDelete,
  localWorkspaceId,
} from "../ipc/commands";
import { loadChildren } from "../stores/fileTree";
import { pruneRecentFiles } from "../stores/recentFiles";
import { renameOpenTabs, markPathDeleted } from "../stores/tabs";
import { workspace } from "../stores/workspace";
import { basename, dirOf, joinPath } from "../util/path";

export interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

export const contextMenu = writable<ContextMenuState | null>(null);

/**
 * The FileTreeNode -> FileTree channel for keyboard-originated tree actions
 * (the five explorer shortcuts), playing the same role for a keyboard chord
 * that `contextMenu`'s `(x, y, path, isDir)` shape plays for a right-click:
 * `FileTreeNode.svelte` can't call `FileTree.svelte`'s local handlers
 * directly (plain component-local `$state`, not exported), so it sets this
 * store instead and `FileTree.svelte` reacts to it.
 */
export interface TreeActionRequest {
  action: "newFile" | "newFolder" | "rename" | "delete" | "reveal";
  path: string;
  isDir: boolean;
}

export const treeActionRequest = writable<TreeActionRequest | null>(null);

export function openContextMenu(event: MouseEvent, path: string, isDir: boolean): void {
  event.preventDefault();
  contextMenu.set({ x: event.clientX, y: event.clientY, path, isDir });
}

export function closeContextMenu(): void {
  contextMenu.set(null);
}

export async function newFile(dirPath: string, name: string): Promise<void> {
  const workspaceId = localWorkspaceId();
  await fsCreateFile(workspaceId, joinPath(dirPath, name));
  await loadChildren(dirPath);
}

export async function newFolder(dirPath: string, name: string): Promise<void> {
  const workspaceId = localWorkspaceId();
  await fsCreateDir(workspaceId, joinPath(dirPath, name));
  await loadChildren(dirPath);
}

export async function rename(path: string, newName: string): Promise<void> {
  const workspaceId = localWorkspaceId();
  const dir = dirOf(path);
  const newPath = joinPath(dir, newName);
  await fsRename(workspaceId, path, newPath);
  pruneRecents(path);
  renameOpenTabs(path, newPath);
  await loadChildren(dir);
}

/** Moves `sourcePath` into `destDir` — a rename to a new parent directory. Reloads both the source's old parent and the destination so both listings reflect the move; a destination collision surfaces as `fsRename`'s `AlreadyExists` rejection, same as the same-directory rename above. */
export async function movePath(sourcePath: string, destDir: string): Promise<void> {
  const workspaceId = localWorkspaceId();
  const sourceDir = dirOf(sourcePath);
  const newPath = joinPath(destDir, basename(sourcePath));
  await fsRename(workspaceId, sourcePath, newPath);
  pruneRecents(sourcePath);
  renameOpenTabs(sourcePath, newPath);
  await Promise.all([loadChildren(sourceDir), loadChildren(destDir)]);
}

/**
 * Deletes `path` permanently — the MVP has no OS trash integration, so the
 * caller (the context-menu component) must confirm with the user first and
 * say so explicitly (plan section 6.3).
 */
export async function deletePath(path: string, isDir: boolean): Promise<void> {
  const workspaceId = localWorkspaceId();
  await fsDelete(workspaceId, path, isDir);
  pruneRecents(path);
  markPathDeleted(path);
  await loadChildren(dirOf(path));
}

/** Prunes `recentFiles`' entry (or, for a directory, every entry nested under it) for `affectedPath`, once the explorer's own delete/rename/move has committed on the backend — deliberately ahead of the tree reload, so a rejected reload can never skip the prune after the filesystem mutation already succeeded. A rename/move prunes the *old* path — the moved-to path re-earns recency on its own next open. */
function pruneRecents(affectedPath: string): void {
  const root = get(workspace).root;
  if (root) pruneRecentFiles(root, affectedPath);
}
