import { describe, it, expect } from "vitest";
import {
  splitPane,
  removePane,
  resizeSplit,
  listLeaves,
  findLeaf,
  addTabToLeaf,
  closeTabInLeaf,
  setActiveTabInLeaf,
  nextActivePane,
  pruneMissingTabs,
  PANE_MIN_PX,
  type EditorPaneNode,
  type EditorLeafPane,
  type EditorSplitPane,
} from "../../src/lib/editor/editorPaneTree";

function leaf(id: string, tabs: string[] = [`${id}.txt`]): EditorLeafPane {
  return { type: "leaf", id, tabs, activeTabPath: tabs[tabs.length - 1] ?? null };
}

function asSplit(node: EditorPaneNode): EditorSplitPane {
  if (node.type !== "split") throw new Error(`expected a split node, got ${node.type}`);
  return node;
}

describe("splitPane (editor leaves)", () => {
  it("wraps a leaf-only tree into a row split with the target first and the new leaf second (right)", () => {
    const tree = leaf("L1");
    const result = asSplit(splitPane(tree, "L1", "right", leaf("L2")));

    expect(result.direction).toBe("row");
    expect(result.children.map((c) => c.id)).toEqual(["L1", "L2"]);
    expect(result.sizes).toEqual([0.5, 0.5]);
  });

  it("leaves the tree unchanged when the target id doesn't exist", () => {
    const tree = leaf("L1");
    const result = splitPane(tree, "does-not-exist", "right", leaf("L2"));
    expect(result).toEqual(tree);
  });
});

describe("removePane (editor leaves)", () => {
  it("returns null when removing the tree's only leaf", () => {
    expect(removePane(leaf("L1"), "L1")).toBeNull();
  });

  it("collapses a split with one remaining child into that child directly", () => {
    const tree = splitPane(leaf("L1"), "L1", "right", leaf("L2"));
    const result = removePane(tree, "L2");
    expect(result).toEqual(leaf("L1"));
  });
});

describe("resizeSplit (editor leaves)", () => {
  it("shifts the ratio between a pane and its neighbor by delta", () => {
    const tree = splitPane(leaf("L1"), "L1", "right", leaf("L2"));
    const splitId = asSplit(tree).id;

    const result = asSplit(resizeSplit(tree, splitId, 0, 0.1, 0.05));
    expect(result.sizes[0]).toBeCloseTo(0.6);
    expect(result.sizes[1]).toBeCloseTo(0.4);
  });

  it("exposes PANE_MIN_PX for the rendering layer to derive a minRatio from container size", () => {
    expect(PANE_MIN_PX).toBeGreaterThan(0);
  });
});

describe("listLeaves / findLeaf (editor leaves)", () => {
  it("listLeaves collects every leaf across a nested tree", () => {
    let tree: EditorPaneNode = splitPane(leaf("L1"), "L1", "right", leaf("L2"));
    tree = splitPane(tree, "L2", "down", leaf("L3"));
    expect(listLeaves(tree).map((l) => l.id).sort()).toEqual(["L1", "L2", "L3"]);
  });

  it("findLeaf finds a nested leaf by id and returns null for a missing one", () => {
    const tree = splitPane(leaf("L1"), "L1", "right", leaf("L2"));
    expect(findLeaf(tree, "L2")?.id).toBe("L2");
    expect(findLeaf(tree, "missing")).toBeNull();
  });
});

