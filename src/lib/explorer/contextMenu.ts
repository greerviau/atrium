import { writable } from "svelte/store";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  fsCreateFile,
  fsCreateDir,
  fsRename,
  fsDelete,
  localWorkspaceId,
} from "../ipc/commands";
import { loadChildren } from "../stores/fileTree";

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

function dirOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? path : normalized.slice(0, idx);
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

export async function revealInFinder(path: string): Promise<void> {
  await revealItemInDir(path);
}
