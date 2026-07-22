import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockWindows, mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { get } from "svelte/store";
import { atriumDark, atriumLight } from "../../src/lib/theme/tokens";

const STORAGE_KEY = "atrium.theme";

/**
 * The theme store module reads its persisted selection once at import time
 * (module-level `let selection = loadSelection()`), so each test that needs
 * a specific starting selection/localStorage state resets the module
 * registry and re-imports it fresh, matching the seam this project's other
 * Tauri-API-dependent tests would use (`@tauri-apps/api/mocks`, the
 * documented approach for mocking `getCurrentWindow()`/`onThemeChanged` in a
 * vitest+jsdom environment: `mockWindows` establishes the current window
 * label `getCurrentWindow()` resolves against, and `mockIPC` intercepts the
 * `plugin:window|theme` command `.theme()` invokes under the hood; passing
 * `shouldMockEvents: true` additionally wires `listen`/`emit` so
 * `onThemeChanged` (built on `listen`) can be driven directly with `emit`).
 */
async function freshThemeStore(initialOsTheme: "light" | "dark" | null) {
  vi.resetModules();
  mockWindows("main");
  // A single mockIPC call must back the whole test: calling mockIPC again
  // mid-test replaces its internal listener registry wholesale, silently
  // dropping any listener already registered via onThemeChanged (listen).
  // Live OS-theme changes are simulated by mutating this closure variable
  // instead, so the one registered listener registry stays intact.
  const osThemeRef = { current: initialOsTheme };
  mockIPC((cmd) => {
    if (cmd === "plugin:window|theme") {
      return osThemeRef.current;
    }
    return null;
  }, { shouldMockEvents: true });
  const store = await import("../../src/lib/stores/theme");
  return { ...store, setOsTheme: (value: "light" | "dark" | null) => (osThemeRef.current = value) };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

describe("theme store startup", () => {
  it("resolves to Auto (OS dark) and applies Atrium Dark when nothing is persisted", async () => {
    const { initTheme, theme } = await freshThemeStore("dark");
    await initTheme();

    expect(get(theme)).toEqual(atriumDark);
    expect(document.documentElement.style.getPropertyValue("--atrium-bg-base")).toBe(atriumDark.tokens.bgBase);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("resolves to Auto (OS light) and applies Atrium Light when nothing is persisted", async () => {
    const { initTheme, theme } = await freshThemeStore("light");
    await initTheme();

    expect(get(theme)).toEqual(atriumLight);
    expect(document.documentElement.style.getPropertyValue("--atrium-bg-base")).toBe(atriumLight.tokens.bgBase);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to Atrium Dark when the OS theme is unavailable (null)", async () => {
    const { initTheme, theme } = await freshThemeStore(null);
    await initTheme();

    expect(get(theme)).toEqual(atriumDark);
  });

  it("falls back to Auto when the persisted value is unrecognized", async () => {
    localStorage.setItem(STORAGE_KEY, "not-a-real-theme");
    const { initTheme, theme } = await freshThemeStore("light");
    await initTheme();

    expect(get(theme)).toEqual(atriumLight);
  });

  it("resolves a concrete persisted selection directly, without consulting the OS theme", async () => {
    localStorage.setItem(STORAGE_KEY, "atrium-high-contrast");
    const { initTheme, theme } = await freshThemeStore("light");
    await initTheme();

    expect(get(theme).id).toBe("atrium-high-contrast");
  });
});

describe("setTheme", () => {
  it("persists the selection and applies the concrete theme", async () => {
    const { initTheme, setTheme, theme } = await freshThemeStore("dark");
    await initTheme();

    setTheme("atrium-light");
    await Promise.resolve();
    await Promise.resolve();

    expect(localStorage.getItem(STORAGE_KEY)).toBe("atrium-light");
    expect(get(theme)).toEqual(atriumLight);
  });

  it("ignores an unrecognized id", async () => {
    const { initTheme, setTheme, theme } = await freshThemeStore("dark");
    await initTheme();
    const before = get(theme);

    setTheme("not-a-real-theme");

    expect(get(theme)).toEqual(before);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBe("not-a-real-theme");
  });

  it("re-subscribes to onThemeChanged and updates the resolved theme on a live OS-appearance change, without rewriting the persisted selection away from auto", async () => {
    const { initTheme, setTheme, theme, setOsTheme } = await freshThemeStore("dark");
    await initTheme();

    setTheme("auto");
    await Promise.resolve();
    await Promise.resolve();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("auto");
    expect(get(theme)).toEqual(atriumDark);

    setOsTheme("light");
    await emit("tauri://theme-changed", "light");
    await Promise.resolve();
    await Promise.resolve();

    expect(get(theme)).toEqual(atriumLight);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("auto");
  });
});

describe("themeSelection", () => {
  it("starts at the persisted selection, defaulting to auto when nothing is persisted", async () => {
    const { themeSelection } = await freshThemeStore("dark");

    expect(get(themeSelection)).toBe("auto");
  });

  it("initializes from a persisted concrete selection", async () => {
    localStorage.setItem(STORAGE_KEY, "atrium-high-contrast");
    const { themeSelection } = await freshThemeStore("dark");

    expect(get(themeSelection)).toBe("atrium-high-contrast");
  });

  it("updates when setTheme selects a concrete theme", async () => {
    const { initTheme, setTheme, themeSelection } = await freshThemeStore("dark");
    await initTheme();

    setTheme("atrium-light");

    expect(get(themeSelection)).toBe("atrium-light");
  });

  it("stays 'auto' when setTheme(\"auto\") is chosen, even though the resolved theme store shows a concrete theme", async () => {
    const { initTheme, setTheme, theme, themeSelection } = await freshThemeStore("dark");
    await initTheme();

    setTheme("atrium-light");
    await Promise.resolve();
    await Promise.resolve();
    expect(get(themeSelection)).toBe("atrium-light");

    setTheme("auto");
    await vi.waitFor(() => expect(get(theme)).toEqual(atriumDark));

    expect(get(themeSelection)).toBe("auto");
  });

  it("does not change on an unrecognized id", async () => {
    const { initTheme, setTheme, themeSelection } = await freshThemeStore("dark");
    await initTheme();

    setTheme("not-a-real-theme");

    expect(get(themeSelection)).toBe("auto");
  });
});
