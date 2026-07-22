import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import {
  loadTerminalLayout,
  saveTerminalLayout,
  clampHeight,
  clampWidth,
  clampToContainer,
  WIDTH_MIN,
} from "../../src/lib/stores/layout";

const STORAGE_KEY = "atrium.layout.terminal";
const PANELS_STORAGE_KEY = "atrium.layout.panels";

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

describe("terminalPosition", () => {
  it("defaults to the default layout's position when nothing is stored", async () => {
    const { terminalPosition } = await freshLayoutStore();
    expect(get(terminalPosition)).toBe("bottom");
  });

  it("initializes from a persisted layout's position", async () => {
    saveTerminalLayout({ position: "right", height: 300, width: 400 });
    const { terminalPosition } = await freshLayoutStore();
    expect(get(terminalPosition)).toBe("right");
  });

  it("setTerminalPosition updates the store and persists it, preserving the current height/width", async () => {
    saveTerminalLayout({ position: "bottom", height: 300, width: 400 });
    const { terminalPosition, setTerminalPosition } = await freshLayoutStore();

    setTerminalPosition("left");

    expect(get(terminalPosition)).toBe("left");
    expect(loadTerminalLayout()).toEqual({ position: "left", height: 300, width: 400 });
  });

  it("round-trips a set position through localStorage on a fresh import", async () => {
    const { setTerminalPosition } = await freshLayoutStore();
    setTerminalPosition("right");

    const reloaded = await freshLayoutStore();
    expect(get(reloaded.terminalPosition)).toBe("right");
  });
});

/**
 * The panel-visibility store reads its persisted state once at import time
 * (module-level `const initialPanelVisibility = loadPanelVisibility()`), so
 * each test that needs a specific starting localStorage state resets the
 * module registry and re-imports it fresh, matching the pattern already
 * used for the theme store in themeStore.test.ts.
 */
async function freshLayoutStore() {
  vi.resetModules();
  return import("../../src/lib/stores/layout");
}

describe("panel visibility", () => {
  it("defaults both panels to shown when nothing is stored", async () => {
    const { explorerVisible, terminalVisible } = await freshLayoutStore();
    expect(get(explorerVisible)).toBe(true);
    expect(get(terminalVisible)).toBe(true);
  });

  it("round-trips a toggled explorer visibility through localStorage", async () => {
    const { explorerVisible, terminalVisible, toggleExplorerVisible } = await freshLayoutStore();

    toggleExplorerVisible();

    expect(get(explorerVisible)).toBe(false);
    expect(JSON.parse(localStorage.getItem(PANELS_STORAGE_KEY) ?? "")).toEqual({
      explorerVisible: false,
      terminalVisible: true,
    });

    const reloaded = await freshLayoutStore();
    expect(get(reloaded.explorerVisible)).toBe(false);
    expect(get(reloaded.terminalVisible)).toBe(true);
  });

  it("round-trips a toggled terminal visibility through localStorage", async () => {
    const { terminalVisible, toggleTerminalVisible } = await freshLayoutStore();

    toggleTerminalVisible();

    expect(get(terminalVisible)).toBe(false);
    expect(JSON.parse(localStorage.getItem(PANELS_STORAGE_KEY) ?? "")).toEqual({
      explorerVisible: true,
      terminalVisible: false,
    });

    const reloaded = await freshLayoutStore();
    expect(get(reloaded.explorerVisible)).toBe(true);
    expect(get(reloaded.terminalVisible)).toBe(false);
  });

  it("toggles independently, preserving the other panel's state", async () => {
    const { explorerVisible, terminalVisible, toggleExplorerVisible } = await freshLayoutStore();

    toggleExplorerVisible();
    toggleExplorerVisible();

    expect(get(explorerVisible)).toBe(true);
    expect(get(terminalVisible)).toBe(true);
  });

  it("falls back to the default on malformed JSON", async () => {
    localStorage.setItem(PANELS_STORAGE_KEY, "not json{");
    const { explorerVisible, terminalVisible } = await freshLayoutStore();

    expect(get(explorerVisible)).toBe(true);
    expect(get(terminalVisible)).toBe(true);
  });

  it("falls back to the default when a field has the wrong type", async () => {
    localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify({ explorerVisible: "yes", terminalVisible: true }));
    const { explorerVisible, terminalVisible } = await freshLayoutStore();

    expect(get(explorerVisible)).toBe(true);
    expect(get(terminalVisible)).toBe(true);
  });

  it("falls back to the default when a field is missing", async () => {
    localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify({ explorerVisible: false }));
    const { explorerVisible, terminalVisible } = await freshLayoutStore();

    expect(get(explorerVisible)).toBe(true);
    expect(get(terminalVisible)).toBe(true);
  });

  it("swallows a write error instead of throwing", async () => {
    const { toggleExplorerVisible } = await freshLayoutStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });

    expect(() => toggleExplorerVisible()).not.toThrow();

    setItem.mockRestore();
  });
});
