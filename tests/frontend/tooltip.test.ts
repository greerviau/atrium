import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tooltip } from "../../src/lib/ui/tooltip";

describe("tooltip action", () => {
  let node: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();
    node = document.createElement("button");
    document.body.appendChild(node);
  });

  afterEach(() => {
    node.remove();
    document.querySelectorAll(".atrium-tooltip").forEach((el) => el.remove());
    vi.useRealTimers();
  });

  it("does not add a tooltip node at rest", () => {
    tooltip(node, { label: "Toggle Explorer" });
    expect(document.querySelector(".atrium-tooltip")).toBeNull();
  });

  it("shows the tooltip with the label after the delay elapses on mouseenter", () => {
    tooltip(node, { label: "Toggle Explorer" });

    node.dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.querySelector(".atrium-tooltip")).toBeNull();

    vi.advanceTimersByTime(399);
    expect(document.querySelector(".atrium-tooltip")).toBeNull();

    vi.advanceTimersByTime(1);
    const el = document.querySelector(".atrium-tooltip");
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Toggle Explorer");
  });

  it("renders the shortcut as a <kbd> when given", () => {
    tooltip(node, { label: "Toggle Explorer", shortcut: "⌘B" });

    node.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(400);

    const kbd = document.querySelector(".atrium-tooltip-kbd");
    expect(kbd).not.toBeNull();
    expect(kbd!.tagName).toBe("KBD");
    expect(kbd!.textContent).toBe("⌘B");
  });

  it("omits the <kbd> element when no shortcut is given", () => {
    tooltip(node, { label: "Split terminal" });

    node.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(400);

    expect(document.querySelector(".atrium-tooltip-kbd")).toBeNull();
  });

  it("shows on focus after the delay too", () => {
    tooltip(node, { label: "Settings" });

    node.dispatchEvent(new FocusEvent("focus"));
    vi.advanceTimersByTime(400);

    expect(document.querySelector(".atrium-tooltip")).not.toBeNull();
  });

  it("removes the tooltip immediately on mouseleave", () => {
    tooltip(node, { label: "Toggle Explorer" });
    node.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(400);
    expect(document.querySelector(".atrium-tooltip")).not.toBeNull();

    node.dispatchEvent(new MouseEvent("mouseleave"));
    expect(document.querySelector(".atrium-tooltip")).toBeNull();
  });

  it("removes the tooltip immediately on blur", () => {
    tooltip(node, { label: "Settings" });
    node.dispatchEvent(new FocusEvent("focus"));
    vi.advanceTimersByTime(400);
    expect(document.querySelector(".atrium-tooltip")).not.toBeNull();

    node.dispatchEvent(new FocusEvent("blur"));
    expect(document.querySelector(".atrium-tooltip")).toBeNull();
  });

  it("removes the tooltip immediately on click", () => {
    tooltip(node, { label: "Toggle Terminal" });
    node.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(400);
    expect(document.querySelector(".atrium-tooltip")).not.toBeNull();

    node.dispatchEvent(new MouseEvent("click"));
    expect(document.querySelector(".atrium-tooltip")).toBeNull();
  });

  it("does not stack a second tooltip node when a button is both focused and hovered", () => {
    tooltip(node, { label: "Toggle Explorer" });

    node.dispatchEvent(new FocusEvent("focus"));
    vi.advanceTimersByTime(400);
    node.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(400);

    expect(document.querySelectorAll(".atrium-tooltip")).toHaveLength(1);
  });

  it("cancels a pending show on mouseleave before the delay elapses", () => {
    tooltip(node, { label: "Toggle Explorer" });
    node.dispatchEvent(new MouseEvent("mouseenter"));
    node.dispatchEvent(new MouseEvent("mouseleave"));

    vi.advanceTimersByTime(400);
    expect(document.querySelector(".atrium-tooltip")).toBeNull();
  });

  it("update() refreshes the label/shortcut of a currently-shown tooltip without recreating the node", () => {
    const action = tooltip(node, { label: "Toggle Explorer", shortcut: "⌘B" });
    node.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(400);

    const el = document.querySelector(".atrium-tooltip");
    expect(el).not.toBeNull();

    action?.update?.({ label: "Hide Explorer", shortcut: "⌘B" });

    expect(document.querySelector(".atrium-tooltip")).toBe(el);
    expect(el!.textContent).toContain("Hide Explorer");
  });

  it("destroy() while shown removes the tooltip node and leaves no listeners active", () => {
    const action = tooltip(node, { label: "Toggle Explorer" });
    node.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(400);
    expect(document.querySelector(".atrium-tooltip")).not.toBeNull();

    action?.destroy?.();
    expect(document.querySelector(".atrium-tooltip")).toBeNull();

    node.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(400);
    expect(document.querySelector(".atrium-tooltip")).toBeNull();
  });
});
