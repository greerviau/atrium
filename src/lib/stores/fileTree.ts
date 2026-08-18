import { writable, get } from "svelte/store";
import { fsListDir, localWorkspaceId, type DirEntry } from "../ipc/commands";
import { basename, dirOf, isPathUnderOrEqual } from "../util/path";

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

/** Keeps an older directory listing from overwriting a newer overlapping refresh. */
const latestLoadByPath = new Map<string, number>();

function nextLoadGeneration(path: string): number {
  const generation = (latestLoadByPath.get(path) ?? 0) + 1;
  latestLoadByPath.set(path, generation);
  return generation;
}

function isLatestLoad(path: string, generation: number): boolean {
  return latestLoadByPath.get(path) === generation;
}

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

export async function loadRoot(rootPath: string): Promise<void> {
  const generation = nextLoadGeneration(rootPath);
  const entries = await fsListDir(localWorkspaceId(), rootPath);
  if (!isLatestLoad(rootPath, generation)) return;
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
  const generation = nextLoadGeneration(path);
  const entries = await fsListDir(localWorkspaceId(), path);
  if (!isLatestLoad(path, generation)) return;
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
 * DOM row to highlight at all. A no-op once there's no root or `path` is
 * outside it. `isStale` is re-checked before each awaited step, so a rapid
 * tab switch aborts an in-flight expansion instead of racing it to
 * completion for a path that's no longer current.
 *
 * Descends the *tree*, not the path string: at each level it picks whichever
 * child directory `path` falls under, via `isPathUnderOrEqual` (which
 * normalizes both sides), rather than slicing `path` itself into ancestor
 * strings to `===`-match against node paths. `path` (`tabsState.activeTabPath`)
 * is not guaranteed to be in the same separator form as `entry.path` — most
 * callers pass it through verbatim from the native filesystem, but at least
 * one (a markdown link's relative-path resolution) normalizes backslashes to
 * `/` along the way — so a string-prefix approach silently stops matching
 * tree nodes for that caller on Windows. Re-reads `fileTree` at the top of
 * every iteration rather than holding a node reference across the `await`,
 * since `loadChildren` replaces the node objects on the path it patches.
 */
export async function expandToPath(path: string, isStale: () => boolean): Promise<void> {
  const initialRoot = get(fileTree).root;
  if (!initialRoot || !isPathUnderOrEqual(path, initialRoot.entry.path)) {
    return;
  }

  let currentPath = initialRoot.entry.path;
  for (;;) {
    if (isStale()) return;
    const root = get(fileTree).root;
    const current = root && findNode(root, currentPath);
    if (!current?.children) return;
    const next = current.children.find(
      (child) => child.entry.isDir && isPathUnderOrEqual(path, child.entry.path),
    );
    if (!next) return; // `path` is directly under `current`, already visible
    if (!(next.expanded && next.children)) {
      await loadChildren(next.entry.path);
    }
    currentPath = next.entry.path;
  }
}

/** Re-fetches the children of whichever expanded directory contains `path`, used by the `fs:changed` live-update handler (section 6.3). */
export async function refreshDirectoryContaining(changedPath: string): Promise<void> {
  const state = get(fileTree);
  if (!state.root) {
    return;
  }
  // `dirOf` falls back to its input unchanged when there's no separator to
  // split on (e.g. a workspace rooted at the filesystem root "/", where a
  // top-level entry's own path already *is* as short as `dirOf` can make
  // it) — the old private `parentPath` this replaced special-cased that as
  // "/" specifically. The general case is "the entry belongs to the root
  // itself", so fall back to the tree's own root path rather than a
  // hardcoded "/", which also covers a Windows drive root the same way.
  const computed = dirOf(changedPath);
  const parent = computed === changedPath ? state.root.entry.path : computed;
  if (findNode(state.root, parent)?.expanded) {
    await loadChildren(parent);
  }
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
