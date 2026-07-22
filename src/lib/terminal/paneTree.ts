// Axis a split lays its children out along — unchanged meaning from the
// pre-redesign `SplitDirection`, renamed to free that name up for the
// four-direction type below.
export type SplitAxis = "row" | "column"; // row = side by side (left/right), column = stacked (up/down)

// The four directions the split UI offers. Maps onto an axis plus which side
// of the target the new leaf lands on (see `DIRECTION_MAP`).
export type SplitDirection = "up" | "down" | "left" | "right";

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

export interface SplitPane {
  type: "split";
  id: string;
  direction: SplitAxis;
  children: PaneNode[]; // 2+ entries
  sizes: number[]; // flex ratios, same length as children, sums to 1
}

export type PaneNode = LeafPane | SplitPane;

// Minimum pane size, in pixels, that `resizeSplit`'s ratio clamp protects.
// The rendering layer converts this to a ratio against its own container
// size (`PANE_MIN_PX / containerSizePx`) since a ratio has no fixed pixel
// meaning on its own.
export const PANE_MIN_PX = 80;

const DIRECTION_MAP: Record<SplitDirection, { axis: SplitAxis; before: boolean }> = {
  right: { axis: "row", before: false },
  left: { axis: "row", before: true },
  down: { axis: "column", before: false },
  up: { axis: "column", before: true },
};

function containsLeaf(node: PaneNode, id: string): boolean {
  if (node.type === "leaf") return node.id === id;
  return node.children.some((child) => containsLeaf(child, id));
}

/** Inserts `newRatio` at `insertIndex`, scaling every existing ratio down proportionally so the array still sums to 1. */
function insertWithRebalance(sizes: number[], insertIndex: number): number[] {
  const n = sizes.length;
  const newRatio = 1 / (n + 1);
  const scale = n / (n + 1);
  const result = sizes.map((s) => s * scale);
  result.splice(insertIndex, 0, newRatio);
  return result;
}

function splitWithinNode(
  node: SplitPane,
  targetPaneId: string,
  axis: SplitAxis,
  before: boolean,
  newLeaf: LeafPane,
): SplitPane {
  const idx = node.children.findIndex((child) => child.id === targetPaneId);
  if (idx !== -1) {
    if (node.direction === axis) {
      // Same axis as the target's immediate parent: insert rather than
      // nesting a redundant wrapper split one level deeper.
      const insertIndex = before ? idx : idx + 1;
      const children = [...node.children];
      children.splice(insertIndex, 0, newLeaf);
      return { ...node, children, sizes: insertWithRebalance(node.sizes, insertIndex) };
    }
    const target = node.children[idx];
    const wrapped: SplitPane = {
      type: "split",
      id: `split-${target.id}-${newLeaf.id}`,
      direction: axis,
      children: before ? [newLeaf, target] : [target, newLeaf],
      sizes: [0.5, 0.5],
    };
    const children = [...node.children];
    children[idx] = wrapped;
    return { ...node, children };
  }

  return {
    ...node,
    children: node.children.map((child) =>
      child.type === "split" && containsLeaf(child, targetPaneId)
        ? splitWithinNode(child, targetPaneId, axis, before, newLeaf)
        : child,
    ),
  };
}

/**
 * Replaces the target leaf with a split containing `[target, newLeaf]` (or
 * `[newLeaf, target]` for "left"/"up"). If the target leaf's parent is
 * already a split with the same axis, `newLeaf` is inserted into that parent
 * instead of nesting a redundant same-axis wrapper.
 */
export function splitPane(
  tree: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  newLeaf: LeafPane,
): PaneNode {
  const { axis, before } = DIRECTION_MAP[direction];
  if (tree.type === "leaf") {
    if (tree.id !== targetPaneId) return tree;
    return {
      type: "split",
      id: `split-${tree.id}-${newLeaf.id}`,
      direction: axis,
      children: before ? [newLeaf, tree] : [tree, newLeaf],
      sizes: [0.5, 0.5],
    };
  }
  return splitWithinNode(tree, targetPaneId, axis, before, newLeaf);
}