describe("leaf-local tab operations", () => {
  it("addTabToLeaf appends a path to the target leaf's tabs and makes it active", () => {
    const tree = splitPane(leaf("L1"), "L1", "right", leaf("L2"));
    const result = addTabToLeaf(tree, "L2", "new.txt");

    const target = findLeaf(result, "L2")!;
    expect(target.tabs).toEqual(["L2.txt", "new.txt"]);
    expect(target.activeTabPath).toBe("new.txt");
    // Sibling leaf is untouched.
    expect(findLeaf(result, "L1")).toEqual(findLeaf(tree, "L1"));
  });

  it("addTabToLeaf is a no-op append when the path is already in this leaf's tabs — it just switches active", () => {
    const tree = leaf("L1", ["a.txt", "b.txt"]);
    const result = addTabToLeaf(tree, "L1", "a.txt");

    const target = findLeaf(result, "L1")!;
    expect(target.tabs).toEqual(["a.txt", "b.txt"]);
    expect(target.activeTabPath).toBe("a.txt");
  });

  it("setActiveTabInLeaf switches which tab is active without touching the tab list", () => {
    let tree: EditorPaneNode = leaf("L1", ["a.txt"]);
    tree = addTabToLeaf(tree, "L1", "b.txt");
    tree = setActiveTabInLeaf(tree, "L1", "a.txt");

    const target = findLeaf(tree, "L1")!;
    expect(target.activeTabPath).toBe("a.txt");
    expect(target.tabs).toEqual(["a.txt", "b.txt"]);
  });

  it("closeTabInLeaf removes a non-active path without disturbing the active one", () => {
    let tree: EditorPaneNode = leaf("L1", ["a.txt"]);
    tree = addTabToLeaf(tree, "L1", "b.txt");
    tree = setActiveTabInLeaf(tree, "L1", "a.txt");
    tree = closeTabInLeaf(tree, "L1", "b.txt")!;

    const target = findLeaf(tree, "L1")!;
    expect(target.tabs).toEqual(["a.txt"]);
    expect(target.activeTabPath).toBe("a.txt");
  });

  it("closeTabInLeaf falls back to the new last tab when the active path closes", () => {
    let tree: EditorPaneNode = leaf("L1", ["a.txt"]);
    tree = addTabToLeaf(tree, "L1", "b.txt");
    tree = addTabToLeaf(tree, "L1", "c.txt");
    tree = setActiveTabInLeaf(tree, "L1", "b.txt");
    tree = closeTabInLeaf(tree, "L1", "b.txt")!;

    const target = findLeaf(tree, "L1")!;
    expect(target.tabs).toEqual(["a.txt", "c.txt"]);
    expect(target.activeTabPath).toBe("c.txt");
  });

  it("closeTabInLeaf removes the whole leaf from the tree once its last tab closes", () => {
    const tree = splitPane(leaf("L1"), "L1", "right", leaf("L2"));
    const result = closeTabInLeaf(tree, "L2", "L2.txt");
    expect(result).toEqual(leaf("L1"));
  });

  it("closeTabInLeaf returns null when closing the tree's only leaf's only tab", () => {
    expect(closeTabInLeaf(leaf("L1"), "L1", "L1.txt")).toBeNull();
  });
});

describe("nextActivePane (editor leaves)", () => {
  it("returns null when the removed pane is the tree's only leaf", () => {
    expect(nextActivePane(leaf("L1"), "L1")).toBeNull();
  });

  it("returns the first remaining sibling when it's a leaf", () => {
    let tree = splitPane(leaf("L1"), "L1", "right", leaf("L2"));
    tree = splitPane(tree, "L2", "right", leaf("L3"));
    expect(nextActivePane(tree, "L2")).toBe("L1");
  });
});

describe("pruneMissingTabs", () => {
  it("is a no-op when every leaf's tabs are all still open", () => {
    const tree = splitPane(leaf("L1"), "L1", "right", leaf("L2"));
    const result = pruneMissingTabs(tree, new Set(["L1.txt", "L2.txt"]));
    expect(result).toEqual(tree);
  });

  it("drops a closed path from a leaf that has other tabs, falling back active to the new last tab", () => {
    let tree: EditorPaneNode = leaf("L1", ["a.txt", "b.txt"]);
    tree = setActiveTabInLeaf(tree, "L1", "b.txt");

    const result = pruneMissingTabs(tree, new Set(["a.txt"]))!;
    const target = findLeaf(result, "L1")!;
    expect(target.tabs).toEqual(["a.txt"]);
    expect(target.activeTabPath).toBe("a.txt");
  });

  it("removes a leaf entirely once its only tab is no longer open, leaving siblings untouched", () => {
    const tree = splitPane(leaf("L1", ["only.txt"]), "L1", "right", leaf("L2", ["kept.txt"]));
    const result = pruneMissingTabs(tree, new Set(["kept.txt"]));
    expect(result).toEqual(leaf("L2", ["kept.txt"]));
  });

  it("returns null once every leaf's tabs are gone", () => {
    const tree = splitPane(leaf("L1", ["a.txt"]), "L1", "right", leaf("L2", ["a.txt"]));
    expect(pruneMissingTabs(tree, new Set())).toBeNull();
  });

  it("leaves a duplicated path (open in two leaves) alone in the leaf where it's still open, and removes it from the one where it isn't", () => {
    const tree = splitPane(leaf("L1", ["shared.txt"]), "L1", "right", leaf("L2", ["shared.txt", "other.txt"]));
    const result = pruneMissingTabs(tree, new Set(["shared.txt"]))!;
    expect(findLeaf(result, "L1")?.tabs).toEqual(["shared.txt"]);
    expect(findLeaf(result, "L2")?.tabs).toEqual(["shared.txt"]);
  });
});
