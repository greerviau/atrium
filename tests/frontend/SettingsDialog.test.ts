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
      render(SettingsDialog);
      await tick();

      await selectCategory("Appearance");
      const header = screen.getByRole("button", { name: "Theme" });
      await fireEvent.click(header);
      await tick();
      expect(header.getAttribute("aria-expanded")).toBe("false");

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "theme" } });
      await tick();

      expect(screen.getByRole("button", { name: "Theme" }).getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
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

  describe("theme", () => {
    it("marks Auto as checked when the selection is auto", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");

      const options = screen.getAllByRole("radio", { name: /Auto|Atrium/ });
      expect(options[0].getAttribute("aria-checked")).toBe("true"); // Auto
      expect(options.slice(1).every((o) => o.getAttribute("aria-checked") === "false")).toBe(true);
    });

    it("marks the concrete theme as checked, not Auto, once a concrete theme is selected", async () => {
      setTheme("atrium-light");
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");

      expect(screen.getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("false");
      expect(screen.getByRole("radio", { name: "Atrium Light" }).getAttribute("aria-checked")).toBe("true");
    });

    it("clicking a theme option calls setTheme, reflected in themeSelection", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");

      await fireEvent.click(screen.getByRole("radio", { name: "Atrium High Contrast" }));
      await flush();

      expect(get(themeSelection)).toBe("atrium-high-contrast");
    });
  });

  describe("terminal dock position", () => {
    it("marks the current position as checked", async () => {
      terminalPosition.set("left");
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Terminal");

      expect(screen.getByRole("radio", { name: "Bottom" }).getAttribute("aria-checked")).toBe("false");
      expect(screen.getByRole("radio", { name: "Left" }).getAttribute("aria-checked")).toBe("true");
      expect(screen.getByRole("radio", { name: "Right" }).getAttribute("aria-checked")).toBe("false");
    });

    it("clicking a position option updates the shared terminalPosition store", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Terminal");

      await fireEvent.click(screen.getByRole("radio", { name: "Right" }));

      expect(get(terminalPosition)).toBe("right");
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

  describe("keyboard navigation (radiogroup)", () => {
    it("ArrowRight advances to the next theme option and selects it", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");

      const auto = screen.getByRole("radio", { name: "Auto" });
      auto.focus();
      await fireEvent.keyDown(auto, { key: "ArrowRight" });
      await flush();

      expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Atrium Dark" }));
      expect(get(themeSelection)).toBe("atrium-dark");
    });

    it("ArrowLeft from the first theme option wraps around to the last", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");

      const auto = screen.getByRole("radio", { name: "Auto" });
      auto.focus();
      await fireEvent.keyDown(auto, { key: "ArrowLeft" });
      await flush();

      expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Atrium High Contrast" }));
      expect(get(themeSelection)).toBe("atrium-high-contrast");
    });

    it("End jumps to the last option, selecting it (dock-position radiogroup)", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Terminal");

      const bottom = screen.getByRole("radio", { name: "Bottom" });
      bottom.focus();
      await fireEvent.keyDown(bottom, { key: "End" });
      await flush();

      expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Right" }));
      expect(get(terminalPosition)).toBe("right");
    });

    it("ignores a non-navigation key", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Appearance");

      const auto = screen.getByRole("radio", { name: "Auto" });
      auto.focus();
      await fireEvent.keyDown(auto, { key: "a" });
      await flush();

      expect(document.activeElement).toBe(auto);
      expect(get(themeSelection)).toBe("auto");
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
