import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import ContextMenuHost from "./ContextMenuHost.svelte";
import AnchorContextMenuHost from "./AnchorContextMenuHost.svelte";

/**
 * jsdom has no real layout engine, so `getBoundingClientRect()` normally
 * returns all zeros. These tests stub it to a fixed menu size to exercise
 * `ContextMenu`'s viewport-clamping math the way a real browser would.
 */
function stubMenuSize(width: number, height: number): void {
  Element.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      toJSON() {
        return this;
      },
    }) as DOMRect;
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

describe("ContextMenu: viewport clamping", () => {
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    setViewport(1024, 768);
  });

  afterEach(() => {
    cleanup();
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it("opens directly at the anchor point when there is room", () => {
    stubMenuSize(160, 145);
    const { container } = render(ContextMenuHost, { x: 100, y: 100 });
    const menu = container.querySelector(".context-menu") as HTMLElement;
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("100px");
  });

  it("flips upward instead of overflowing the bottom edge", () => {
    stubMenuSize(160, 145);
    // Anchor near the bottom of a 768px-tall viewport, as if the user
    // right-clicked a row near the end of a long file list.
    const { container } = render(ContextMenuHost, { x: 100, y: 760 });
    const menu = container.querySelector(".context-menu") as HTMLElement;
    expect(menu.style.top).toBe("615px"); // 760 - 145
    expect(parseFloat(menu.style.top) + 145).toBeLessThanOrEqual(768);
  });

  it("shifts left instead of overflowing the right edge", () => {
    stubMenuSize(160, 145);
    const { container } = render(ContextMenuHost, { x: 1000, y: 100 });
    const menu = container.querySelector(".context-menu") as HTMLElement;
    expect(menu.style.left).toBe("840px"); // 1000 - 160
    expect(parseFloat(menu.style.left) + 160).toBeLessThanOrEqual(1024);
  });

  it("clamps to the top edge when the menu is taller than the viewport", () => {
    stubMenuSize(160, 900);
    const { container } = render(ContextMenuHost, { x: 100, y: 760 });
    const menu = container.querySelector(".context-menu") as HTMLElement;
    expect(menu.style.top).toBe("4px");
  });

  it("re-clamps on an already-open menu when the anchor and item count both change", () => {
    // Mirrors FileTree: right-clicking a different row while a menu is
    // already open sets a new `{x, y, path, isDir}` directly (never through
    // a null in-between), so `ContextMenu` never remounts — it's the same
    // component instance getting new props and a different number of menu
    // items (root vs. non-root rows show 3 vs. 5 actions).
    const rowHeight = 29;
    const padding = 8;
    Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const height = this.classList.contains("context-menu") ? this.children.length * rowHeight + padding : 0;
      return { x: 0, y: 0, width: 160, height, top: 0, left: 0, right: 160, bottom: height, toJSON: () => ({}) } as DOMRect;
    };

    const { container, rerender } = render(ContextMenuHost, { x: 100, y: 760, itemCount: 5 });
    const menu = container.querySelector(".context-menu") as HTMLElement;
    const tallHeight = 5 * rowHeight + padding;
    expect(menu.style.top).toBe(`${760 - tallHeight}px`);

    // Same instance: a new anchor point (the next right-click's coordinates)
    // and fewer items (a root row: no Rename/Delete).
    rerender({ x: 100, y: 750, itemCount: 3 });
    const shortHeight = 3 * rowHeight + padding;
    expect(menu.style.top).toBe(`${750 - shortHeight}px`);
    // Would equal this (stale) value if the effect re-clamped using the
    // menu's previous height instead of re-measuring after the DOM update.
    expect(menu.style.top).not.toBe(`${750 - tallHeight}px`);
  });
});

describe("ContextMenu: anchorEl positioning", () => {
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    setViewport(1024, 768);
  });

  afterEach(() => {
    cleanup();
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  /** Distinguishes the anchor button's rect from the menu's own rect by tag name, the same way a real layout would report two different elements. */
  function stubAnchorAndMenu(anchorRect: { left: number; bottom: number }, menuSize: { width: number; height: number }): void {
    Element.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.tagName === "BUTTON" && !this.classList.contains("context-menu")) {
        return {
          x: 0,
          y: 0,
          width: 60,
          height: 20,
          top: anchorRect.bottom - 20,
          left: anchorRect.left,
          right: anchorRect.left + 60,
          bottom: anchorRect.bottom,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        width: menuSize.width,
        height: menuSize.height,
        top: 0,
        left: 0,
        right: menuSize.width,
        bottom: menuSize.height,
        toJSON: () => ({}),
      } as DOMRect;
    };
  }

  it("positions the menu at the anchor element's bottom-left corner when there is room", () => {
    stubAnchorAndMenu({ left: 100, bottom: 130 }, { width: 160, height: 145 });
    const { container } = render(AnchorContextMenuHost);
    const menu = container.querySelector(".context-menu") as HTMLElement;
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("130px");
  });

  it("flips upward off the anchor instead of overflowing the bottom edge", () => {
    stubAnchorAndMenu({ left: 100, bottom: 760 }, { width: 160, height: 145 });
    const { container } = render(AnchorContextMenuHost);
    const menu = container.querySelector(".context-menu") as HTMLElement;
    expect(menu.style.top).toBe("615px"); // 760 - 145
  });

  it("shifts left instead of overflowing the right edge", () => {
    stubAnchorAndMenu({ left: 1000, bottom: 100 }, { width: 160, height: 145 });
    const { container } = render(AnchorContextMenuHost);
    const menu = container.querySelector(".context-menu") as HTMLElement;
    expect(menu.style.left).toBe("840px"); // 1000 - 160
  });
});
