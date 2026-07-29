import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "atrium.editor.autoSaveEnabled";

beforeEach(() => {
  localStorage.clear();
});

async function freshAutoSaveStore() {
  vi.resetModules();
  return import("../../src/lib/stores/autoSave");
}

describe("loadAutoSaveEnabled / saveAutoSaveEnabled", () => {
  it("defaults to disabled when nothing is stored", async () => {
    const { loadAutoSaveEnabled, DEFAULT_AUTO_SAVE_ENABLED } = await freshAutoSaveStore();
    expect(loadAutoSaveEnabled()).toBe(DEFAULT_AUTO_SAVE_ENABLED);
    expect(DEFAULT_AUTO_SAVE_ENABLED).toBe(false);
  });

  it("round-trips a saved value", async () => {
    const { loadAutoSaveEnabled, saveAutoSaveEnabled } = await freshAutoSaveStore();
    saveAutoSaveEnabled(true);
    expect(loadAutoSaveEnabled()).toBe(true);
  });

  it("falls back to the default on malformed JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "not json{");
    const { loadAutoSaveEnabled, DEFAULT_AUTO_SAVE_ENABLED } = await freshAutoSaveStore();
    expect(loadAutoSaveEnabled()).toBe(DEFAULT_AUTO_SAVE_ENABLED);
  });

  it("falls back to the default when the stored value isn't a boolean", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("yes"));
    const { loadAutoSaveEnabled, DEFAULT_AUTO_SAVE_ENABLED } = await freshAutoSaveStore();
    expect(loadAutoSaveEnabled()).toBe(DEFAULT_AUTO_SAVE_ENABLED);
  });

  it("swallows a write error instead of throwing", async () => {
    const { saveAutoSaveEnabled } = await freshAutoSaveStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveAutoSaveEnabled(true)).not.toThrow();
    setItem.mockRestore();
  });
});

describe("autoSaveEnabled store: setAutoSaveEnabled", () => {
  it("defaults to DEFAULT_AUTO_SAVE_ENABLED when nothing is stored", async () => {
    const { autoSaveEnabled, DEFAULT_AUTO_SAVE_ENABLED } = await freshAutoSaveStore();
    expect(get(autoSaveEnabled)).toBe(DEFAULT_AUTO_SAVE_ENABLED);
  });

  it("updates the store and persists the new value", async () => {
    const { autoSaveEnabled, setAutoSaveEnabled } = await freshAutoSaveStore();
    setAutoSaveEnabled(true);
    expect(get(autoSaveEnabled)).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(true);

    setAutoSaveEnabled(false);
    expect(get(autoSaveEnabled)).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(false);
  });
});

describe("isAutoSaveBlocked / blockAutoSave / unblockAutoSave", () => {
  it("is not blocked for a path that was never blocked", async () => {
    const { isAutoSaveBlocked } = await freshAutoSaveStore();
    expect(isAutoSaveBlocked("/a.ts")).toBe(false);
  });

  it("reports a path as blocked once blockAutoSave is called for it", async () => {
    const { isAutoSaveBlocked, blockAutoSave } = await freshAutoSaveStore();
    blockAutoSave("/a.ts");
    expect(isAutoSaveBlocked("/a.ts")).toBe(true);
  });

  it("clears the block once unblockAutoSave is called for it", async () => {
    const { isAutoSaveBlocked, blockAutoSave, unblockAutoSave } = await freshAutoSaveStore();
    blockAutoSave("/a.ts");
    unblockAutoSave("/a.ts");
    expect(isAutoSaveBlocked("/a.ts")).toBe(false);
  });

  it("tracks each path independently", async () => {
    const { isAutoSaveBlocked, blockAutoSave } = await freshAutoSaveStore();
    blockAutoSave("/a.ts");
    expect(isAutoSaveBlocked("/a.ts")).toBe(true);
    expect(isAutoSaveBlocked("/b.ts")).toBe(false);
  });

  it("unblockAutoSave is a no-op for a path that was never blocked", async () => {
    const { isAutoSaveBlocked, unblockAutoSave } = await freshAutoSaveStore();
    expect(() => unblockAutoSave("/never-blocked.ts")).not.toThrow();
    expect(isAutoSaveBlocked("/never-blocked.ts")).toBe(false);
  });
});
