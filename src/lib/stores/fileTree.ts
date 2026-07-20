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
  /** Path passed to `loadRoot`; `null` until a root is set. Used to detect root-level changes, which have no `TreeNode` of their own. */
  rootPath: string | null;
}

export const fileTree = writable<FileTreeState>({ roots: null, rootPath: null });

function toNode(entry: DirEntry): TreeNode {
  return { entry, expanded: false, children: undefined };
}

/** Normalizes for path comparison: backslash-to-slash, trailing-slash stripping. No symlink canonicalization. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Merges a fresh top-level listing into `roots`, preserving each surviving sibling's `expanded`/`children` state. */
function mergeRoots(roots: TreeNode[], entries: DirEntry[]): TreeNode[] {
  const existingByPath = new Map(roots.map((node) => [node.entry.path, node]));
  return entries.map((entry) => {
    const existing = existingByPath.get(entry.path);
    return existing ? { ...existing, entry } : toNode(entry);
  });
}

export async function loadRoot(rootPath: string): Promise<void> {
  const entries = await fsListDir(localWorkspaceId(), rootPath);
  fileTree.set({ roots: entries.map(toNode), rootPath });
}

/** Loads (or reloads) the children of the node at `path`, patching it in place. */
export async function loadChildren(path: string): Promise<void> {
  const entries = await fsListDir(localWorkspaceId(), path);
  fileTree.update((state) => {
    if (!state.roots) {
      return state;
    }
    if (state.rootPath !== null && normalizePath(path) === normalizePath(state.rootPath)) {
      return { ...state, roots: mergeRoots(state.roots, entries) };
    }
    const children = entries.map(toNode);
    return {
      ...state,
      roots: patchNode(state.roots, path, (node) => ({ ...node, children, expanded: true })),
    };
  });
}

export function collapse(path: string): void {
  fileTree.update((state) => ({
    ...state,
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
      ...state,
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
  if (state.rootPath !== null && normalizePath(parent) === normalizePath(state.rootPath)) {
    // The root has no `TreeNode`/`expanded` flag of its own; it is implicitly always expanded.
    await loadChildren(state.rootPath);
    return;
  }
  if (findNode(state.roots, parent)?.expanded) {
    await loadChildren(parent);
  }
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
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
