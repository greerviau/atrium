import { writable } from "svelte/store";
import { newFile, newFolder, rename } from "./contextMenu";

export interface PendingCreate {
  parentPath: string;
  isDir: boolean;
}

/** Path of the tree entry currently being renamed inline, or `null` when no rename is active. */
export const editingPath = writable<string | null>(null);

/** Parent directory + kind of an in-progress "new file/folder" row, or `null` when none is pending. */
export const pendingCreate = writable<PendingCreate | null>(null);

/**
 * Resolves whatever edit is currently active before a new one starts. In the common case this is
 * a no-op: a mousedown on a different row already blurs the focused input, which resolves the
 * edit via `InlineNameInput`'s own blur handler before this ever runs. This exists as the
 * non-focus-dependent backstop for cases where that doesn't happen (e.g. two "New File" clicks in
 * a row from the same context menu) — it can only cancel, since it has no view into whatever value
 * the (already-blurred-or-not) input currently holds.
 */
export function settleActiveEdit(): void {
  editingPath.set(null);
  pendingCreate.set(null);
}

export async function commitRename(path: string, newName: string): Promise<void> {
  await rename(path, newName);
  editingPath.set(null);
}

export async function commitCreate(parentPath: string, isDir: boolean, name: string): Promise<void> {
  if (isDir) {
    await newFolder(parentPath, name);
  } else {
    await newFile(parentPath, name);
  }
  pendingCreate.set(null);
}
