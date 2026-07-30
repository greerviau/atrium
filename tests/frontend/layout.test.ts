import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import {
  loadTerminalLayout,
  saveTerminalLayout,
  clampHeight,
  clampWidth,
  clampToContainer,
  WIDTH_MIN,
  loadExplorerWidth,
  saveExplorerWidth,
  clampExplorerToContainer,
  EXPLORER_WIDTH_MIN,
  EXPLORER_WIDTH_MAX,
} from "../../src/lib/stores/layout";

const STORAGE_KEY = "atrium.layout.terminal";
const PANELS_STORAGE_KEY = "atrium.layout.panels";
const EXPLORER_STORAGE_KEY = "atrium.layout.explorer";

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

describe("clampExplorerToContainer", () => {
  it("passes through a value that leaves room for the reserved space", () => {
    expect(clampExplorerToContainer(300, 1000)).toBe(300);
  });

  it("caps at EXPLORER_WIDTH_MAX on a huge container", () => {
    // Old fixed-600 clamp is *kept* deliberately for the explorer (unlike the
    // terminal's own clamp, this one intentionally does not scale past its
    // ceiling on a very large container — see plan §7).
    expect(clampExplorerToContainer(4000, 3440)).toBe(EXPLORER_WIDTH_MAX);
  });

  it("caps at the container-reserved bound on a small container", () => {
    // A container of 700 reserves 204, leaving 496 (below EXPLORER_WIDTH_MAX,
    // so the container-relative bound binds instead of the fixed ceiling).
    expect(clampExplorerToContainer(900, 700)).toBe(700 - 204);
  });

  it("never returns less than EXPLORER_WIDTH_MIN, even when the container is smaller than min + reserved", () => {
    expect(clampExplorerToContainer(50, 300)).toBe(EXPLORER_WIDTH_MIN);
  });
});

