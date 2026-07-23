import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveExplorerDropTargetDir } from "../../src/lib/explorer/explorerDropTargets";
import { fileTree } from "../../src/lib/stores/fileTree";

const ROOT = "/workspace";

/** Stubs `document.elementFromPoint` (jsdom has no implementation of its own at all), the same style `terminalDropTargets.test.ts` uses. */
function stubElementFromPoint(el: Element | null): void {
  document.elementFromPoint = vi.fn().mockReturnValue(el);
}

function setRoot(): void {
  fileTree.set({
    root: {
      entry: { name: "workspace", path: ROOT, isDir: true, isSymlink: false },
      expanded: true,
      children: [],
    },
  });
}

describe("explorerDropTargets", () => {
  afterEach(() => {
    fileTree.set({ root: null });
  });

  it("resolves to null when the hit point has no .file-tree ancestor at all", () => {
    const outsider = document.createElement("div");
    outsider.className = "terminal-pane";
    stubElementFromPoint(outsider);

    expect(resolveExplorerDropTargetDir(10, 20)).toBeNull();
  });

  it("resolves to null when elementFromPoint finds nothing", () => {
    stubElementFromPoint(null);

    expect(resolveExplorerDropTargetDir(10, 20)).toBeNull();
  });

  it("resolves to a directory row's own path", () => {
    setRoot();
    const tree = document.createElement("div");
    tree.className = "file-tree";
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.path = `${ROOT}/src`;
    row.dataset.isDir = "true";
    tree.appendChild(row);
    document.body.appendChild(tree);
    stubElementFromPoint(row);

    expect(resolveExplorerDropTargetDir(10, 20)).toBe(`${ROOT}/src`);

    tree.remove();
  });

  it("resolves to a file row's parent directory", () => {
    setRoot();
    const tree = document.createElement("div");
    tree.className = "file-tree";
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.path = `${ROOT}/src/main.ts`;
    row.dataset.isDir = "false";
    tree.appendChild(row);
    document.body.appendChild(tree);
    stubElementFromPoint(row);

    expect(resolveExplorerDropTargetDir(10, 20)).toBe(`${ROOT}/src`);

    tree.remove();
  });

  it("resolves to a descendant hit (e.g. the row's icon or label) the same as the row itself", () => {
    setRoot();
    const tree = document.createElement("div");
    tree.className = "file-tree";
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.path = `${ROOT}/src`;
    row.dataset.isDir = "true";
    const label = document.createElement("span");
    row.appendChild(label);
    tree.appendChild(row);
    document.body.appendChild(tree);
    stubElementFromPoint(label);

    expect(resolveExplorerDropTargetDir(10, 20)).toBe(`${ROOT}/src`);

    tree.remove();
  });

  it("resolves to the workspace root when the point is inside .file-tree but over no row (empty space)", () => {
    setRoot();
    const tree = document.createElement("div");
    tree.className = "file-tree";
    document.body.appendChild(tree);
    stubElementFromPoint(tree);

    expect(resolveExplorerDropTargetDir(10, 20)).toBe(ROOT);

    tree.remove();
  });
});
