import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "atrium.general.restoreTabsOnStartup";

beforeEach(() => {
  localStorage.clear();
});

async function freshRestoreTabsOnStartupStore() {
  vi.resetModules();
  return import("../../src/lib/stores/restoreTabsOnStartup");
}

describe("loadRestoreTabsOnStartup / saveRestoreTabsOnStartup", () => {
  it("defaults to enabled when nothing is stored", async () => {
    const { loadRestoreTabsOnStartup, DEFAULT_RESTORE_TABS_ON_STARTUP } = await freshRestoreTabsOnStartupStore();
    expect(loadRestoreTabsOnStartup()).toBe(DEFAULT_RESTORE_TABS_ON_STARTUP);
    expect(DEFAULT_RESTORE_TABS_ON_STARTUP).toBe(true);
  });

  it("round-trips a saved value", async () => {
    const { loadRestoreTabsOnStartup, saveRestoreTabsOnStartup } = await freshRestoreTabsOnStartupStore();
    saveRestoreTabsOnStartup(false);
    expect(loadRestoreTabsOnStartup()).toBe(false);
  });

  it("falls back to the default on malformed JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "not json{");
    const { loadRestoreTabsOnStartup, DEFAULT_RESTORE_TABS_ON_STARTUP } = await freshRestoreTabsOnStartupStore();
    expect(loadRestoreTabsOnStartup()).toBe(DEFAULT_RESTORE_TABS_ON_STARTUP);
  });

  it("falls back to the default when the stored value isn't a boolean", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("yes"));
    const { loadRestoreTabsOnStartup, DEFAULT_RESTORE_TABS_ON_STARTUP } = await freshRestoreTabsOnStartupStore();
    expect(loadRestoreTabsOnStartup()).toBe(DEFAULT_RESTORE_TABS_ON_STARTUP);
  });

  it("swallows a write error instead of throwing", async () => {
    const { saveRestoreTabsOnStartup } = await freshRestoreTabsOnStartupStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveRestoreTabsOnStartup(false)).not.toThrow();
    setItem.mockRestore();
  });
});

describe("restoreTabsOnStartup store: setRestoreTabsOnStartup", () => {
  it("defaults to DEFAULT_RESTORE_TABS_ON_STARTUP when nothing is stored", async () => {
    const { restoreTabsOnStartup, DEFAULT_RESTORE_TABS_ON_STARTUP } = await freshRestoreTabsOnStartupStore();
    expect(get(restoreTabsOnStartup)).toBe(DEFAULT_RESTORE_TABS_ON_STARTUP);
  });

  it("updates the store and persists the new value", async () => {
    const { restoreTabsOnStartup, setRestoreTabsOnStartup } = await freshRestoreTabsOnStartupStore();
    setRestoreTabsOnStartup(false);
    expect(get(restoreTabsOnStartup)).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(false);

    setRestoreTabsOnStartup(true);
    expect(get(restoreTabsOnStartup)).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(true);
  });
});