function removeFromNode(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "leaf") {
    return node.id === paneId ? null : node;
  }

  const idx = node.children.findIndex((child) => containsLeaf(child, paneId));
  if (idx === -1) return node;

  const child = node.children[idx];

  if (child.type === "leaf") {
    const remainingChildren = node.children.filter((_, i) => i !== idx);
    if (remainingChildren.length === 1) {
      // This split collapses entirely; hand the sole remaining child up as
      // it is. Its own former ratio inside `node` is discarded — it now
      // takes over whichever slot `node` itself occupied in *its* parent.
      return remainingChildren[0];
    }
    const removedSize = node.sizes[idx];
    const scale = 1 / (1 - removedSize);
    return {
      ...node,
      children: remainingChildren,
      sizes: node.sizes.filter((_, i) => i !== idx).map((s) => s * scale),
    };
  }

  // Recurse into the split child that contains paneId. A split child can
  // never fully vanish here (only a direct leaf match above returns null),
  // so `updatedChild` is always a real node.
  const updatedChild = removeFromNode(child, paneId) as PaneNode;

  if (updatedChild.type === "split" && updatedChild.direction === node.direction) {
    // Collapse-and-reflatten (see module doc comment on removePane): the
    // recursive call collapsed a nested split down to a single remaining
    // child that itself is a split sharing OUR direction. Splice its
    // children/sizes into ours — scaled to the slot the collapsing branch
    // occupied — instead of leaving a same-direction split nested inside a
    // same-direction split, which `PaneSplit`'s renderer would otherwise
    // treat as one combined resizable region instead of two independently
    // adjustable ones.
    const slotSize = node.sizes[idx];
    const scaledChildSizes = updatedChild.sizes.map((s) => s * slotSize);
    const children = [...node.children];
    children.splice(idx, 1, ...updatedChild.children);
    const sizes = [...node.sizes];
    sizes.splice(idx, 1, ...scaledChildSizes);
    return { ...node, children, sizes };
  }

  const children = [...node.children];
  children[idx] = updatedChild;
  return { ...node, children };
}

/**
 * Removes a leaf. If its parent split is left with exactly one child, that
 * split node is replaced by the remaining child — and if the remaining
 * child is itself a split sharing its new parent's direction (reachable via
 * an ordinary split -> perpendicular-split -> remove sequence), that child's
 * children/sizes are spliced into the new parent in place, so no split node
 * ever ends up directly nested inside another split node with the same
 * direction. Returns `null` if `paneId` was the tree's only leaf — the
 * caller closes the panel entirely in that case.
 */
export function removePane(tree: PaneNode, paneId: string): PaneNode | null {
  return removeFromNode(tree, paneId);
}

function findParentSplit(node: PaneNode, childId: string): SplitPane | null {
  if (node.type === "leaf") return null;
  if (node.children.some((child) => child.id === childId)) return node;
  for (const child of node.children) {
    const found = findParentSplit(child, childId);
    if (found) return found;
  }
  return null;
}

/**
 * Determines which leaf should become active if `removedPaneId` (currently
 * the active pane) is removed from `tree`: the first remaining child of the
 * removed leaf's former parent split — or, if that child is itself a split,
 * its first leaf — a fixed, deterministic rule rather than "whichever pane
 * was focused before." Returns `null` if `removedPaneId` is the tree's only
 * leaf (mirrors `removePane`'s own null case; the caller closes the panel
 * instead of reassigning focus).
 */
export function nextActivePane(tree: PaneNode, removedPaneId: string): string | null {
  const parent = findParentSplit(tree, removedPaneId);
  if (!parent) return null;
  const remaining = parent.children.filter((child) => child.id !== removedPaneId);
  const first = remaining[0];
  if (!first) return null;
  return first.type === "leaf" ? first.id : listLeaves(first)[0].id;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Adjusts `sizes[index]` and its neighbor `sizes[index + 1]` by `delta` (a
 * ratio, not pixels), clamped so neither drops below `minRatio`.
 */
export function resizeSplit(tree: PaneNode, splitId: string, index: number, delta: number, minRatio: number): PaneNode {
  if (tree.type === "leaf") return tree;
  if (tree.id === splitId) {
    const a = tree.sizes[index];
    const b = tree.sizes[index + 1];
    const lower = minRatio - a;
    const upper = b - minRatio;
    const clampedDelta = lower <= upper ? clamp(delta, lower, upper) : 0;
    const sizes = [...tree.sizes];
    sizes[index] = a + clampedDelta;
    sizes[index + 1] = b - clampedDelta;
    return { ...tree, sizes };
  }
  return { ...tree, children: tree.children.map((child) => resizeSplit(child, splitId, index, delta, minRatio)) };
}

export function listLeaves(tree: PaneNode): LeafPane[] {
  if (tree.type === "leaf") return [tree];
  return tree.children.flatMap(listLeaves);
}

export function findLeaf(tree: PaneNode, id: string): LeafPane | null {
  if (tree.type === "leaf") return tree.id === id ? tree : null;
  for (const child of tree.children) {
    const found = findLeaf(child, id);
    if (found) return found;
  }
  return null;
}

function mapLeaf(tree: PaneNode, leafId: string, fn: (leaf: LeafPane) => LeafPane): PaneNode {
  if (tree.type === "leaf") {
    return tree.id === leafId ? fn(tree) : tree;
  }
  return { ...tree, children: tree.children.map((child) => mapLeaf(child, leafId, fn)) };
}

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
