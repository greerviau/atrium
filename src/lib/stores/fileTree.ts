import { writable, get } from "svelte/store";
import { fsListDir, localWorkspaceId, type DirEntry } from "../ipc/commands";

export interface TreeNode {
  entry: DirEntry;
  expanded: boolean;
  /** `undefined` until the directory has been expanded at least once (lazy load). */
  children?: TreeNode[];
}

export interface FileTreeState {
  /** Top-level entries of the workspace root; `null` until a root is set. */
  roots: TreeNode[] | null;
}

export const fileTree = writable<FileTreeState>({ roots: null });

function toNode(entry: DirEntry): TreeNode {
  return { entry, expanded: false, children: undefined };
}

export async function loadRoot(rootPath: string): Promise<void> {
  const entries = await fsListDir(localWorkspaceId(), rootPath);
  fileTree.set({ roots: entries.map(toNode) });
}

/** Loads (or reloads) the children of the node at `path`, patching it in place. */
export async function loadChildren(path: string): Promise<void> {
  const entries = await fsListDir(localWorkspaceId(), path);
  const children = entries.map(toNode);
  fileTree.update((state) => ({
    roots: state.roots && patchNode(state.roots, path, (node) => ({ ...node, children, expanded: true })),
  }));
}

export function collapse(path: string): void {
  fileTree.update((state) => ({
    roots: state.roots && patchNode(state.roots, path, (node) => ({ ...node, expanded: false })),
  }));
}

export async function toggleExpanded(node: TreeNode): Promise<void> {
  if (!node.entry.isDir) {
    return;
  }
  if (node.expanded) {
    collapse(node.entry.path);
    return;
  }
  if (node.children) {
    fileTree.update((state) => ({
      roots: state.roots && patchNode(state.roots, node.entry.path, (n) => ({ ...n, expanded: true })),
    }));
    return;
  }
  await loadChildren(node.entry.path);
}

/** Re-fetches the children of whichever expanded directory contains `path`, used by the `fs:changed` live-update handler (section 6.3). */
export async function refreshDirectoryContaining(changedPath: string): Promise<void> {
  const state = get(fileTree);
  if (!state.roots) {
    return;
  }
  const parent = parentPath(changedPath);
  if (findNode(state.roots, parent)?.expanded) {
    await loadChildren(parent);
  }
}

function parentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.entry.path === path) {
      return node;
    }
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function patchNode(nodes: TreeNode[], path: string, patch: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((node) => {
    if (node.entry.path === path) {
      return patch(node);
    }
    if (node.children) {
      return { ...node, children: patchNode(node.children, path, patch) };
    }
    return node;
  });
}
