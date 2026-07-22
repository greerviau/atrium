import { describe, it, expect } from "vitest";
import { computeRects, computeResizers, type Rect } from "../../src/lib/terminal/paneLayout";
import type { LeafPane, PaneNode, SplitPane } from "../../src/lib/terminal/paneTree";

function leaf(id: string): LeafPane {
  return { type: "leaf", id, tabs: [{ id: `${id}-tab`, cwd: "/proj", title: id }], activeTabId: `${id}-tab` };
}

const ROOT: Rect = { top: 0, left: 0, width: 100, height: 100 };

describe("computeRects", () => {
  it("gives a lone leaf the entire root rectangle", () => {
    const rects = computeRects(leaf("p1"), ROOT);
    expect(rects.get("p1")).toEqual(ROOT);
  });

  it("splits a two-child row split 50/50", () => {
    const tree: SplitPane = { type: "split", id: "s1", direction: "row", children: [leaf("p1"), leaf("p2")], sizes: [0.5, 0.5] };
    const rects = computeRects(tree, ROOT);

    expect(rects.get("s1")).toEqual(ROOT);
    expect(rects.get("p1")).toEqual({ top: 0, left: 0, width: 50, height: 100 });
    expect(rects.get("p2")).toEqual({ top: 0, left: 50, width: 50, height: 100 });
  });

  it("splits a two-child column split by height, top to bottom", () => {
    const tree: SplitPane = { type: "split", id: "s1", direction: "column", children: [leaf("p1"), leaf("p2")], sizes: [0.3, 0.7] };
    const rects = computeRects(tree, ROOT);

    expect(rects.get("p1")).toEqual({ top: 0, left: 0, width: 100, height: 30 });
    expect(rects.get("p2")).toEqual({ top: 30, left: 0, width: 100, height: 70 });
  });

  it("handles an uneven three-child split", () => {
    const tree: SplitPane = {
      type: "split",
      id: "s1",
      direction: "row",
      children: [leaf("p1"), leaf("p2"), leaf("p3")],
      sizes: [0.2, 0.3, 0.5],
    };
    const rects = computeRects(tree, ROOT);

    expect(rects.get("p1")).toEqual({ top: 0, left: 0, width: 20, height: 100 });
    expect(rects.get("p2")).toEqual({ top: 0, left: 20, width: 30, height: 100 });
    expect(rects.get("p3")).toEqual({ top: 0, left: 50, width: 50, height: 100 });
  });

  it("computes exact percentages for a nested mixed-direction split", () => {
    // A row split [leaf, column-split] with ratios 0.4/0.6, the nested
    // column split itself divided 0.25/0.75.
    const inner: SplitPane = {
      type: "split",
      id: "s2",
      direction: "column",
      children: [leaf("p2"), leaf("p3")],
      sizes: [0.25, 0.75],
    };
    const outer: PaneNode = { type: "split", id: "s1", direction: "row", children: [leaf("p1"), inner], sizes: [0.4, 0.6] };

    const rects = computeRects(outer, ROOT);

    expect(rects.get("p1")).toEqual({ top: 0, left: 0, width: 40, height: 100 });
    expect(rects.get("s2")).toEqual({ top: 0, left: 40, width: 60, height: 100 });
    expect(rects.get("p2")).toEqual({ top: 0, left: 40, width: 60, height: 25 });
    expect(rects.get("p3")).toEqual({ top: 25, left: 40, width: 60, height: 75 });
  });
});

describe("computeResizers", () => {
  it("emits nothing for a lone leaf", () => {
    const tree = leaf("p1");
    const resizers = computeResizers(tree, computeRects(tree, ROOT));
    expect(resizers).toEqual([]);
  });

  it("emits one resizer at the boundary between two row children", () => {
    const tree: SplitPane = { type: "split", id: "s1", direction: "row", children: [leaf("p1"), leaf("p2")], sizes: [0.5, 0.5] };
    const resizers = computeResizers(tree, computeRects(tree, ROOT));

    expect(resizers).toEqual([
      {
        key: "s1-0",
        splitId: "s1",
        index: 0,
        orientation: "row",
        offsetPercent: 50,
        crossRect: { start: 0, length: 100 },
      },
    ]);
  });

  it("emits one resizer per adjacent pair for a multi-child split", () => {
    const tree: SplitPane = {
      type: "split",
      id: "s1",
      direction: "column",
      children: [leaf("p1"), leaf("p2"), leaf("p3")],
      sizes: [0.2, 0.3, 0.5],
    };
    const resizers = computeResizers(tree, computeRects(tree, ROOT));

    expect(resizers).toHaveLength(2);
    expect(resizers[0]).toEqual({
      key: "s1-0",
      splitId: "s1",
      index: 0,
      orientation: "column",
      offsetPercent: 20,
      crossRect: { start: 0, length: 100 },
    });
    expect(resizers[1]).toEqual({
      key: "s1-1",
      splitId: "s1",
      index: 1,
      orientation: "column",
      offsetPercent: 50,
      crossRect: { start: 0, length: 100 },
    });
  });

  it("recurses into nested splits, positioning each resizer against its own owning split's rectangle", () => {
    const inner: SplitPane = {
      type: "split",
      id: "s2",
      direction: "column",
      children: [leaf("p2"), leaf("p3")],
      sizes: [0.25, 0.75],
    };
    const outer: PaneNode = { type: "split", id: "s1", direction: "row", children: [leaf("p1"), inner], sizes: [0.4, 0.6] };
    const rects = computeRects(outer, ROOT);
    const resizers = computeResizers(outer, rects);

    expect(resizers).toEqual([
      { key: "s1-0", splitId: "s1", index: 0, orientation: "row", offsetPercent: 40, crossRect: { start: 0, length: 100 } },
      { key: "s2-0", splitId: "s2", index: 0, orientation: "column", offsetPercent: 25, crossRect: { start: 40, length: 60 } },
    ]);
  });
});
