import { describe, it, expect } from "vitest";
import {
  splitPane,
  removePane,
  resizeSplit,
  listLeaves,
  findLeaf,
  updateLeaf,
  nextActivePane,
  PANE_MIN_PX,
  type PaneNode,
  type LeafPane,
  type SplitPane,
} from "../../src/lib/terminal/paneTree";

function leaf(id: string, cwd = "/proj"): LeafPane {
  return { type: "leaf", id, cwd, title: id };
}

function asSplit(node: PaneNode): SplitPane {
  if (node.type !== "split") throw new Error(`expected a split node, got ${node.type}`);
  return node;
}

/** No `SplitPane` in `tree` has the same `direction` as its immediate parent. */
function hasNoSameDirectionNesting(node: PaneNode, parentDirection: SplitPane["direction"] | null = null): boolean {
  if (node.type === "leaf") return true;
  if (node.direction === parentDirection) return false;
  return node.children.every((child) => hasNoSameDirectionNesting(child, node.direction));
}

describe("splitPane", () => {
  it("wraps a leaf-only tree into a split with the target first and the new leaf second", () => {
    const tree = leaf("L1");
    const result = asSplit(splitPane(tree, "L1", "row", leaf("L2")));

    expect(result.direction).toBe("row");
    expect(result.children.map((c) => c.id)).toEqual(["L1", "L2"]);
    expect(result.sizes).toEqual([0.5, 0.5]);
  });

  it("nests a perpendicular split inside an existing split rather than flattening it", () => {
    const tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    const result = asSplit(splitPane(tree, "L2", "column", leaf("L3")));

    const nested = asSplit(result.children[1]);
    expect(nested.direction).toBe("column");
    expect(nested.children.map((c) => c.id)).toEqual(["L2", "L3"]);
  });

  it("appends to the parent split instead of nesting when the direction matches", () => {
    const tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    const result = asSplit(splitPane(tree, "L2", "row", leaf("L3")));

    expect(result.type).toBe("split");
    expect(result.children.map((c) => c.id)).toEqual(["L1", "L2", "L3"]);
    expect(result.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // Three equal panes after two same-direction row splits.
    expect(result.sizes[0]).toBeCloseTo(1 / 3);
    expect(result.sizes[1]).toBeCloseTo(1 / 3);
    expect(result.sizes[2]).toBeCloseTo(1 / 3);
  });

  it("splits a leaf nested several levels deep", () => {
    let tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    tree = splitPane(tree, "L2", "column", leaf("L3"));
    tree = splitPane(tree, "L3", "row", leaf("L4"));

    const found = findLeaf(tree, "L4");
    expect(found).not.toBeNull();
    expect(hasNoSameDirectionNesting(tree)).toBe(true);
  });

  it("leaves the tree unchanged when the target id doesn't exist", () => {
    const tree = leaf("L1");
    const result = splitPane(tree, "does-not-exist", "row", leaf("L2"));
    expect(result).toEqual(tree);
  });
});

describe("removePane", () => {
  it("returns null when removing the tree's only leaf", () => {
    expect(removePane(leaf("L1"), "L1")).toBeNull();
  });

  it("collapses a split with one remaining child into that child directly", () => {
    const tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    const result = removePane(tree, "L2");
    expect(result).toEqual(leaf("L1"));
  });

  it("renormalizes sizes after removing one of three siblings", () => {
    let tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    tree = splitPane(tree, "L2", "row", leaf("L3"));

    const result = asSplit(removePane(tree, "L2")!);
    expect(result.children.map((c) => c.id)).toEqual(["L1", "L3"]);
    expect(result.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("removes a deeply nested leaf without disturbing sibling branches", () => {
    let tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    tree = splitPane(tree, "L2", "column", leaf("L3"));

    const result = removePane(tree, "L3")!;
    expect(listLeaves(result).map((l) => l.id).sort()).toEqual(["L1", "L2"]);
  });

  it("regression: split -> perpendicular-split -> perpendicular-split -> remove must not leave a same-direction split nested inside a same-direction split", () => {
    // Build: row[L1, column[L2, row[L3, L4]]]
    let tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    tree = splitPane(tree, "L2", "column", leaf("L3"));
    tree = splitPane(tree, "L3", "row", leaf("L4"));
    expect(hasNoSameDirectionNesting(tree)).toBe(true);

    // Removing L2 collapses its column parent down to its remaining child
    // (row[L3, L4]), which now sits directly under the outer row split —
    // without the reflatten fix this leaves row containing a nested row.
    const result = removePane(tree, "L2")!;

    expect(hasNoSameDirectionNesting(result)).toBe(true);
    const top = asSplit(result);
    expect(top.direction).toBe("row");
    expect(top.children.map((c) => c.id)).toEqual(["L1", "L3", "L4"]);
    expect(top.children.every((c) => c.type === "leaf")).toBe(true);
    expect(top.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});

describe("resizeSplit", () => {
  it("shifts the ratio between a pane and its neighbor by delta", () => {
    const tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    const splitId = asSplit(tree).id;

    const result = asSplit(resizeSplit(tree, splitId, 0, 0.1, 0.05));
    expect(result.sizes[0]).toBeCloseTo(0.6);
    expect(result.sizes[1]).toBeCloseTo(0.4);
  });

  it("clamps so neither side drops below minRatio", () => {
    const tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    const splitId = asSplit(tree).id;

    const result = asSplit(resizeSplit(tree, splitId, 0, 0.9, 0.1));
    expect(result.sizes[0]).toBeCloseTo(0.9);
    expect(result.sizes[1]).toBeCloseTo(0.1);
  });

  it("clamps a negative delta symmetrically", () => {
    const tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    const splitId = asSplit(tree).id;

    const result = asSplit(resizeSplit(tree, splitId, 0, -0.9, 0.1));
    expect(result.sizes[0]).toBeCloseTo(0.1);
    expect(result.sizes[1]).toBeCloseTo(0.9);
  });

  it("only touches the targeted split node in a nested tree", () => {
    let tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    tree = splitPane(tree, "L2", "column", leaf("L3"));
    const outerId = asSplit(tree).id;

    const result = asSplit(resizeSplit(tree, outerId, 0, 0.2, 0.05));
    const inner = asSplit(result.children[1]);
    expect(inner.sizes).toEqual([0.5, 0.5]);
  });

  it("exposes PANE_MIN_PX for the rendering layer to derive a minRatio from container size", () => {
    expect(PANE_MIN_PX).toBeGreaterThan(0);
  });
});

describe("listLeaves / findLeaf / updateLeaf", () => {
  it("listLeaves returns a single-item list for a leaf-only tree", () => {
    expect(listLeaves(leaf("L1"))).toEqual([leaf("L1")]);
  });

  it("listLeaves collects every leaf across a nested tree", () => {
    let tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    tree = splitPane(tree, "L2", "column", leaf("L3"));
    expect(listLeaves(tree).map((l) => l.id).sort()).toEqual(["L1", "L2", "L3"]);
  });

  it("findLeaf finds a nested leaf by id and returns null for a missing one", () => {
    let tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    tree = splitPane(tree, "L2", "column", leaf("L3"));
    expect(findLeaf(tree, "L3")?.id).toBe("L3");
    expect(findLeaf(tree, "missing")).toBeNull();
  });

  it("updateLeaf patches only the matching leaf's fields", () => {
    const tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    const result = updateLeaf(tree, "L2", { title: "npm" });
    expect(findLeaf(result, "L2")?.title).toBe("npm");
    expect(findLeaf(result, "L1")?.title).toBe("L1");
  });
});

describe("nextActivePane", () => {
  it("returns null when the removed pane is the tree's only leaf", () => {
    expect(nextActivePane(leaf("L1"), "L1")).toBeNull();
  });

  it("returns the first remaining sibling when it's a leaf", () => {
    let tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    tree = splitPane(tree, "L2", "row", leaf("L3"));
    expect(nextActivePane(tree, "L2")).toBe("L1");
  });

  it("descends into a remaining split sibling to its first leaf", () => {
    const tree = splitPane(leaf("L1"), "L1", "row", leaf("L2"));
    const withNested = splitPane(tree, "L1", "column", leaf("L3"));
    // withNested: row[column[L1, L3], L2] — removing L2 should fall back
    // into the remaining column sibling's first leaf, L1.
    expect(nextActivePane(withNested, "L2")).toBe("L1");
  });
});
