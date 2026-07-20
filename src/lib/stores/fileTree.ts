import { writable, get } from "svelte/store";
import { fsListDir, localWorkspaceId, type DirEntry } from "../ipc/commands";
import { basename } from "../util/path";

export interface TreeNode {
  entry: DirEntry;
  expanded: boolean;
  /** `undefined` until the directory has been expanded at least once (lazy load). */
  children?: TreeNode[];
}

export interface FileTreeState {
  /** The workspace root itself, wrapping its contents as `children`; `null` until a root is set. */
  root: TreeNode | null;
}

export const fileTree = writable<FileTreeState>({ root: null });

function toNode(entry: DirEntry): TreeNode {
  return { entry, expanded: false, children: undefined };
}

/** Normalizes for path comparison: backslash-to-slash, trailing-slash stripping. No symlink canonicalization. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export async function loadRoot(rootPath: string): Promise<void> {
  const entries = await fsListDir(localWorkspaceId(), rootPath);
  fileTree.set({
    root: {
      entry: { name: basename(rootPath), path: rootPath, isDir: true, isSymlink: false },
      expanded: true,
      children: entries.map(toNode),
    },
  });
}

/** Loads (or reloads) the children of the node at `path`, patching it in place. */
export async function loadChildren(path: string): Promise<void> {
  const entries = await fsListDir(localWorkspaceId(), path);
  fileTree.update((state) => {
    if (!state.root) {
      return state;
    }
    const children = entries.map(toNode);
    return {
      ...state,
      root: patchNode(state.root, path, (node) => ({ ...node, children, expanded: true })),
    };
  });
}

export function collapse(path: string): void {
  fileTree.update((state) => ({
    ...state,
    root: state.root && patchNode(state.root, path, (node) => ({ ...node, expanded: false })),
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
      ...state,
      root: state.root && patchNode(state.root, node.entry.path, (n) => ({ ...n, expanded: true })),
    }));
    return;
  }
  await loadChildren(node.entry.path);
}

/** Re-fetches the children of whichever expanded directory contains `path`, used by the `fs:changed` live-update handler (section 6.3). */
export async function refreshDirectoryContaining(changedPath: string): Promise<void> {
  const state = get(fileTree);
  if (!state.root) {
    return;
  }
  const parent = parentPath(changedPath);
  if (findNode(state.root, parent)?.expanded) {
    await loadChildren(parent);
  }
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

function findNode(node: TreeNode, path: string): TreeNode | undefined {
  if (node.entry.path === path) {
    return node;
  }
  if (!node.children) {
    return undefined;
  }
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function patchNode(node: TreeNode, path: string, patch: (node: TreeNode) => TreeNode): TreeNode {
  if (node.entry.path === path) {
    return patch(node);
  }
  if (!node.children) {
    return node;
  }
  return { ...node, children: node.children.map((child) => patchNode(child, path, patch)) };
}
