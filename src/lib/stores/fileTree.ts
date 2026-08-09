import { writable, get } from "svelte/store";
import { fsListDir, localWorkspaceId, type DirEntry } from "../ipc/commands";
import { basename, isPathUnderOrEqual } from "../util/path";

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

/** Merges a fresh listing against a node's existing children, preserving each surviving child's `expanded`/`children` state by path. */
function mergeChildren(existing: TreeNode[] | undefined, entries: DirEntry[]): TreeNode[] {
  const existingByPath = new Map((existing ?? []).map((node) => [node.entry.path, node]));
  return entries.map((entry) => {
    const survivor = existingByPath.get(entry.path);
    return survivor ? { ...survivor, entry } : toNode(entry);
  });
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
    return {
      ...state,
      root: patchNode(state.root, path, (node) => ({
        ...node,
        children: mergeChildren(node.children, entries),
        expanded: true,
      })),
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

/**
 * Expands every collapsed ancestor directory of `path`, so a row for it
 * exists in the tree — used to reveal the currently-open tab (issue #400):
 * without this, a file inside a collapsed directory (the common case on a
 * restored session, or any open triggered from outside the explorer) has no
 * DOM row to highlight at all. A no-op once there's no root, `path` is
 * outside it, or `path` *is* the root itself. `isStale` is re-checked before
 * each awaited step, so a rapid tab switch aborts an in-flight expansion
 * instead of racing it to completion for a path that's no longer current.
 */
export async function expandToPath(path: string, isStale: () => boolean): Promise<void> {
  const root = get(fileTree).root;
  if (!root || root.entry.path === path || !isPathUnderOrEqual(path, root.entry.path)) {
    return;
  }

  const ancestors: string[] = [];
  let dir = nativeDirOf(path);
  while (dir !== root.entry.path && nativeDirOf(dir) !== dir) {
    ancestors.unshift(dir);
    dir = nativeDirOf(dir);
  }

  for (const ancestor of ancestors) {
    if (isStale()) return;
    const node = findNode(get(fileTree).root ?? root, ancestor);
    if (node?.expanded && node.children) continue;
    await loadChildren(ancestor);
  }
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

/**
 * Parent directory of `path`, preserving whichever separator (`/` or `\`)
 * the input actually uses — unlike `dirOf` (`../util/path`), which
 * normalizes its *result* to `/`. That normalization is fine for the
 * string-comparison uses `dirOf` already has, but it would break a caller
 * that needs the result to still `===`-match a tree node's own
 * `entry.path`, which is kept in native (OS-specific) separator form
 * straight from the Rust backend — on Windows, a forward-slashed ancestor
 * would never match a backslashed node path. Used by `expandToPath` only.
 */
function nativeDirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx <= 0 ? path : path.slice(0, idx);
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
