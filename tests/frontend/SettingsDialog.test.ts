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
import { markdownDefaultView, DEFAULT_MARKDOWN_VIEW } from "../../src/lib/stores/markdownDefaultView";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await tick();
}

async function selectCategory(name: string): Promise<void> {
  await fireEvent.click(screen.getByRole("treeitem", { name }));
  await flush();
}

// A category row's `textContent` includes its `aria-hidden` chevron glyph
// (`aria-hidden` only excludes it from accessible-name computation, which is
// what role/name queries use — it has no effect on the raw DOM property), so
// comparisons against a row's visible label strip it out here.
function rowLabel(el: Element): string | undefined {
  return el.textContent?.replace(/^▸\s*/, "").trim();
}

// `Element.prototype.scrollIntoView` isn't implemented in jsdom — every test
// that activates a section nav row needs it stubbed, or the assertion
// silently passes without checking anything (or the click throws).
let scrollIntoViewSpy: ReturnType<typeof vi.fn>;

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWindows("main");
    mockIPC(() => null);
    settingsOverlay.set({ open: false });
    setTheme("auto");
    terminalPosition.set("bottom");
    zoom.set(DEFAULT_ZOOM);
    minimapEnabled.set(DEFAULT_MINIMAP_ENABLED);
    markdownDefaultView.set(DEFAULT_MARKDOWN_VIEW);
    scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
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
    it("renders all five categories expanded with their one section each, General selected and its content shown by default", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const rows = screen.getAllByRole("treeitem");
      const categoryRows = rows.filter((r) => r.getAttribute("aria-level") === "1");
      expect(categoryRows.map((r) => rowLabel(r))).toEqual([
        "General",
        "Appearance",
        "Editor",
        "Markdown",
        "Terminal",
      ]);
      expect(categoryRows[0].getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("treeitem", { name: "Zoom" })).toBeTruthy();
      expect(screen.getByRole("treeitem", { name: "Theme" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Theme" })).toBeNull();
    });

    it("clicking a category switches the visible content and marks it selected", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await selectCategory("Appearance");

      expect(screen.getByRole("treeitem", { name: "Appearance" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("treeitem", { name: "General" }).getAttribute("aria-selected")).toBe("false");
      expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Zoom" })).toBeNull();
    });

    it("resets the selected category back to General each time the dialog re-opens", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await selectCategory("Editor");
      expect(screen.getByRole("treeitem", { name: "Editor" }).getAttribute("aria-selected")).toBe("true");

      settingsOverlay.set({ open: false });
      await tick();
      settingsOverlay.set({ open: true });
      await tick();

      expect(screen.getByRole("treeitem", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    });
  });

  describe("content region labelling", () => {
    it("labels the content region with the selected category's name, updating when selection changes", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      expect(screen.getByRole("region").getAttribute("aria-label")).toBe("General");

      await selectCategory("Appearance");

      expect(screen.getByRole("region").getAttribute("aria-label")).toBe("Appearance");
    });

    it("keeps the content region named via aria-label when no rows render (no-match search state)", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      const preSearchLabel = screen.getByRole("region").getAttribute("aria-label");

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "nonexistent-setting" } });
      await tick();

      expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
      expect(preSearchLabel).toBeTruthy();
      expect(screen.getByRole("region").getAttribute("aria-label")).toBe(preSearchLabel);
    });
  });

  describe("keyboard navigation (sidebar tree)", () => {
    it("ArrowDown moves focus through categories and their sections without switching the mounted category", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const general = screen.getByRole("treeitem", { name: "General" });
      await fireEvent.keyDown(general, { key: "ArrowDown" });
      await flush();

      const zoomRow = screen.getByRole("treeitem", { name: "Zoom" });
      expect(zoomRow.getAttribute("aria-selected")).toBe("true");
      expect(zoomRow.getAttribute("tabindex")).toBe("0");
      expect(document.activeElement).toBe(zoomRow);
      expect(general.getAttribute("aria-selected")).toBe("false");
      expect(general.getAttribute("tabindex")).toBe("-1");
      // Arrowing onto a row must never, by itself, switch the mounted content.
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();

      await fireEvent.keyDown(zoomRow, { key: "ArrowDown" });
      await flush();

      const appearance = screen.getByRole("treeitem", { name: "Appearance" });
      expect(appearance.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(appearance);
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();
    });

    it("ArrowUp moves focus to the previous visible row", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const general = screen.getByRole("treeitem", { name: "General" });
      await fireEvent.keyDown(general, { key: "ArrowDown" });
      await flush();
      const zoomRow = screen.getByRole("treeitem", { name: "Zoom" });

      await fireEvent.keyDown(zoomRow, { key: "ArrowUp" });
      await flush();

      expect(general.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(general);
    });

    it("Home jumps to the first row and End jumps to the last visible row", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const general = screen.getByRole("treeitem", { name: "General" });
      await fireEvent.keyDown(general, { key: "End" });
      await flush();

      const dockPosition = screen.getByRole("treeitem", { name: "Dock Position" });
      expect(dockPosition.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(dockPosition);

      await fireEvent.keyDown(dockPosition, { key: "Home" });
      await flush();

      expect(general.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(general);
    });

    it("Right expands a collapsed category to reveal its section row, Left collapses it again, neither changing the mounted category", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const appearance = screen.getByRole("treeitem", { name: "Appearance" });
      await fireEvent.keyDown(appearance, { key: "ArrowLeft" });
      await flush();

      expect(appearance.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("treeitem", { name: "Theme" })).toBeNull();
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();

      await fireEvent.keyDown(appearance, { key: "ArrowRight" });
      await flush();

      expect(appearance.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("treeitem", { name: "Theme" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();
    });

    it("Left on a focused section row moves focus to its parent category row", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const general = screen.getByRole("treeitem", { name: "General" });
      await fireEvent.keyDown(general, { key: "ArrowDown" });
      await flush();
      const zoomRow = screen.getByRole("treeitem", { name: "Zoom" });

      await fireEvent.keyDown(zoomRow, { key: "ArrowLeft" });
      await flush();

      expect(general.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(general);
    });

    it("Enter activates a focused section row (switches the mounted category and scrolls to it), but arrowing onto it alone does neither", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const general = screen.getByRole("treeitem", { name: "General" });
      await fireEvent.keyDown(general, { key: "ArrowDown" });
      await flush();
      await fireEvent.keyDown(screen.getByRole("treeitem", { name: "Zoom" }), { key: "ArrowDown" });
      await flush();
      await fireEvent.keyDown(screen.getByRole("treeitem", { name: "Appearance" }), { key: "ArrowDown" });
      await flush();
      const themeRow = screen.getByRole("treeitem", { name: "Theme" });
      expect(themeRow.getAttribute("aria-selected")).toBe("true");

      // Precondition: arrowing onto the row must not itself have activated it.
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Theme" })).toBeNull();
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();

      await fireEvent.keyDown(themeRow, { key: "Enter" });
      await flush();

      expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Zoom" })).toBeNull();
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });

    it("Space activates a focused section row the same way Enter does", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const general = screen.getByRole("treeitem", { name: "General" });
      await fireEvent.keyDown(general, { key: "ArrowDown" });
      await flush();
      await fireEvent.keyDown(screen.getByRole("treeitem", { name: "Zoom" }), { key: "ArrowDown" });
      await flush();
      await fireEvent.keyDown(screen.getByRole("treeitem", { name: "Appearance" }), { key: "ArrowDown" });
      await flush();
      const themeRow = screen.getByRole("treeitem", { name: "Theme" });

      expect(screen.queryByRole("heading", { name: "Theme" })).toBeNull();
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();

      await fireEvent.keyDown(themeRow, { key: " " });
      await flush();

      expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });

    it("Enter on a focused category row activates it, toggling expansion and switching the mounted category", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const general = screen.getByRole("treeitem", { name: "General" });
      await fireEvent.keyDown(general, { key: "ArrowDown" });
      await flush();
      await fireEvent.keyDown(screen.getByRole("treeitem", { name: "Zoom" }), { key: "ArrowDown" });
      await flush();
      const appearance = screen.getByRole("treeitem", { name: "Appearance" });
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();

      await fireEvent.keyDown(appearance, { key: "Enter" });
      await flush();

      expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
      expect(appearance.getAttribute("aria-expanded")).toBe("false");
    });

    it("falls the tabbable row back to the first visible row when a search unmounts the focused row, and arrow movement still works from there", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const general = screen.getByRole("treeitem", { name: "General" });
      await fireEvent.keyDown(general, { key: "End" });
      await flush();
      const dockPosition = screen.getByRole("treeitem", { name: "Dock Position" });
      expect(dockPosition.getAttribute("tabindex")).toBe("0");

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "theme" } });
      await tick();

      const tabbableAfterSearch = screen.getAllByRole("treeitem").filter((r) => r.getAttribute("tabindex") === "0");
      expect(tabbableAfterSearch).toHaveLength(1);

      // Extends the fallback check with an arrow press: if movement were
      // still keyed off the stale raw focused id instead of this same
      // fallback row, this would go inert.
      await fireEvent.keyDown(tabbableAfterSearch[0], { key: "ArrowDown" });
      await flush();
      const tabbableAfterArrow = screen.getAllByRole("treeitem").filter((r) => r.getAttribute("tabindex") === "0");
      expect(tabbableAfterArrow).toHaveLength(1);
      expect(tabbableAfterArrow[0]).not.toBe(tabbableAfterSearch[0]);
    });
  });

  describe("single-selection invariant", () => {
    it("keeps exactly one treeitem selected at a time, whether a section or a category was clicked last", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const themeRow = screen.getByRole("treeitem", { name: "Theme" });
      await fireEvent.click(themeRow);
      await flush();

      let selected = screen.getAllByRole("treeitem").filter((r) => r.getAttribute("aria-selected") === "true");
      expect(selected).toHaveLength(1);
      expect(selected[0]).toBe(themeRow);
      expect(themeRow.getAttribute("tabindex")).toBe("0");

      const editorRow = screen.getByRole("treeitem", { name: "Editor" });
      await fireEvent.click(editorRow);
      await flush();

      selected = screen.getAllByRole("treeitem").filter((r) => r.getAttribute("aria-selected") === "true");
      expect(selected).toHaveLength(1);
      expect(selected[0]).toBe(editorRow);
      expect(themeRow.getAttribute("aria-selected")).toBe("false");
    });
  });

  describe("clicking a section nav row", () => {
    it("switches the mounted category when the section belongs to a different one, and scrolls to it", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const themeRow = screen.getByRole("treeitem", { name: "Theme" });
      await fireEvent.click(themeRow);
      await flush();

      expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });

    it("scrolls to the section even when it already belongs to the mounted category", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const zoomRow = screen.getByRole("treeitem", { name: "Zoom" });
      await fireEvent.click(zoomRow);
      await flush();

      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });
  });

  describe("panel sizing", () => {
    it("keeps a fixed panel height regardless of how much content a search narrows the panel to", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();

      const panel = container.querySelector(".settings-panel") as HTMLElement;
      const heightBefore = getComputedStyle(panel).height;
      expect(heightBefore).toBe("80vh");

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "theme" } });
      await tick();

      expect(getComputedStyle(panel).height).toBe(heightBefore);
    });
  });

  describe("search", () => {
    it("filters non-matching categories from the sidebar and switches to a matching one", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "theme" } });
      await tick();

      const rows = screen.getAllByRole("treeitem");
      expect(rows.map((r) => rowLabel(r))).toEqual(["Appearance", "Theme"]);
      expect(screen.getByRole("treeitem", { name: "Appearance" }).getAttribute("aria-selected")).toBe("true");
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

      const rows = screen.getAllByRole("treeitem");
      expect(rows.map((r) => rowLabel(r))).toEqual(["Terminal", "Dock Position"]);
      expect(screen.getByRole("heading", { name: "Dock Position" })).toBeTruthy();
    });

    it("shows an empty state when nothing matches", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "nonexistent-setting" } });
      await tick();

      expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
      expect(screen.getByText("No settings match your search.")).toBeTruthy();
    });

    it("clearing the query restores the full sidebar and content", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const input = screen.getByLabelText("Search settings");
      await fireEvent.input(input, { target: { value: "theme" } });
      await tick();
      expect(screen.getAllByRole("treeitem").map((r) => rowLabel(r))).toEqual(["Appearance", "Theme"]);

      await fireEvent.input(input, { target: { value: "" } });
      await tick();

      const categoryRows = screen.getAllByRole("treeitem").filter((r) => r.getAttribute("aria-level") === "1");
      expect(categoryRows.map((r) => rowLabel(r))).toEqual([
        "General",
        "Appearance",
        "Editor",
        "Markdown",
        "Terminal",
      ]);
    });
  });

  // Both the settings section heading and the Dropdown trigger it contains
  // are queried by role elsewhere, so opening a dropdown queries its trigger
  // via the `.dropdown-trigger` class rather than an ambiguous role/name.
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

  describe("markdown default view", () => {
    async function openMarkdownViewDropdown(): Promise<HTMLElement> {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await selectCategory("Markdown");
      await fireEvent.click(dropdownTrigger(container));
      await flush();
      return container;
    }

    it("marks the current default view as selected", async () => {
      markdownDefaultView.set("source");
      await openMarkdownViewDropdown();

      expect(screen.getByRole("option", { name: "Rendered" }).getAttribute("aria-selected")).toBe("false");
      expect(screen.getByRole("option", { name: "Source" }).getAttribute("aria-selected")).toBe("true");
    });

    it("clicking an option updates the shared markdownDefaultView store and closes the dropdown", async () => {
      await openMarkdownViewDropdown();

      await fireEvent.click(screen.getByRole("option", { name: "Source" }));
      await flush();

      expect(get(markdownDefaultView)).toBe("source");
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });

  describe("zoom", () => {
    it("shows the current zoom percentage and updates it via the stepper", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("General");

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
      await selectCategory("General");

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
});
