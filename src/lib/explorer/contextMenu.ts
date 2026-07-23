import { writable } from "svelte/store";
import {
  fsCreateFile,
  fsCreateDir,
  fsRename,
  fsDelete,
  localWorkspaceId,
} from "../ipc/commands";
import { loadChildren } from "../stores/fileTree";
import { basename, dirOf } from "../util/path";

export interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

export const contextMenu = writable<ContextMenuState | null>(null);

export function openContextMenu(event: MouseEvent, path: string, isDir: boolean): void {
  event.preventDefault();
  contextMenu.set({ x: event.clientX, y: event.clientY, path, isDir });
}

export function closeContextMenu(): void {
  contextMenu.set(null);
}

export async function newFile(dirPath: string, name: string): Promise<void> {
  const workspaceId = localWorkspaceId();
  await fsCreateFile(workspaceId, `${dirPath}/${name}`);
  await loadChildren(dirPath);
}

export async function newFolder(dirPath: string, name: string): Promise<void> {
  const workspaceId = localWorkspaceId();
  await fsCreateDir(workspaceId, `${dirPath}/${name}`);
  await loadChildren(dirPath);
}

export async function rename(path: string, newName: string): Promise<void> {
  const workspaceId = localWorkspaceId();
  const dir = dirOf(path);
  await fsRename(workspaceId, path, `${dir}/${newName}`);
  await loadChildren(dir);
}

/** Moves `sourcePath` into `destDir` — a rename to a new parent directory. Reloads both the source's old parent and the destination so both listings reflect the move; a destination collision surfaces as `fsRename`'s `AlreadyExists` rejection, same as the same-directory rename above. */
export async function movePath(sourcePath: string, destDir: string): Promise<void> {
  const workspaceId = localWorkspaceId();
  const sourceDir = dirOf(sourcePath);
  const newPath = `${destDir}/${basename(sourcePath)}`;
  await fsRename(workspaceId, sourcePath, newPath);
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
  await loadChildren(dirOf(path));
}
