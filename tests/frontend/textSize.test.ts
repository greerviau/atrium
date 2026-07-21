import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "atrium.textSize.zoom";

beforeEach(() => {
  localStorage.clear();
});

async function freshTextSizeStore() {
  vi.resetModules();
  return import("../../src/lib/stores/textSize");
}

describe("clampZoom", () => {
  it("passes through values already in range", async () => {
    const { clampZoom } = await freshTextSizeStore();
    expect(clampZoom(1.0)).toBe(1.0);
  });

  it("clamps below the minimum", async () => {
    const { clampZoom, MIN_ZOOM } = await freshTextSizeStore();
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
  });

  it("clamps above the maximum", async () => {
    const { clampZoom, MAX_ZOOM } = await freshTextSizeStore();
    expect(clampZoom(5)).toBe(MAX_ZOOM);
  });

  it("rounds to one decimal place to avoid float drift", async () => {
    const { clampZoom } = await freshTextSizeStore();
    expect(clampZoom(1.0 + 0.1 + 0.1)).toBe(1.2);
  });
});

describe("loadZoom / saveZoom", () => {
  it("returns the default zoom when nothing is stored", async () => {
    const { loadZoom, DEFAULT_ZOOM } = await freshTextSizeStore();
    expect(loadZoom()).toBe(DEFAULT_ZOOM);
  });

  it("round-trips a saved zoom level", async () => {
    const { loadZoom, saveZoom } = await freshTextSizeStore();
    saveZoom(1.3);
    expect(loadZoom()).toBe(1.3);
  });

  it("falls back to the default on malformed JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "not json{");
    const { loadZoom, DEFAULT_ZOOM } = await freshTextSizeStore();
    expect(loadZoom()).toBe(DEFAULT_ZOOM);
  });

  it("falls back to the default when the stored value isn't a number", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("big"));
    const { loadZoom, DEFAULT_ZOOM } = await freshTextSizeStore();
    expect(loadZoom()).toBe(DEFAULT_ZOOM);
  });

  it("clamps an out-of-range stored value", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(9));
    const { loadZoom, MAX_ZOOM } = await freshTextSizeStore();
    expect(loadZoom()).toBe(MAX_ZOOM);
  });

  it("swallows a write error instead of throwing", async () => {
    const { saveZoom } = await freshTextSizeStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveZoom(1.0)).not.toThrow();
    setItem.mockRestore();
  });
});

describe("zoom store: zoomIn / zoomOut / resetZoom", () => {
  it("defaults to DEFAULT_ZOOM when nothing is stored", async () => {
    const { zoom, DEFAULT_ZOOM } = await freshTextSizeStore();
    expect(get(zoom)).toBe(DEFAULT_ZOOM);
  });

  it("zoomIn steps by exactly ZOOM_STEP and persists", async () => {
    const { zoom, zoomIn, DEFAULT_ZOOM, ZOOM_STEP } = await freshTextSizeStore();
    zoomIn();
    expect(get(zoom)).toBeCloseTo(DEFAULT_ZOOM + ZOOM_STEP, 5);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBeCloseTo(DEFAULT_ZOOM + ZOOM_STEP, 5);
  });

  it("zoomOut steps by exactly ZOOM_STEP and persists", async () => {
    const { zoom, zoomOut, DEFAULT_ZOOM, ZOOM_STEP } = await freshTextSizeStore();
    zoomOut();
    expect(get(zoom)).toBeCloseTo(DEFAULT_ZOOM - ZOOM_STEP, 5);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBeCloseTo(DEFAULT_ZOOM - ZOOM_STEP, 5);
  });

  it("clamps at MAX_ZOOM instead of drifting past it", async () => {
    const { zoom, zoomIn, MAX_ZOOM } = await freshTextSizeStore();
    for (let i = 0; i < 30; i++) zoomIn();
    expect(get(zoom)).toBe(MAX_ZOOM);
    zoomIn();
    expect(get(zoom)).toBe(MAX_ZOOM);
  });

  it("clamps at MIN_ZOOM instead of drifting past it", async () => {
    const { zoom, zoomOut, MIN_ZOOM } = await freshTextSizeStore();
    for (let i = 0; i < 30; i++) zoomOut();
    expect(get(zoom)).toBe(MIN_ZOOM);
    zoomOut();
    expect(get(zoom)).toBe(MIN_ZOOM);
  });

  it("resetZoom sets and persists DEFAULT_ZOOM", async () => {
    const { zoom, zoomIn, resetZoom, DEFAULT_ZOOM } = await freshTextSizeStore();
    zoomIn();
    zoomIn();
    resetZoom();
    expect(get(zoom)).toBe(DEFAULT_ZOOM);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toBe(DEFAULT_ZOOM);
  });
});
