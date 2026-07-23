// The terminal dock's own instantiation of the generic pane tree
// (`src/lib/panes/paneTree.ts`): a leaf holds a tab strip of
// `TerminalSession`s. The recursive split/remove/resize/list/find tree
// mechanics live in the generic module and are shared with the editor's own
// `EditorLeafPane` tree; this file only adds what's specific to a terminal
// leaf's own tabs.
import {
  mapLeaf,
  removePane,
  findLeaf,
  type PaneNode as GenericPaneNode,
  type SplitPane as GenericSplitPane,
} from "../panes/paneTree";

export type { SplitAxis, SplitDirection } from "../panes/paneTree";
export { splitPane, removePane, resizeSplit, listLeaves, findLeaf, nextActivePane, PANE_MIN_PX } from "../panes/paneTree";

export interface TerminalSession {
  id: string;
  cwd: string;
  title: string;
}

export interface LeafPane {
  type: "leaf";
  id: string;
  tabs: TerminalSession[]; // 1+ entries
  activeTabId: string;
}

// The terminal's own concrete instantiation of the generic tree, so every
// existing terminal call site (App.svelte, PaneSplit.svelte, TerminalPanel.svelte,
// their tests) keeps referring to a plain, non-parameterized `PaneNode`/`SplitPane`.
export type PaneNode = GenericPaneNode<LeafPane>;
export type SplitPane = GenericSplitPane<LeafPane>;

/** Appends `newSession` to `leafId`'s tab strip and makes it the active tab. */
export function addTabToLeaf(tree: PaneNode, leafId: string, newSession: TerminalSession): PaneNode {
  return mapLeaf(tree, leafId, (leaf) => ({
    ...leaf,
    tabs: [...leaf.tabs, newSession],
    activeTabId: newSession.id,
  }));
}

/**
 * Removes `sessionId` from `leafId`'s tab strip. If it was the active tab,
 * the next active tab falls back to the new last tab (the same convention
 * `src/lib/stores/tabs.ts`'s `closeTab` uses for the editor's own tab strip).
 * If `sessionId` was the leaf's last tab, the whole leaf is removed from the
 * tree via `removePane` — returns `null` if that leaf was the tree's only
 * leaf, mirroring `removePane`'s own null case.
 */
export function closeTabInLeaf(tree: PaneNode, leafId: string, sessionId: string): PaneNode | null {
  const leaf = findLeaf(tree, leafId);
  if (!leaf) return tree;
  const tabs = leaf.tabs.filter((t) => t.id !== sessionId);
  if (tabs.length === 0) {
    return removePane(tree, leafId);
  }
  const activeTabId = leaf.activeTabId === sessionId ? tabs[tabs.length - 1].id : leaf.activeTabId;
  return mapLeaf(tree, leafId, () => ({ ...leaf, tabs, activeTabId }));
}

export function setActiveTabInLeaf(tree: PaneNode, leafId: string, sessionId: string): PaneNode {
  return mapLeaf(tree, leafId, (leaf) => ({ ...leaf, activeTabId: sessionId }));
}

export function updateSessionInLeaf(
  tree: PaneNode,
  leafId: string,
  sessionId: string,
  patch: Partial<Pick<TerminalSession, "cwd" | "title">>,
): PaneNode {
  return mapLeaf(tree, leafId, (leaf) => ({
    ...leaf,
    tabs: leaf.tabs.map((t) => (t.id === sessionId ? { ...t, ...patch } : t)),
  }));
}
