import { describe, it, expect, vi } from "vitest";
import { registerTerminalDropTarget, insertPathsAtScreenPoint } from "../../src/lib/terminal/terminalDropTargets";

/** Stubs `document.elementFromPoint` (jsdom has no implementation of its own at all) to resolve to a given element, the same style of DOM-API stub `terminalDragDrop.test.ts` already uses for `window.matchMedia`/`ResizeObserver`. */
function stubElementFromPoint(el: Element | null): void {
  document.elementFromPoint = vi.fn().mockReturnValue(el);
}

describe("terminalDropTargets", () => {
  it("invokes the registered callback with the given paths when the hit point resolves to the exact registered element", () => {
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    const insert = vi.fn();
    registerTerminalDropTarget(pane, insert);
    stubElementFromPoint(pane);

    insertPathsAtScreenPoint(["/a/b"], 10, 20);

    expect(insert).toHaveBeenCalledWith(["/a/b"]);
  });

  it("invokes the right callback when the hit point resolves to a descendant of a registered .terminal-pane element", () => {
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    const child = document.createElement("textarea");
    pane.appendChild(child);
    const insert = vi.fn();
    registerTerminalDropTarget(pane, insert);
    stubElementFromPoint(child);

    insertPathsAtScreenPoint(["/a/b"], 10, 20);

    expect(insert).toHaveBeenCalledWith(["/a/b"]);
  });

  it("is a no-op when the hit point resolves to an element with no .terminal-pane ancestor", () => {
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    const insert = vi.fn();
    registerTerminalDropTarget(pane, insert);

    const outsider = document.createElement("div");
    outsider.className = "explorer";
    stubElementFromPoint(outsider);

    expect(() => insertPathsAtScreenPoint(["/a/b"], 10, 20)).not.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });

  it("is a no-op when elementFromPoint finds nothing", () => {
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    const insert = vi.fn();
    registerTerminalDropTarget(pane, insert);
    stubElementFromPoint(null);

    expect(() => insertPathsAtScreenPoint(["/a/b"], 10, 20)).not.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });

  it("invokes only the hit target's own callback when two distinct targets are registered", () => {
    const paneA = document.createElement("div");
    paneA.className = "terminal-pane";
    const insertA = vi.fn();
    registerTerminalDropTarget(paneA, insertA);

    const paneB = document.createElement("div");
    paneB.className = "terminal-pane";
    const insertB = vi.fn();
    registerTerminalDropTarget(paneB, insertB);

    stubElementFromPoint(paneB);
    insertPathsAtScreenPoint(["/a/b"], 10, 20);

    expect(insertB).toHaveBeenCalledWith(["/a/b"]);
    expect(insertA).not.toHaveBeenCalled();
  });

  it("stops invoking a callback once its registration has been unregistered", () => {
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    const insert = vi.fn();
    const unregister = registerTerminalDropTarget(pane, insert);
    stubElementFromPoint(pane);

    unregister();
    insertPathsAtScreenPoint(["/a/b"], 10, 20);

    expect(insert).not.toHaveBeenCalled();
  });
});
