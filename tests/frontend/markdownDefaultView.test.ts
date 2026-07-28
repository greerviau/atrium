import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "atrium.markdown.defaultView";

beforeEach(() => {
  localStorage.clear();
});

async function freshMarkdownDefaultViewStore() {
  vi.resetModules();
  return import("../../src/lib/stores/markdownDefaultView");
}

describe("loadMarkdownDefaultView / saveMarkdownDefaultView", () => {
  it("defaults to rendered when nothing is stored", async () => {
    const { loadMarkdownDefaultView, DEFAULT_MARKDOWN_VIEW } = await freshMarkdownDefaultViewStore();
    expect(loadMarkdownDefaultView()).toBe(DEFAULT_MARKDOWN_VIEW);
    expect(DEFAULT_MARKDOWN_VIEW).toBe("rendered");
  });

  it("round-trips a saved value", async () => {
    const { loadMarkdownDefaultView, saveMarkdownDefaultView } = await freshMarkdownDefaultViewStore();
    saveMarkdownDefaultView("source");
    expect(loadMarkdownDefaultView()).toBe("source");
  });

  it("falls back to the default on malformed JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "not json{");
    const { loadMarkdownDefaultView, DEFAULT_MARKDOWN_VIEW } = await freshMarkdownDefaultViewStore();
    expect(loadMarkdownDefaultView()).toBe(DEFAULT_MARKDOWN_VIEW);
  });

  it("falls back to the default when the stored value isn't a recognized view", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("outline"));
    const { loadMarkdownDefaultView, DEFAULT_MARKDOWN_VIEW } = await freshMarkdownDefaultViewStore();
    expect(loadMarkdownDefaultView()).toBe(DEFAULT_MARKDOWN_VIEW);
  });

  it("swallows a write error instead of throwing", async () => {
    const { saveMarkdownDefaultView } = await freshMarkdownDefaultViewStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveMarkdownDefaultView("source")).not.toThrow();
    setItem.mockRestore();
  });
});

describe("markdownDefaultView store: setMarkdownDefaultView", () => {
  it("defaults to DEFAULT_MARKDOWN_VIEW when nothing is stored", async () => {
    const { markdownDefaultView, DEFAULT_MARKDOWN_VIEW } = await freshMarkdownDefaultViewStore();
    expect(get(markdownDefaultView)).toBe(DEFAULT_MARKDOWN_VIEW);
  });

  it("updates the store and persists the new value", async () => {
    const { markdownDefaultView, setMarkdownDefaultView } = await freshMarkdownDefaultViewStore();
    setMarkdownDefaultView("source");
    expect(get(markdownDefaultView)).toBe("source");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe("source");

    setMarkdownDefaultView("rendered");
    expect(get(markdownDefaultView)).toBe("rendered");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe("rendered");
  });
});
