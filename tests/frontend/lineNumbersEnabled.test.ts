import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "atrium.editor.lineNumbersEnabled";

beforeEach(() => {
  localStorage.clear();
});

async function freshLineNumbersEnabledStore() {
  vi.resetModules();
  return import("../../src/lib/stores/lineNumbersEnabled");
}

describe("loadLineNumbersEnabled / saveLineNumbersEnabled", () => {
  it("defaults to enabled when nothing is stored", async () => {
    const { loadLineNumbersEnabled, DEFAULT_LINE_NUMBERS_ENABLED } = await freshLineNumbersEnabledStore();
    expect(loadLineNumbersEnabled()).toBe(DEFAULT_LINE_NUMBERS_ENABLED);
    expect(DEFAULT_LINE_NUMBERS_ENABLED).toBe(true);
  });

  it("round-trips a saved value", async () => {
    const { loadLineNumbersEnabled, saveLineNumbersEnabled } = await freshLineNumbersEnabledStore();
    saveLineNumbersEnabled(false);
    expect(loadLineNumbersEnabled()).toBe(false);
  });

  it("falls back to the default on malformed JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "not json{");
    const { loadLineNumbersEnabled, DEFAULT_LINE_NUMBERS_ENABLED } = await freshLineNumbersEnabledStore();
    expect(loadLineNumbersEnabled()).toBe(DEFAULT_LINE_NUMBERS_ENABLED);
  });

  it("falls back to the default when the stored value isn't a boolean", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("yes"));
    const { loadLineNumbersEnabled, DEFAULT_LINE_NUMBERS_ENABLED } = await freshLineNumbersEnabledStore();
    expect(loadLineNumbersEnabled()).toBe(DEFAULT_LINE_NUMBERS_ENABLED);
  });

  it("swallows a write error instead of throwing", async () => {
    const { saveLineNumbersEnabled } = await freshLineNumbersEnabledStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveLineNumbersEnabled(false)).not.toThrow();
    setItem.mockRestore();
  });
});

describe("lineNumbersEnabled store: setLineNumbersEnabled", () => {
  it("defaults to DEFAULT_LINE_NUMBERS_ENABLED when nothing is stored", async () => {
    const { lineNumbersEnabled, DEFAULT_LINE_NUMBERS_ENABLED } = await freshLineNumbersEnabledStore();
    expect(get(lineNumbersEnabled)).toBe(DEFAULT_LINE_NUMBERS_ENABLED);
  });

  it("updates the store and persists the new value", async () => {
    const { lineNumbersEnabled, setLineNumbersEnabled } = await freshLineNumbersEnabledStore();
    setLineNumbersEnabled(false);
    expect(get(lineNumbersEnabled)).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(false);

    setLineNumbersEnabled(true);
    expect(get(lineNumbersEnabled)).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(true);
  });
});
