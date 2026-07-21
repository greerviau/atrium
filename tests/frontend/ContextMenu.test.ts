import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import ContextMenuHost from "./ContextMenuHost.svelte";

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
});
