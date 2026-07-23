import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "atrium.editor.minimapEnabled";

beforeEach(() => {
  localStorage.clear();
});

async function freshMinimapEnabledStore() {
  vi.resetModules();
  return import("../../src/lib/stores/minimapEnabled");
}

describe("loadMinimapEnabled / saveMinimapEnabled", () => {
  it("defaults to enabled when nothing is stored", async () => {
    const { loadMinimapEnabled, DEFAULT_MINIMAP_ENABLED } = await freshMinimapEnabledStore();
    expect(loadMinimapEnabled()).toBe(DEFAULT_MINIMAP_ENABLED);
    expect(DEFAULT_MINIMAP_ENABLED).toBe(true);
  });

  it("round-trips a saved value", async () => {
    const { loadMinimapEnabled, saveMinimapEnabled } = await freshMinimapEnabledStore();
    saveMinimapEnabled(false);
    expect(loadMinimapEnabled()).toBe(false);
  });

  it("falls back to the default on malformed JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "not json{");
    const { loadMinimapEnabled, DEFAULT_MINIMAP_ENABLED } = await freshMinimapEnabledStore();
    expect(loadMinimapEnabled()).toBe(DEFAULT_MINIMAP_ENABLED);
  });

  it("falls back to the default when the stored value isn't a boolean", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("yes"));
    const { loadMinimapEnabled, DEFAULT_MINIMAP_ENABLED } = await freshMinimapEnabledStore();
    expect(loadMinimapEnabled()).toBe(DEFAULT_MINIMAP_ENABLED);
  });

  it("swallows a write error instead of throwing", async () => {
    const { saveMinimapEnabled } = await freshMinimapEnabledStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveMinimapEnabled(false)).not.toThrow();
    setItem.mockRestore();
  });
});

describe("minimapEnabled store: setMinimapEnabled", () => {
  it("defaults to DEFAULT_MINIMAP_ENABLED when nothing is stored", async () => {
    const { minimapEnabled, DEFAULT_MINIMAP_ENABLED } = await freshMinimapEnabledStore();
    expect(get(minimapEnabled)).toBe(DEFAULT_MINIMAP_ENABLED);
  });

  it("updates the store and persists the new value", async () => {
    const { minimapEnabled, setMinimapEnabled } = await freshMinimapEnabledStore();
    setMinimapEnabled(false);
    expect(get(minimapEnabled)).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(false);

    setMinimapEnabled(true);
    expect(get(minimapEnabled)).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(true);
  });
});
