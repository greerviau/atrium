import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveTabDropTarget } from "../../src/lib/panes/tabDropTargets";

function pane(): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "editor-area";
  const leaf = document.createElement("div");
  leaf.className = "pane-leaf";
  leaf.dataset.paneId = "pane-1";
  const tabs = document.createElement("div");
  tabs.className = "tab-strip";
  leaf.append(tabs);
  root.append(leaf);
  document.body.append(root);
  Object.defineProperty(document, "elementFromPoint", { value: () => null, configurable: true });
  vi.spyOn(leaf, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 400,
    bottom: 400,
    width: 400,
    height: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return leaf;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("resolveTabDropTarget", () => {
  it("merges when the pointer is over a tab strip", () => {
    const leaf = pane();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(leaf.querySelector(".tab-strip"));

    expect(resolveTabDropTarget("editor", 20, 20)).toEqual({ paneId: "pane-1", zone: "center" });
  });

  it("resolves pane edges to split directions", () => {
    const leaf = pane();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(leaf);

    expect(resolveTabDropTarget("editor", 20, 200)).toEqual({ paneId: "pane-1", zone: "left" });
    expect(resolveTabDropTarget("editor", 380, 200)).toEqual({ paneId: "pane-1", zone: "right" });
    expect(resolveTabDropTarget("editor", 200, 20)).toEqual({ paneId: "pane-1", zone: "up" });
    expect(resolveTabDropTarget("editor", 200, 380)).toEqual({ paneId: "pane-1", zone: "down" });
  });

  it("uses the center zone away from all edges", () => {
    const leaf = pane();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(leaf);

    expect(resolveTabDropTarget("editor", 200, 200)).toEqual({ paneId: "pane-1", zone: "center" });
  });
});