describe("persistence shape is unchanged by proportional resize (#301, no migration)", () => {
  it("a width saved after this change round-trips as a bare number, not an object", () => {
    saveExplorerWidth(444);
    expect(JSON.parse(localStorage.getItem(EXPLORER_STORAGE_KEY) ?? "")).toBe(444);
    expect(loadExplorerWidth()).toBe(444);
  });

  it("a terminal layout saved after this change round-trips as {position, height, width}, not a ratio", () => {
    saveTerminalLayout({ position: "right", height: 280, width: 360 });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toEqual({ position: "right", height: 280, width: 360 });
    expect(loadTerminalLayout()).toEqual({ position: "right", height: 280, width: 360 });
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
 * used for the theme store in themeStore.test.ts. Also re-imports
 * `workspace.ts` from the same fresh module generation (not re-exported by
 * `layout.ts` itself) so a test can set `$workspace.root` and have
 * `toggleExplorerVisible`'s own internal `import { workspace }` see the
 * exact same singleton instance (issue #325 — `toggleExplorerVisible` is
 * mode-aware, and project-mode persistence only kicks in with a root open).
 */
async function freshLayoutStore() {
  vi.resetModules();
  const layout = await import("../../src/lib/stores/layout");
  const { workspace } = await import("../../src/lib/stores/workspace");
  return { ...layout, workspace };
}

describe("panel visibility", () => {
  it("defaults both panels to shown when nothing is stored", async () => {
    const { explorerVisible, terminalVisible } = await freshLayoutStore();
    expect(get(explorerVisible)).toBe(true);
    expect(get(terminalVisible)).toBe(true);
  });

  it("round-trips a toggled explorer visibility through localStorage, with a project open", async () => {
    const { explorerVisible, terminalVisible, workspace, toggleExplorerVisible } = await freshLayoutStore();
    workspace.set({ id: "local", root: "/proj" });

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

  it("toggles independently, preserving the other panel's state, with a project open", async () => {
    const { explorerVisible, terminalVisible, workspace, toggleExplorerVisible } = await freshLayoutStore();
    workspace.set({ id: "local", root: "/proj" });

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

  it("swallows a write error instead of throwing, with a project open", async () => {
    const { workspace, toggleExplorerVisible } = await freshLayoutStore();
    workspace.set({ id: "local", root: "/proj" });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });

    expect(() => toggleExplorerVisible()).not.toThrow();

    setItem.mockRestore();
  });
});

// Standalone (root-less) explorer visibility (issue #325's cold-launch
// plan, §7.2(a)): `toggleExplorerVisible` and `explorerShown` both branch on
// whether a project is open, and the standalone half is deliberately
// session-only — no persisted key, always starts hidden.
describe("standalone explorer visibility (issue #325)", () => {
  it("standaloneExplorerVisible starts false and is not read from any persisted key", async () => {
    localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify({ explorerVisible: true, terminalVisible: true }));
    const { standaloneExplorerVisible } = await freshLayoutStore();
    expect(get(standaloneExplorerVisible)).toBe(false);
  });

  it("toggleExplorerVisible with no project open flips standaloneExplorerVisible, not explorerVisible, and persists nothing", async () => {
    const { explorerVisible, standaloneExplorerVisible, workspace, toggleExplorerVisible } = await freshLayoutStore();
    workspace.set({ id: "local", root: null });

    toggleExplorerVisible();

    expect(get(standaloneExplorerVisible)).toBe(true);
    expect(get(explorerVisible)).toBe(true);
    expect(localStorage.getItem(PANELS_STORAGE_KEY)).toBeNull();
  });

  it("explorerShown reflects standaloneExplorerVisible with no root, and explorerVisible with one", async () => {
    const { explorerShown, standaloneExplorerVisible, workspace } = await freshLayoutStore();
    const { tabsState } = await import("../../src/lib/stores/tabs");
    const { standaloneWorkspaceId } = await import("../../src/lib/ipc/commands");
    workspace.set({ id: "local", root: null });
    tabsState.set({
      tabs: [
        {
          path: "/tmp/note.md",
          workspaceId: standaloneWorkspaceId(),
          mode: "markdown",
          savedDoc: "",
          isDirty: false,
          hasExternalConflict: false,
          isExternal: true,
          isDeleted: false,
        },
      ],
      activeTabPath: "/tmp/note.md",
    });

    expect(get(explorerShown)).toBe(false);
    standaloneExplorerVisible.set(true);
    expect(get(explorerShown)).toBe(true);

    workspace.set({ id: "local", root: "/proj" });
    expect(get(explorerShown)).toBe(true);
  });
});

describe("loadExplorerWidth / saveExplorerWidth", () => {
  it("returns the default width when nothing is stored", () => {
    expect(loadExplorerWidth()).toBe(240);
  });

  it("round-trips a saved width", () => {
    saveExplorerWidth(320);
    expect(loadExplorerWidth()).toBe(320);
  });

  it("clamps below the minimum on load", () => {
    localStorage.setItem(EXPLORER_STORAGE_KEY, JSON.stringify(10));
    expect(loadExplorerWidth()).toBe(EXPLORER_WIDTH_MIN);
  });

  it("clamps above the maximum on load", () => {
    localStorage.setItem(EXPLORER_STORAGE_KEY, JSON.stringify(9999));
    expect(loadExplorerWidth()).toBe(EXPLORER_WIDTH_MAX);
  });

  it("falls back to the default on malformed JSON", () => {
    localStorage.setItem(EXPLORER_STORAGE_KEY, "not json{");
    expect(loadExplorerWidth()).toBe(240);
  });

  it("falls back to the default when the stored value isn't a number", () => {
    localStorage.setItem(EXPLORER_STORAGE_KEY, JSON.stringify("240"));
    expect(loadExplorerWidth()).toBe(240);
  });

  it("swallows a write error instead of throwing", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveExplorerWidth(300)).not.toThrow();
    setItem.mockRestore();
  });
});
