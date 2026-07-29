import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "atrium.editor.tabSize";

beforeEach(() => {
  localStorage.clear();
});

async function freshTabSizeStore() {
  vi.resetModules();
  return import("../../src/lib/stores/tabSize");
}

describe("loadTabSize / saveTabSize", () => {
  it("defaults to 2 when nothing is stored", async () => {
    const { loadTabSize, DEFAULT_TAB_SIZE } = await freshTabSizeStore();
    expect(loadTabSize()).toBe(DEFAULT_TAB_SIZE);
    expect(DEFAULT_TAB_SIZE).toBe(2);
  });

  it("round-trips a saved value", async () => {
    const { loadTabSize, saveTabSize } = await freshTabSizeStore();
    saveTabSize(4);
    expect(loadTabSize()).toBe(4);
  });

  it("falls back to the default on malformed JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "not json{");
    const { loadTabSize, DEFAULT_TAB_SIZE } = await freshTabSizeStore();
    expect(loadTabSize()).toBe(DEFAULT_TAB_SIZE);
  });

  it("falls back to the default when the stored value is outside the valid set", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(3));
    const { loadTabSize, DEFAULT_TAB_SIZE } = await freshTabSizeStore();
    expect(loadTabSize()).toBe(DEFAULT_TAB_SIZE);
  });

  it("falls back to the default when the stored value isn't a number", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("4"));
    const { loadTabSize, DEFAULT_TAB_SIZE } = await freshTabSizeStore();
    expect(loadTabSize()).toBe(DEFAULT_TAB_SIZE);
  });

  it("swallows a write error instead of throwing", async () => {
    const { saveTabSize } = await freshTabSizeStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveTabSize(8)).not.toThrow();
    setItem.mockRestore();
  });
});

describe("tabSize store: setTabSize", () => {
  it("defaults to DEFAULT_TAB_SIZE when nothing is stored", async () => {
    const { tabSize, DEFAULT_TAB_SIZE } = await freshTabSizeStore();
    expect(get(tabSize)).toBe(DEFAULT_TAB_SIZE);
  });

  it("updates the store and persists the new value", async () => {
    const { tabSize, setTabSize } = await freshTabSizeStore();
    setTabSize(8);
    expect(get(tabSize)).toBe(8);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(8);

    setTabSize(4);
    expect(get(tabSize)).toBe(4);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(4);
  });
});
