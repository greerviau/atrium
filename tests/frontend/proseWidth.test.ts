import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "atrium.markdown.proseWidth";

beforeEach(() => {
  localStorage.clear();
});

async function freshProseWidthStore() {
  vi.resetModules();
  return import("../../src/lib/stores/proseWidth");
}

describe("loadProseWidth / saveProseWidth", () => {
  it("defaults to 80 when nothing is stored", async () => {
    const { loadProseWidth, DEFAULT_PROSE_WIDTH } = await freshProseWidthStore();
    expect(loadProseWidth()).toBe(DEFAULT_PROSE_WIDTH);
    expect(DEFAULT_PROSE_WIDTH).toBe(80);
  });

  it("round-trips each preset, including \"full\"", async () => {
    const { loadProseWidth, saveProseWidth, PROSE_WIDTH_OPTIONS } = await freshProseWidthStore();
    for (const width of PROSE_WIDTH_OPTIONS) {
      saveProseWidth(width);
      expect(loadProseWidth()).toBe(width);
    }
  });

  it("falls back to the default on malformed JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "not json{");
    const { loadProseWidth, DEFAULT_PROSE_WIDTH } = await freshProseWidthStore();
    expect(loadProseWidth()).toBe(DEFAULT_PROSE_WIDTH);
  });

  it("falls back to the default when the stored value is outside the valid set", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(90));
    const { loadProseWidth, DEFAULT_PROSE_WIDTH } = await freshProseWidthStore();
    expect(loadProseWidth()).toBe(DEFAULT_PROSE_WIDTH);
  });

  it("falls back to the default when the stored value is a mistyped string", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("80"));
    const { loadProseWidth, DEFAULT_PROSE_WIDTH } = await freshProseWidthStore();
    expect(loadProseWidth()).toBe(DEFAULT_PROSE_WIDTH);
  });

  it("swallows a write error instead of throwing", async () => {
    const { saveProseWidth } = await freshProseWidthStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveProseWidth(100)).not.toThrow();
    setItem.mockRestore();
  });
});

describe("proseWidth store: setProseWidth", () => {
  it("defaults to DEFAULT_PROSE_WIDTH when nothing is stored", async () => {
    const { proseWidth, DEFAULT_PROSE_WIDTH } = await freshProseWidthStore();
    expect(get(proseWidth)).toBe(DEFAULT_PROSE_WIDTH);
  });

  it("updates the store and persists the new value", async () => {
    const { proseWidth, setProseWidth } = await freshProseWidthStore();
    setProseWidth(120);
    expect(get(proseWidth)).toBe(120);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(120);

    setProseWidth("full");
    expect(get(proseWidth)).toBe("full");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe("full");
  });
});

describe("proseWidthCssValue", () => {
  it("renders a numeric preset as a ch value", async () => {
    const { proseWidthCssValue } = await freshProseWidthStore();
    expect(proseWidthCssValue(60)).toBe("60ch");
    expect(proseWidthCssValue(80)).toBe("80ch");
    expect(proseWidthCssValue(100)).toBe("100ch");
    expect(proseWidthCssValue(120)).toBe("120ch");
  });

  it("renders \"full\" as 100cqw, not a ch value", async () => {
    const { proseWidthCssValue } = await freshProseWidthStore();
    expect(proseWidthCssValue("full")).toBe("100cqw");
  });
});
