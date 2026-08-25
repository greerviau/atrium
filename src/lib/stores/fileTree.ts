import { writable, get } from "svelte/store";
import { fsListDir, localWorkspaceId, type DirEntry } from "../ipc/commands";
import { basename, isPathUnderOrEqual, pathsEqual, relativeToRoot } from "../util/path";

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

/**
 * `changedPath` expressed as the list of path segments below `rootPath`, or
 * `undefined` when `changedPath` is not inside the root at all. An empty
 * array means `changedPath` *is* the root — a directory watcher may report
 * the workspace root itself for a change to one of its children.
 */
function segmentsUnderRoot(changedPath: string, rootPath: string): string[] | undefined {
  if (!isPathUnderOrEqual(changedPath, rootPath)) return undefined;
  if (pathsEqual(changedPath, rootPath)) return [];
  return relativeToRoot(changedPath, rootPath)
    .split("/")
    .filter((segment) => segment !== "");
}

/**
 * The deepest expanded directory node whose own listing would contain
 * `changedPath`, or `undefined` when `changedPath` falls outside the tree or
 * the root itself is collapsed. A collapsed directory along the way stops
 * the descent, so the nearest *visible* ancestor is what gets relisted —
 * refreshing below a collapsed node would fetch rows nothing renders.
 *
 * The descent matches `entry.name` segment by segment rather than matching
 * `dirOf(changedPath)` against whole node paths, because a node's path and
 * an `fs:changed` path are not guaranteed to be spelled the same way.
 * `fs_watch::reported_path` addresses every event against the raw,
 * unresolved workspace root the user picked, and `root.entry.path` is that
 * same raw form (it comes from `$workspace.root`) — but every *child* node's
 * path comes from `fs_list_dir`, which builds its entries by joining onto a
 * `std::fs::canonicalize`d root. For a workspace opened through a symlinked
 * ancestor (macOS's `/tmp` and `/var`, or a project reached through a
 * symlink of any kind) the two spellings diverge from the first level down,
 * so a whole-path match finds nothing below the root and the walk falls back
 * to relisting the root — which cannot drop a stale row that lives inside a
 * subdirectory. Segment names carry no prefix, so they match either way, and
 * they sidestep the `/`-versus-`\` mismatch on Windows for free (a watcher
 * path is folded to `/` by `onFsChanged`, while node paths keep the native
 * separators `fs_list_dir` returned).
 */
function deepestExpandedDirectoryFor(root: TreeNode, changedPath: string): TreeNode | undefined {
  const segments = segmentsUnderRoot(changedPath, root.entry.path);
  if (segments === undefined || !root.expanded) return undefined;

  // The last segment names the changed entry itself; the listing that has to
  // be refetched is its parent's.
  let directory = root;
  for (const name of segments.slice(0, -1)) {
    const child = directory.children?.find((node) => node.entry.isDir && node.entry.name === name);
    if (!child?.expanded || !child.children) break;
    directory = child;
  }
  return directory;
}

/** Re-fetches the children of whichever expanded directory contains `path`, used by the `fs:changed` live-update handler (section 6.3). */
export async function refreshDirectoryContaining(changedPath: string): Promise<void> {
  const root = get(fileTree).root;
  if (!root) return;
  const directory = deepestExpandedDirectoryFor(root, changedPath);
  if (!directory) return;
  // Call IPC with the tree's own spelling of the directory, not anything
  // derived from the event path: `loadChildren` keys the listing it patches
  // back in by exactly this string.
  await loadChildren(directory.entry.path);
}

function findNode(node: TreeNode, path: string): TreeNode | undefined {
  if (pathsEqual(node.entry.path, path)) {
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
  if (pathsEqual(node.entry.path, path)) {
    return patch(node);
  }
  if (!node.children) {
    return node;
  }
  return { ...node, children: node.children.map((child) => patchNode(child, path, patch)) };
}
