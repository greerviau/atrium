import { describe, it, expect, vi } from "vitest";
import { resolveEditorDropTarget } from "../../src/lib/editor/editorDropTargets";

/** Stubs `document.elementFromPoint` (jsdom has no implementation of its own at all), the same style `explorerDropTargets.test.ts`/`terminalDropTargets.test.ts` use. */
function stubElementFromPoint(el: Element | null): void {
  document.elementFromPoint = vi.fn().mockReturnValue(el);
}

describe("editorDropTargets", () => {
  it("resolves to null when the hit point has no .editor-area ancestor at all", () => {
    const outsider = document.createElement("div");
    outsider.className = "terminal-pane";
    stubElementFromPoint(outsider);

    expect(resolveEditorDropTarget(10, 20)).toBeNull();
  });

  it("resolves to null when elementFromPoint finds nothing", () => {
    stubElementFromPoint(null);

    expect(resolveEditorDropTarget(10, 20)).toBeNull();
  });

  it("resolves to { paneId: null } when the point is inside .editor-area but over no specific pane", () => {
    const area = document.createElement("div");
    area.className = "editor-area";
    document.body.appendChild(area);
    stubElementFromPoint(area);

    expect(resolveEditorDropTarget(10, 20)).toEqual({ paneId: null });

    area.remove();
  });

  it("resolves to the hovered pane leaf's own data-pane-id", () => {
    const area = document.createElement("div");
    area.className = "editor-area";
    const leaf = document.createElement("div");
    leaf.className = "pane-leaf";
    leaf.dataset.paneId = "pane-1";
    area.appendChild(leaf);
    document.body.appendChild(area);
    stubElementFromPoint(leaf);

    expect(resolveEditorDropTarget(10, 20)).toEqual({ paneId: "pane-1" });

    area.remove();
  });

  it("resolves to the hovered pane leaf's data-pane-id for a descendant hit (e.g. the CodeMirror content)", () => {
    const area = document.createElement("div");
    area.className = "editor-area";
    const leaf = document.createElement("div");
    leaf.className = "pane-leaf";
    leaf.dataset.paneId = "pane-2";
    const inner = document.createElement("span");
    leaf.appendChild(inner);
    area.appendChild(leaf);
    document.body.appendChild(area);
    stubElementFromPoint(inner);

    expect(resolveEditorDropTarget(10, 20)).toEqual({ paneId: "pane-2" });

    area.remove();
  });
});
