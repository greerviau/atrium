import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadTerminalLayout, saveTerminalLayout, clampHeight, clampWidth } from "../../src/lib/stores/layout";

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

  it("clamps above the maximum", () => {
    expect(clampHeight(9999)).toBe(700);
  });
});

describe("clampWidth", () => {
  it("passes through values already in range", () => {
    expect(clampWidth(320)).toBe(320);
  });

  it("clamps below the minimum", () => {
    expect(clampWidth(10)).toBe(140);
  });

  it("clamps above the maximum", () => {
    expect(clampWidth(9999)).toBe(600);
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
    expect(loadTerminalLayout()).toEqual({ position: "left", height: 80, width: 600 });
  });

  it("swallows a write error instead of throwing", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveTerminalLayout({ position: "bottom", height: 240, width: 320 })).not.toThrow();
    setItem.mockRestore();
  });
});
