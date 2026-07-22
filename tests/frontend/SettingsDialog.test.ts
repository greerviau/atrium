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

  describe("theme", () => {
    it("marks Auto as checked when the selection is auto", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const options = screen.getAllByRole("radio", { name: /Auto|Atrium/ });
      expect(options[0].getAttribute("aria-checked")).toBe("true"); // Auto
      expect(options.slice(1).every((o) => o.getAttribute("aria-checked") === "false")).toBe(true);
    });

    it("marks the concrete theme as checked, not Auto, once a concrete theme is selected", async () => {
      setTheme("atrium-light");
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      expect(screen.getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("false");
      expect(screen.getByRole("radio", { name: "Atrium Light" }).getAttribute("aria-checked")).toBe("true");
    });

    it("clicking a theme option calls setTheme, reflected in themeSelection", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

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

      expect(screen.getByRole("radio", { name: "Bottom" }).getAttribute("aria-checked")).toBe("false");
      expect(screen.getByRole("radio", { name: "Left" }).getAttribute("aria-checked")).toBe("true");
      expect(screen.getByRole("radio", { name: "Right" }).getAttribute("aria-checked")).toBe("false");
    });

    it("clicking a position option updates the shared terminalPosition store", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.click(screen.getByRole("radio", { name: "Right" }));

      expect(get(terminalPosition)).toBe("right");
    });
  });

  describe("zoom", () => {
    it("shows the current zoom percentage and updates it via the stepper", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

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

      await fireEvent.click(screen.getByText("Reset"));

      expect(get(zoom)).toBe(DEFAULT_ZOOM);
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
  });
});
