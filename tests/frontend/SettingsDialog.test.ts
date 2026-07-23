import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, fireEvent, cleanup, screen } from "@testing-library/svelte";
import { mockWindows, mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import SettingsDialog from "../../src/lib/shell/SettingsDialog.svelte";
import { settingsOverlay } from "../../src/lib/stores/settingsOverlay";
import { setTheme, themeSelection } from "../../src/lib/stores/theme";
import { terminalPosition } from "../../src/lib/stores/layout";
import { zoom, zoomIn, DEFAULT_ZOOM } from "../../src/lib/stores/textSize";
import { minimapEnabled, DEFAULT_MINIMAP_ENABLED } from "../../src/lib/stores/minimapEnabled";
import { recents } from "../../src/lib/stores/recents";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  workspaceClearRecents: vi.fn(),
  isAppError: (value: unknown): value is { code: string; message: string } =>
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value,
}));

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await tick();
}

async function selectCategory(name: string): Promise<void> {
  await fireEvent.click(screen.getByRole("tab", { name }));
  await flush();
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWindows("main");
    mockIPC(() => null);
    vi.mocked(commands.workspaceClearRecents).mockResolvedValue(undefined);
    settingsOverlay.set({ open: false });
    setTheme("auto");
    terminalPosition.set("bottom");
    zoom.set(DEFAULT_ZOOM);
    minimapEnabled.set(DEFAULT_MINIMAP_ENABLED);
    recents.set([{ path: "/projects/foo", name: "foo", lastOpenedAt: 1 }]);
  });

  afterEach(() => {
    cleanup();
    clearMocks();
  });

  it("renders nothing until the overlay is open", () => {
    const { container } = render(SettingsDialog);
    expect(container.querySelector(".settings-panel")).toBeNull();
  });

  it("opens when settingsOverlay is open, moving focus into the panel", async () => {
    settingsOverlay.set({ open: true });
    const { container } = render(SettingsDialog);
    await tick();

    const panel = container.querySelector(".settings-panel");
    expect(panel).not.toBeNull();
    expect(document.activeElement).toBe(panel);
  });

  it("closes on a real Escape keypress reaching the panel", async () => {
    settingsOverlay.set({ open: true });
    render(SettingsDialog);
    await tick();

    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(get(settingsOverlay).open).toBe(false);
  });

  it("closes on a backdrop click but not on a click inside the panel", async () => {
    settingsOverlay.set({ open: true });
    const { container } = render(SettingsDialog);
    await tick();

    await fireEvent.click(container.querySelector(".settings-panel")!);
    expect(get(settingsOverlay).open).toBe(true);

    await fireEvent.click(container.querySelector(".settings-backdrop")!);
    expect(get(settingsOverlay).open).toBe(false);
  });

  it("closes via the Done button", async () => {
    settingsOverlay.set({ open: true });
    render(SettingsDialog);
    await tick();

    await fireEvent.click(screen.getByText("Done"));

    expect(get(settingsOverlay).open).toBe(false);
  });

  describe("sidebar navigation", () => {
    it("renders all four categories, with General selected and its content shown by default", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual(["General", "Appearance", "Editor", "Terminal"]);
      expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByText("Recent Projects")).toBeTruthy();
      expect(screen.queryByText("Theme")).toBeNull();
    });

    it("clicking a category switches the visible content and marks it selected", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await selectCategory("Appearance");

      expect(screen.getByRole("tab", { name: "Appearance" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("false");
      expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
      expect(screen.queryByText("Recent Projects")).toBeNull();
    });

    it("resets the selected category back to General each time the dialog re-opens", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await selectCategory("Editor");
      expect(screen.getByRole("tab", { name: "Editor" }).getAttribute("aria-selected")).toBe("true");

      settingsOverlay.set({ open: false });
      await tick();
      settingsOverlay.set({ open: true });
      await tick();

      expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    });
  });

  describe("collapsible sections", () => {
    it("start expanded, and the chevron toggles the body's visibility and aria-expanded", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const header = screen.getByRole("button", { name: "Recent Projects" });
      expect(header.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("Clear Recent Projects")).toBeTruthy();

      await fireEvent.click(header);
      await tick();

      expect(header.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("Clear Recent Projects")).toBeNull();

      await fireEvent.click(header);
      await tick();

      expect(header.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("Clear Recent Projects")).toBeTruthy();
    });
  });

  describe("search", () => {
    it("filters non-matching categories from the sidebar and switches to a matching one", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "theme" } });
      await tick();

      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual(["Appearance"]);
      expect(screen.getByRole("tab", { name: "Appearance" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
    });

    it("matches on a declared keyword synonym, not just the section title", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      // "layout" was the section's pre-redesign name; keeping it as a
      // keyword means an old query for it still finds Dock Position.
      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "layout" } });
      await tick();

      expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Terminal"]);
      expect(screen.getByText("Dock Position")).toBeTruthy();
    });

    it("auto-expands a matched section that was collapsed", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();

      await selectCategory("Appearance");
      const header = container.querySelector(".settings-section-header") as HTMLElement;
      await fireEvent.click(header);
      await tick();
      expect(header.getAttribute("aria-expanded")).toBe("false");

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "theme" } });
      await tick();

      expect(header.getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector(".dropdown-trigger")).not.toBeNull();
    });

    it("shows an empty state when nothing matches", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "nonexistent-setting" } });
      await tick();

      expect(screen.queryAllByRole("tab")).toHaveLength(0);
      expect(screen.getByText("No settings match your search.")).toBeTruthy();
    });

    it("clearing the query restores the full sidebar and content", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const input = screen.getByLabelText("Search settings");
      await fireEvent.input(input, { target: { value: "theme" } });
      await tick();
      expect(screen.getAllByRole("tab")).toHaveLength(1);

      await fireEvent.input(input, { target: { value: "" } });
      await tick();

      expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
        "General",
        "Appearance",
        "Editor",
        "Terminal",
      ]);
    });
  });

  // Both the settings section header and the Dropdown trigger it contains
  // are `role="button"` elements, and both are labeled after the same
  // setting name (the section's own title vs. the dropdown's aria-label),
  // so opening a dropdown queries its trigger via the `.dropdown-trigger`
  // class rather than an ambiguous `getByRole("button", { name })`.
  function dropdownTrigger(container: HTMLElement): HTMLButtonElement {
    return container.querySelector(".dropdown-trigger") as HTMLButtonElement;
  }

  describe("theme", () => {
    async function openThemeDropdown(): Promise<HTMLElement> {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");
      await fireEvent.click(dropdownTrigger(container));
      await flush();
      return container;
    }

    it("marks Auto as selected when the selection is auto", async () => {
      await openThemeDropdown();

      const options = screen.getAllByRole("option");
      expect(options.map((o) => o.textContent?.trim())).toEqual([
        "✓ Auto",
        "Atrium Dark",
        "Atrium Light",
        "Atrium High Contrast",
      ]);
      expect(options[0].getAttribute("aria-selected")).toBe("true"); // Auto
      expect(options.slice(1).every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    });

    it("marks the concrete theme as selected, not Auto, once a concrete theme is selected", async () => {
      setTheme("atrium-light");
      await openThemeDropdown();

      expect(screen.getByRole("option", { name: "Auto" }).getAttribute("aria-selected")).toBe("false");
      expect(screen.getByRole("option", { name: "Atrium Light" }).getAttribute("aria-selected")).toBe("true");
    });

    it("clicking a theme option calls setTheme, reflected in themeSelection, and closes the dropdown", async () => {
      await openThemeDropdown();

      await fireEvent.click(screen.getByRole("option", { name: "Atrium High Contrast" }));
      await flush();

      expect(get(themeSelection)).toBe("atrium-high-contrast");
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });

  describe("terminal dock position", () => {
    async function openDockPositionDropdown(): Promise<HTMLElement> {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await selectCategory("Terminal");
      await fireEvent.click(dropdownTrigger(container));
      await flush();
      return container;
    }

    it("marks the current position as selected", async () => {
      terminalPosition.set("left");
      await openDockPositionDropdown();

      expect(screen.getByRole("option", { name: "Bottom" }).getAttribute("aria-selected")).toBe("false");
      expect(screen.getByRole("option", { name: "Left" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("option", { name: "Right" }).getAttribute("aria-selected")).toBe("false");
    });

    it("clicking a position option updates the shared terminalPosition store and closes the dropdown", async () => {
      await openDockPositionDropdown();

      await fireEvent.click(screen.getByRole("option", { name: "Right" }));
      await flush();

      expect(get(terminalPosition)).toBe("right");
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });

  describe("zoom", () => {
    it("shows the current zoom percentage and updates it via the stepper", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      expect(screen.getByText("100%")).toBeTruthy();

      await fireEvent.click(screen.getByLabelText("Zoom in"));
      await tick();

      expect(get(zoom)).toBeCloseTo(1.1);
      expect(screen.getByText("110%")).toBeTruthy();
    });

    it("Reset restores the default zoom", async () => {
      zoomIn();
      zoomIn();
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      await fireEvent.click(screen.getByText("Reset"));

      expect(get(zoom)).toBe(DEFAULT_ZOOM);
    });
  });

  describe("minimap", () => {
    it("shows the checkbox checked by default (on by default)", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      expect(screen.getByLabelText("Show minimap")).toHaveProperty("checked", true);
    });

    it("unchecking the toggle turns the setting off, reflected in the shared store", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      await fireEvent.click(screen.getByLabelText("Show minimap"));
      await flush();

      expect(get(minimapEnabled)).toBe(false);
      expect(screen.getByLabelText("Show minimap")).toHaveProperty("checked", false);
    });

    it("re-checking the toggle turns the setting back on", async () => {
      minimapEnabled.set(false);
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      await fireEvent.click(screen.getByLabelText("Show minimap"));
      await flush();

      expect(get(minimapEnabled)).toBe(true);
    });
  });

  describe("keyboard navigation (dropdown)", () => {
    it("ArrowDown advances to the next theme option, and Enter selects it", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");

      await fireEvent.click(dropdownTrigger(container));
      await flush();
      const listbox = screen.getByRole("listbox", { name: "Theme" });

      await fireEvent.keyDown(listbox, { key: "ArrowDown" });
      await fireEvent.keyDown(listbox, { key: "Enter" });
      await flush();

      expect(get(themeSelection)).toBe("atrium-dark");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("ArrowUp from the first theme option wraps around to the last, and Space selects it", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");

      await fireEvent.click(dropdownTrigger(container));
      await flush();
      const listbox = screen.getByRole("listbox", { name: "Theme" });

      await fireEvent.keyDown(listbox, { key: "ArrowUp" });
      await fireEvent.keyDown(listbox, { key: " " });
      await flush();

      expect(get(themeSelection)).toBe("atrium-high-contrast");
    });

    it("End jumps to the last dock-position option, selecting it on Enter", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await selectCategory("Terminal");

      await fireEvent.click(dropdownTrigger(container));
      await flush();
      const listbox = screen.getByRole("listbox", { name: "Terminal dock position" });

      await fireEvent.keyDown(listbox, { key: "End" });
      await fireEvent.keyDown(listbox, { key: "Enter" });
      await flush();

      expect(get(terminalPosition)).toBe("right");
    });

    it("Escape closes the dropdown without changing the selection", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");

      await fireEvent.click(dropdownTrigger(container));
      await flush();
      const listbox = screen.getByRole("listbox", { name: "Theme" });

      await fireEvent.keyDown(listbox, { key: "ArrowDown" });
      await fireEvent.keyDown(listbox, { key: "Escape" });
      await flush();

      expect(get(themeSelection)).toBe("auto");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("ignores a non-navigation key, leaving the dropdown open with the selection unchanged", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");

      await fireEvent.click(dropdownTrigger(container));
      await flush();
      const listbox = screen.getByRole("listbox", { name: "Theme" });

      await fireEvent.keyDown(listbox, { key: "a" });
      await flush();

      expect(get(themeSelection)).toBe("auto");
      expect(screen.queryByRole("listbox")).not.toBeNull();
    });
  });

  describe("recent projects", () => {
    it("Clear Recent Projects calls workspaceClearRecents, shows a confirmation, and empties the shared recents store", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.click(screen.getByText("Clear Recent Projects"));
      await flush();

      expect(commands.workspaceClearRecents).toHaveBeenCalledOnce();
      expect(await screen.findByText("Cleared")).toBeTruthy();
      // Proves the fix for the stale-welcome-screen bug: WelcomeScreen reads
      // this same store, so it reflects the clear immediately with no
      // remount required.
      expect(get(recents)).toEqual([]);
    });

    it("shows an error message if clearing fails, leaving the shared recents store untouched", async () => {
      vi.mocked(commands.workspaceClearRecents).mockRejectedValueOnce(new Error("disk full"));
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.click(screen.getByText("Clear Recent Projects"));
      await flush();

      expect(await screen.findByText(/disk full/)).toBeTruthy();
      expect(get(recents)).toHaveLength(1);
    });

    it("auto-hides the Cleared confirmation after CLEARED_BADGE_MS", async () => {
      vi.useFakeTimers();
      try {
        settingsOverlay.set({ open: true });
        render(SettingsDialog);
        await tick();

        await fireEvent.click(screen.getByText("Clear Recent Projects"));
        await flush();
        expect(screen.getByText("Cleared")).toBeTruthy();

        await vi.advanceTimersByTimeAsync(3000);
        await tick();

        expect(screen.queryByText("Cleared")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
