import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, fireEvent, cleanup, screen } from "@testing-library/svelte";
import KeyboardShortcutsDialog from "../../src/lib/shell/KeyboardShortcutsDialog.svelte";
import { shortcutsOverlay } from "../../src/lib/stores/shortcutsOverlay";

describe("KeyboardShortcutsDialog", () => {
  beforeEach(() => {
    shortcutsOverlay.set({ open: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing until the overlay is open", () => {
    const { container } = render(KeyboardShortcutsDialog);
    expect(container.querySelector(".shortcuts-panel")).toBeNull();
  });

  it("opens when shortcutsOverlay is open, moving focus into the panel", async () => {
    shortcutsOverlay.set({ open: true });
    const { container } = render(KeyboardShortcutsDialog);
    await tick();

    const panel = container.querySelector(".shortcuts-panel");
    expect(panel).not.toBeNull();
    expect(document.activeElement).toBe(panel);
  });

  it("closes on a real Escape keypress reaching the panel", async () => {
    shortcutsOverlay.set({ open: true });
    render(KeyboardShortcutsDialog);
    await tick();

    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(get(shortcutsOverlay).open).toBe(false);
  });

  it("closes on a backdrop click but not on a click inside the panel", async () => {
    shortcutsOverlay.set({ open: true });
    const { container } = render(KeyboardShortcutsDialog);
    await tick();

    await fireEvent.click(container.querySelector(".shortcuts-panel")!);
    expect(get(shortcutsOverlay).open).toBe(true);

    await fireEvent.click(container.querySelector(".shortcuts-backdrop")!);
    expect(get(shortcutsOverlay).open).toBe(false);
  });

  it("closes via the Done button", async () => {
    shortcutsOverlay.set({ open: true });
    render(KeyboardShortcutsDialog);
    await tick();

    await fireEvent.click(screen.getByText("Done"));

    expect(get(shortcutsOverlay).open).toBe(false);
  });

  it("lists every shortcut group and label, including the terminal-only Shift+Enter entry", async () => {
    shortcutsOverlay.set({ open: true });
    render(KeyboardShortcutsDialog);
    await tick();

    for (const group of ["General", "File", "Edit", "View", "Explorer", "Terminal"]) {
      expect(screen.getByText(group)).toBeTruthy();
    }

    const labels = [
      "Settings",
      "Open Folder",
      "Save",
      "New Terminal Tab",
      "Find in Files",
      "Go to File",
      "Toggle File Explorer",
      "Toggle Terminal",
      "Split Up",
      "Split Down",
      "Split Left",
      "Split Right",
      "Split Terminal (alias for Split Right)",
      "Zoom In",
      "Zoom Out",
      "Reset Zoom",
      "New File",
      "New Folder",
      "Rename",
      "Delete",
      "Reveal in Finder",
      "Insert Newline Without Submitting",
    ];
    for (const label of labels) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    // Otherwise-undiscoverable: no menu entry backs any of these (§ Gap 1a/1b).
    expect(screen.getByText("⇧⏎")).toBeTruthy();
    expect(screen.getByText("⌘N")).toBeTruthy();
    expect(screen.getByText("F2")).toBeTruthy();
  });
});
