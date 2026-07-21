import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadTerminalLayout,
  saveTerminalLayout,
  clampHeight,
  clampWidth,
  clampToContainer,
  WIDTH_MIN,
} from "../../src/lib/stores/layout";

const STORAGE_KEY = "atrium.layout.terminal";

beforeEach(() => {
  localStorage.clear();
});

describe("clampHeight", () => {
  it("passes through values already in range", () => {
    expect(clampHeight(240)).toBe(240);
  });

  it("clamps below the minimum", () => {
    expect(clampHeight(10)).toBe(80);
  });

  it("clamps above the sanity ceiling", () => {
    expect(clampHeight(9999)).toBe(4000);
  });
});

describe("clampWidth", () => {
  it("passes through values already in range", () => {
    expect(clampWidth(320)).toBe(320);
  });

  it("clamps below the minimum", () => {
    expect(clampWidth(10)).toBe(140);
  });

  it("clamps above the sanity ceiling", () => {
    expect(clampWidth(9999)).toBe(4000);
  });
});

describe("clampToContainer", () => {
  it("passes through a value that leaves room for the reserved space", () => {
    expect(clampToContainer(300, WIDTH_MIN, 1000, 204)).toBe(300);
  });

  it("caps at containerSize minus the reserved space", () => {
    expect(clampToContainer(900, WIDTH_MIN, 1000, 204)).toBe(796);
  });

  it("scales up with a larger container instead of hitting a fixed ceiling", () => {
    // Old fixed-600 clamp would have capped this at 600 regardless of container size.
    expect(clampToContainer(4000, WIDTH_MIN, 3440, 204)).toBe(3236);
  });

  it("never returns less than min, even when the container is smaller than min + reserved", () => {
    expect(clampToContainer(50, WIDTH_MIN, 300, 204)).toBe(WIDTH_MIN);
  });
});

describe("loadTerminalLayout / saveTerminalLayout", () => {
  it("returns the default layout when nothing is stored", () => {
    expect(loadTerminalLayout()).toEqual({ position: "bottom", height: 240, width: 320 });
  });

  it("round-trips a saved layout", () => {
    saveTerminalLayout({ position: "right", height: 300, width: 400 });
    expect(loadTerminalLayout()).toEqual({ position: "right", height: 300, width: 400 });
  });

  it("falls back to the default on malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not json{");
    expect(loadTerminalLayout()).toEqual({ position: "bottom", height: 240, width: 320 });
  });

  it("falls back to the default on an invalid position value", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ position: "top", height: 240, width: 320 }));
    expect(loadTerminalLayout()).toEqual({ position: "bottom", height: 240, width: 320 });
  });

  it("falls back to the default when fields are missing", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ position: "left" }));
    expect(loadTerminalLayout()).toEqual({ position: "bottom", height: 240, width: 320 });
  });

  it("clamps out-of-range dimensions on load", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ position: "left", height: 5, width: 9999 }));
    expect(loadTerminalLayout()).toEqual({ position: "left", height: 80, width: 4000 });
  });

  it("swallows a write error instead of throwing", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveTerminalLayout({ position: "bottom", height: 240, width: 320 })).not.toThrow();
    setItem.mockRestore();
  });
});
