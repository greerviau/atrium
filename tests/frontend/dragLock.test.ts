import { describe, it, expect, afterEach } from "vitest";
import { armDragSelectionGuard, beginDragLock, endDragLock } from "../../src/lib/ui/dragLock";

/** A selectstart event dispatched from `target`, bubbling to the document-level capture listener the same way a real WebKit-initiated selection would. Returns whether it was prevented. */
function dispatchSelectStart(target: EventTarget = document): boolean {
  const event = new Event("selectstart", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("dragLock", () => {
  afterEach(() => {
    endDragLock();
  });

  it("beginDragLock sets the cursor attribute and both user-select styles", () => {
    beginDragLock("grabbing");
    expect(document.documentElement.dataset.dragCursor).toBe("grabbing");
    expect(document.documentElement.style.userSelect).toBe("none");
    expect(document.documentElement.style.webkitUserSelect).toBe("none");
  });

  it("a selectstart dispatched from a nested element is prevented after beginDragLock", () => {
    const nested = document.createElement("div");
    document.body.appendChild(nested);
    beginDragLock("grabbing");
    expect(dispatchSelectStart(nested)).toBe(true);
    nested.remove();
  });

  it("armDragSelectionGuard alone prevents selectstart while writing neither the cursor attribute nor the user-select styles", () => {
    armDragSelectionGuard();
    expect(dispatchSelectStart()).toBe(true);
    expect(document.documentElement.dataset.dragCursor).toBeUndefined();
    expect(document.documentElement.style.userSelect).toBe("");
    expect(document.documentElement.style.webkitUserSelect).toBe("");
  });

  it("beginDragLock upgrades an armed guard in place, and one endDragLock fully clears the result", () => {
    armDragSelectionGuard();
    beginDragLock("col-resize");
    expect(document.documentElement.dataset.dragCursor).toBe("col-resize");
    expect(dispatchSelectStart()).toBe(true);

    endDragLock();
    expect(document.documentElement.dataset.dragCursor).toBeUndefined();
    expect(document.documentElement.style.userSelect).toBe("");
    expect(document.documentElement.style.webkitUserSelect).toBe("");
    expect(dispatchSelectStart()).toBe(false);
  });

  it("endDragLock clears the attribute, both inline styles, and the guard", () => {
    beginDragLock("row-resize");
    endDragLock();
    expect(document.documentElement.dataset.dragCursor).toBeUndefined();
    expect(document.documentElement.style.userSelect).toBe("");
    expect(document.documentElement.style.webkitUserSelect).toBe("");
    expect(dispatchSelectStart()).toBe(false);
  });

  it("calling endDragLock twice, or without a preceding arm or begin, throws nothing and leaves the document clean", () => {
    expect(() => endDragLock()).not.toThrow();
    expect(() => endDragLock()).not.toThrow();
    beginDragLock("grabbing");
    endDragLock();
    expect(() => endDragLock()).not.toThrow();
    expect(document.documentElement.dataset.dragCursor).toBeUndefined();
    expect(dispatchSelectStart()).toBe(false);
  });
});
