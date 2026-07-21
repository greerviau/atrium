import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { attachScrollbarAutoHide } from "../../src/lib/ui/scrollbarAutoHide";

describe("attachScrollbarAutoHide", () => {
  let el: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
    vi.useRealTimers();
  });

  it("adds the scrollbar-autohide class on attach", () => {
    attachScrollbarAutoHide(el);
    expect(el.classList.contains("scrollbar-autohide")).toBe(true);
  });

  it("sets data-scrolling on scroll and removes it after the delay elapses", () => {
    attachScrollbarAutoHide(el, 1200);

    el.dispatchEvent(new Event("scroll"));
    expect(el.getAttribute("data-scrolling")).toBe("true");

    vi.advanceTimersByTime(1199);
    expect(el.getAttribute("data-scrolling")).toBe("true");

    vi.advanceTimersByTime(1);
    expect(el.hasAttribute("data-scrolling")).toBe(false);
  });

  it("stops listening and clears state once detached", () => {
    const detach = attachScrollbarAutoHide(el, 1200);

    el.dispatchEvent(new Event("scroll"));
    expect(el.getAttribute("data-scrolling")).toBe("true");

    detach();

    expect(el.classList.contains("scrollbar-autohide")).toBe(false);
    expect(el.hasAttribute("data-scrolling")).toBe(false);

    el.dispatchEvent(new Event("scroll"));
    expect(el.hasAttribute("data-scrolling")).toBe(false);
  });
});
