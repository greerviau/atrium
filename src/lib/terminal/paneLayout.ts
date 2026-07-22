import type { PaneNode, SplitAxis } from "./paneTree";

// A node's on-screen rectangle, in percent (0-100) relative to the flat
// root container `PaneSplit` renders into.
export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ResizerRect {
  key: string; // `${splitId}-${index}`
  splitId: string;
  index: number; // the sizes[index] / sizes[index+1] pair this resizer adjusts
  orientation: SplitAxis; // the owning split's direction — "row" -> vertical divider, "column" -> horizontal divider
  offsetPercent: number; // position along the split's own axis, percent of the flat root
  crossRect: { start: number; length: number }; // extent along the cross axis, percent of the flat root
}

/**
 * Walks `tree` once, recording every node's rectangle (leaf and split
 * alike — a split's own rectangle is needed later for resizer drag math)
 * as a percentage of the flat root container. A split's children each get
 * the parent's rectangle subdivided along `tree.direction` by the running
 * sum of `tree.sizes`, mirroring the ratio math `resizeSplit` (paneTree.ts)
 * already uses.
 */
export function computeRects(tree: PaneNode, rect: Rect, out: Map<string, Rect> = new Map()): Map<string, Rect> {
  out.set(tree.id, rect);

  if (tree.type === "leaf") return out;

  let offset = 0;
  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i];
    const ratio = tree.sizes[i];
    const childRect: Rect =
      tree.direction === "row"
        ? { top: rect.top, left: rect.left + offset * rect.width, width: ratio * rect.width, height: rect.height }
        : { top: rect.top + offset * rect.height, left: rect.left, width: rect.width, height: ratio * rect.height };
    computeRects(child, childRect, out);
    offset += ratio;
  }

  return out;
}

/**
 * Walks `tree` once and, for every split node, emits one `ResizerRect` per
 * adjacent child pair, positioned at the boundary between the two
 * children's rectangles already computed by `computeRects`.
 */
export function computeResizers(tree: PaneNode, rects: Map<string, Rect>, out: ResizerRect[] = []): ResizerRect[] {
  if (tree.type === "leaf") return out;

  const splitRect = rects.get(tree.id)!;
  for (let i = 1; i < tree.children.length; i++) {
    const prevRect = rects.get(tree.children[i - 1].id)!;
    const offsetPercent =
      tree.direction === "row" ? prevRect.left + prevRect.width : prevRect.top + prevRect.height;
    const crossRect =
      tree.direction === "row"
        ? { start: splitRect.top, length: splitRect.height }
        : { start: splitRect.left, length: splitRect.width };
    out.push({
      key: `${tree.id}-${i - 1}`,
      splitId: tree.id,
      index: i - 1,
      orientation: tree.direction,
      offsetPercent,
      crossRect,
    });
  }

  for (const child of tree.children) {
    computeResizers(child, rects, out);
  }

  return out;
}
