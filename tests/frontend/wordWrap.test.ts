import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "atrium.editor.wordWrapEnabled";

beforeEach(() => {
  localStorage.clear();
});

async function freshWordWrapStore() {
  vi.resetModules();
  return import("../../src/lib/stores/wordWrap");
}

describe("loadWordWrapEnabled / saveWordWrapEnabled", () => {
  it("defaults to disabled when nothing is stored", async () => {
    const { loadWordWrapEnabled, DEFAULT_WORD_WRAP_ENABLED } = await freshWordWrapStore();
    expect(loadWordWrapEnabled()).toBe(DEFAULT_WORD_WRAP_ENABLED);
    expect(DEFAULT_WORD_WRAP_ENABLED).toBe(false);
  });

  it("round-trips a saved value", async () => {
    const { loadWordWrapEnabled, saveWordWrapEnabled } = await freshWordWrapStore();
    saveWordWrapEnabled(true);
    expect(loadWordWrapEnabled()).toBe(true);
  });

  it("falls back to the default on malformed JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "not json{");
    const { loadWordWrapEnabled, DEFAULT_WORD_WRAP_ENABLED } = await freshWordWrapStore();
    expect(loadWordWrapEnabled()).toBe(DEFAULT_WORD_WRAP_ENABLED);
  });

  it("falls back to the default when the stored value isn't a boolean", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("yes"));
    const { loadWordWrapEnabled, DEFAULT_WORD_WRAP_ENABLED } = await freshWordWrapStore();
    expect(loadWordWrapEnabled()).toBe(DEFAULT_WORD_WRAP_ENABLED);
  });

  it("swallows a write error instead of throwing", async () => {
    const { saveWordWrapEnabled } = await freshWordWrapStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveWordWrapEnabled(true)).not.toThrow();
    setItem.mockRestore();
  });
});

describe("wordWrapEnabled store: setWordWrapEnabled", () => {
  it("defaults to DEFAULT_WORD_WRAP_ENABLED when nothing is stored", async () => {
    const { wordWrapEnabled, DEFAULT_WORD_WRAP_ENABLED } = await freshWordWrapStore();
    expect(get(wordWrapEnabled)).toBe(DEFAULT_WORD_WRAP_ENABLED);
  });

  it("updates the store and persists the new value", async () => {
    const { wordWrapEnabled, setWordWrapEnabled } = await freshWordWrapStore();
    setWordWrapEnabled(true);
    expect(get(wordWrapEnabled)).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(true);

    setWordWrapEnabled(false);
    expect(get(wordWrapEnabled)).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(false);
  });
});
