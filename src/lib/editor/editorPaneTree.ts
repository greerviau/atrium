// The editor's own instantiation of the generic pane tree
// (`src/lib/panes/paneTree.ts`): a leaf holds a tab strip of open file
// paths. The recursive split/remove/resize/list/find tree mechanics live in
// the generic module and are shared with the terminal dock's own `LeafPane`
// tree; this file only adds what's specific to an editor leaf's own tabs.
//
// A leaf's `tabs` is a list of paths, not full `Tab` objects — the document
// content/dirty/conflict state stays centralized in `src/lib/stores/tabs.ts`'s
// flat `tabs: Tab[]` keyed by path, exactly as before split panes existed. A
// leaf just orders and selects among that global set of open paths.
import { mapLeaf, removePane, findLeaf, listLeaves, type PaneNode as GenericPaneNode, type SplitPane as GenericSplitPane } from "../panes/paneTree";

export type { SplitAxis, SplitDirection } from "../panes/paneTree";
export { splitPane, removePane, resizeSplit, listLeaves, findLeaf, nextActivePane, PANE_MIN_PX } from "../panes/paneTree";

export interface EditorLeafPane {
  type: "leaf";
  id: string;
  tabs: string[]; // open paths in this pane's own tab strip, this pane's own order
  activeTabPath: string | null;
}

// The editor's own concrete instantiation of the generic tree.
export type EditorPaneNode = GenericPaneNode<EditorLeafPane>;
export type EditorSplitPane = GenericSplitPane<EditorLeafPane>;

/**
 * Adds `path` to `leafId`'s tab strip and makes it the active tab. A no-op
 * append if `path` is already in this leaf's own tabs (a leaf's tab list is
 * effectively a set) — just switches which one is active.
 */
export function addTabToLeaf(tree: EditorPaneNode, leafId: string, path: string): EditorPaneNode {
  return mapLeaf(tree, leafId, (leaf) => ({
    ...leaf,
    tabs: leaf.tabs.includes(path) ? leaf.tabs : [...leaf.tabs, path],
    activeTabPath: path,
  }));
}

/**
 * Removes `path` from `leafId`'s tab strip. If it was the active tab, the
 * next active tab falls back to the new last tab (the same convention
 * `src/lib/stores/tabs.ts`'s `closeTab` uses for the flat, pre-split tab
 * strip). If `path` was the leaf's last tab, the whole leaf is removed from
 * the tree via `removePane` — returns `null` if that leaf was the tree's
 * only leaf, mirroring `removePane`'s own null case.
 */
export function closeTabInLeaf(tree: EditorPaneNode, leafId: string, path: string): EditorPaneNode | null {
  const leaf = findLeaf(tree, leafId);
  if (!leaf) return tree;
  const tabs = leaf.tabs.filter((p) => p !== path);
  if (tabs.length === 0) {
    return removePane(tree, leafId);
  }
  const activeTabPath = leaf.activeTabPath === path ? tabs[tabs.length - 1] : leaf.activeTabPath;
  return mapLeaf(tree, leafId, () => ({ ...leaf, tabs, activeTabPath }));
}

export function setActiveTabInLeaf(tree: EditorPaneNode, leafId: string, path: string): EditorPaneNode {
  return mapLeaf(tree, leafId, (leaf) => ({ ...leaf, activeTabPath: path }));
}

/**
 * Reconciles the tree against the current set of globally open paths
 * (`tabsState.tabs`), for the direction split panes add that a flat tab
 * strip never had to handle: a path can be closed at the `tabsState` level
 * (the unsaved-changes dialog's "Don't Save"/"Save" actions call `closeTab`
 * directly, with no notion of which pane(s) were showing it) without first
 * going through a pane-aware close. Drops any path no longer in `openPaths`
 * from every leaf's tabs, falling back each affected leaf's `activeTabPath`
 * the same way `closeTabInLeaf` does, and removes any leaf left with zero
 * tabs. Returns `null` if every leaf ends up empty. A no-op (returns `tree`
 * itself) when nothing is stale, so callers can cheaply skip acting on an
 * unchanged result.
 */
export function pruneMissingTabs(tree: EditorPaneNode, openPaths: ReadonlySet<string>): EditorPaneNode | null {
  let result: EditorPaneNode | null = tree;
  for (const leaf of listLeaves(tree)) {
    const tabs = leaf.tabs.filter((p) => openPaths.has(p));
    if (tabs.length === leaf.tabs.length) continue;
    if (!result) return null;
    if (tabs.length === 0) {
      result = removePane(result, leaf.id);
      continue;
    }
    const activeTabPath = leaf.activeTabPath && tabs.includes(leaf.activeTabPath) ? leaf.activeTabPath : tabs[tabs.length - 1];
    result = mapLeaf(result, leaf.id, () => ({ ...leaf, tabs, activeTabPath }));
  }
  return result;
}

/**
 * Which single leaf's own `EditorPane` instance should respond when `path`
 * is requested to save (`src/lib/stores/tabs.ts`'s `saveRequest`/`requestSave`),
 * given that — with no live content sync yet between split views of the same
 * path (PR1's own scope) — a save request naming just a bare path is
 * otherwise ambiguous the instant that path is open in more than one leaf:
 * every instance would independently write its own, possibly-diverged
 * buffer, racing each other for which write lands last on disk.
 *
 * Prefers the focused pane when it's one of the leaves showing `path` (the
 * common case: `Cmd+S`/`File > Save` always requests a save for
 * `tabsState.activeTabPath`, which is kept as a mirror of the focused pane's
 * own active tab, so the focused pane is definitionally among the owners
 * here). Otherwise falls back to the first leaf (in `listLeaves`'s
 * deterministic tree order) showing `path` — covering a save requested for a
 * path that isn't the focused pane's own active tab at all, which happens
 * when the unsaved-changes dialog's "Save"/"Save All" saves a *different*,
 * possibly-unfocused dirty tab on its way to closing it. Returns `null` if
 * `path` isn't open in any leaf (shouldn't happen for a real save request).
 */
export function saveOwnerLeafId(tree: EditorPaneNode, path: string, focusedPaneId: string | null): string | null {
  const owners = listLeaves(tree).filter((leaf) => leaf.tabs.includes(path));
  if (owners.length === 0) return null;
  if (focusedPaneId && owners.some((leaf) => leaf.id === focusedPaneId)) return focusedPaneId;
  return owners[0].id;
}
