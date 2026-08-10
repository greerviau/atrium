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
import { proseWidth, DEFAULT_PROSE_WIDTH } from "../../src/lib/stores/proseWidth";
import { wordWrapEnabled, DEFAULT_WORD_WRAP_ENABLED } from "../../src/lib/stores/wordWrap";
import { tabSize, DEFAULT_TAB_SIZE } from "../../src/lib/stores/tabSize";
import { lineNumbersEnabled, DEFAULT_LINE_NUMBERS_ENABLED } from "../../src/lib/stores/lineNumbersEnabled";
import { autoSaveEnabled, DEFAULT_AUTO_SAVE_ENABLED } from "../../src/lib/stores/autoSave";
import { restoreTabsOnStartup, DEFAULT_RESTORE_TABS_ON_STARTUP } from "../../src/lib/stores/restoreTabsOnStartup";

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

// Every category starts collapsed, so a test that needs one of its section
// rows present in the nav must expand it first — via the caret button, the
// same control a real user would click, rather than reaching into component
// state directly.
async function expandCategory(label: string): Promise<void> {
  await fireEvent.click(screen.getByRole("button", { name: `Expand ${label}` }));
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
    proseWidth.set(DEFAULT_PROSE_WIDTH);
    wordWrapEnabled.set(DEFAULT_WORD_WRAP_ENABLED);
    tabSize.set(DEFAULT_TAB_SIZE);
    lineNumbersEnabled.set(DEFAULT_LINE_NUMBERS_ENABLED);
    autoSaveEnabled.set(DEFAULT_AUTO_SAVE_ENABLED);
    restoreTabsOnStartup.set(DEFAULT_RESTORE_TABS_ON_STARTUP);
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
    it("renders all five categories collapsed, General selected and its content shown by default", async () => {
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
      // Every category starts collapsed — no section rows render in the nav
      // until a caret is clicked (or the row arrowed-into via ArrowRight).
      expect(categoryRows.every((r) => r.getAttribute("aria-expanded") === "false")).toBe(true);
      expect(rows).toHaveLength(categoryRows.length);
      // The content pane is independent of the nav's own collapse state —
      // General's controls still show even though its nav row is collapsed.
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

    it("clicking a category's text never expands or collapses it, whether it starts collapsed or already expanded", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const appearance = screen.getByRole("treeitem", { name: "Appearance" });
      expect(appearance.getAttribute("aria-expanded")).toBe("false");

      await selectCategory("Appearance");

      expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
      expect(appearance.getAttribute("aria-expanded")).toBe("false");

      // Expand it via the caret, then select it again by text — it must
      // stay expanded, not toggle closed.
      await expandCategory("Appearance");
      expect(appearance.getAttribute("aria-expanded")).toBe("true");

      await selectCategory("Appearance");
      expect(appearance.getAttribute("aria-expanded")).toBe("true");
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

  describe("category caret vs. text click targets", () => {
    it("clicking the caret toggles expansion without selecting the category or changing the content pane", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const appearance = screen.getByRole("treeitem", { name: "Appearance" });
      expect(appearance.getAttribute("aria-expanded")).toBe("false");
      // `mounted` (not `aria-selected`) is what tracks which category's
      // content the pane actually shows — `aria-selected` here doubles as
      // "currently holds the roving-tabindex focus", which the caret click
      // legitimately moves (see MUST-FIX 2's `onFocusRow` call) without
      // that meaning the category was selected/activated.
      expect(appearance.classList.contains("mounted")).toBe(false);
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();

      await expandCategory("Appearance");

      expect(appearance.getAttribute("aria-expanded")).toBe("true");
      // The caret must never select the category — General's content stays
      // mounted regardless of which row the click moved keyboard focus to.
      expect(appearance.classList.contains("mounted")).toBe(false);
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Theme" })).toBeNull();

      await fireEvent.click(screen.getByRole("button", { name: "Collapse Appearance" }));
      await flush();

      expect(appearance.getAttribute("aria-expanded")).toBe("false");
      expect(appearance.classList.contains("mounted")).toBe(false);
    });

    it("gives the caret its own accessible name reflecting the category and its current expansion state", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const caret = screen.getByRole("button", { name: "Expand Editor" });
      expect(caret.getAttribute("aria-expanded")).toBe("false");

      await fireEvent.click(caret);
      await flush();

      expect(screen.getByRole("button", { name: "Collapse Editor" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Expand Editor" })).toBeNull();
    });

    // Regression: onTreeKeydown used to read `data-row-id` directly off the
    // keydown event's own target. The caret button carries none, so a key
    // pressed while it holds focus (reachable via a real click in some
    // engines, or programmatically via assistive tech regardless) was
    // silently dropped — arrow-key expand/collapse went dead from that
    // point on, undercutting the whole reason the caret is kept out of the
    // Tab sequence.
    it("keeps arrow-key navigation working when the caret itself holds focus", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const caret = screen.getByRole("button", { name: "Expand General" });
      await fireEvent.click(caret);
      await flush();
      caret.focus();

      await fireEvent.keyDown(caret, { key: "ArrowDown" });
      await flush();

      const zoomRow = screen.getByRole("treeitem", { name: "Zoom" });
      expect(zoomRow.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(zoomRow);
    });

    // Regression: toggleCategory used to compute off `isExpanded`'s
    // search-forced value rather than the category's own stored one, so
    // clicking a caret while a search forced every category open wrote the
    // wrong collapsed/expanded value — invisible in the moment (every
    // category already reads expanded during a search) and only surfacing
    // once the query cleared.
    it("toggling a caret during an active search flips the category's real stored state, not the search-forced display", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      // Appearance has never been expanded — its stored state is false.
      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "a" } });
      await tick();

      // Forced open by the search, so the caret already reads "Collapse"
      // even though nothing has actually been stored yet.
      expect(screen.getByRole("button", { name: "Collapse Appearance" })).toBeTruthy();

      await fireEvent.click(screen.getByRole("button", { name: "Collapse Appearance" }));
      await flush();

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "" } });
      await tick();

      // The click toggled the real stored value (false -> true) rather
      // than writing the forced display value (which would have left it
      // collapsed).
      expect(screen.getByRole("treeitem", { name: "Appearance" }).getAttribute("aria-expanded")).toBe("true");
    });

    it("renders subcategory labels visibly smaller than master-category labels", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await expandCategory("General");

      const categoryRow = container.querySelector(".settings-nav-category");
      const sectionRow = container.querySelector(".settings-nav-section");
      expect(categoryRow).not.toBeNull();
      expect(sectionRow).not.toBeNull();

      const categorySize = parseFloat(getComputedStyle(categoryRow!).fontSize);
      const sectionSize = parseFloat(getComputedStyle(sectionRow!).fontSize);
      expect(sectionSize).toBeLessThan(categorySize);
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
      await fireEvent.keyDown(general, { key: "ArrowRight" });
      await flush();
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

      const restoreOnStartupRow = screen.getByRole("treeitem", { name: "Restore Tabs on Startup" });
      expect(restoreOnStartupRow.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(restoreOnStartupRow);
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();

      await fireEvent.keyDown(restoreOnStartupRow, { key: "ArrowDown" });
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
      await fireEvent.keyDown(general, { key: "ArrowRight" });
      await flush();
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

      // Every category starts collapsed, so the last *visible* row is the
      // last category itself (Terminal), not a section nested under it.
      const terminal = screen.getByRole("treeitem", { name: "Terminal" });
      expect(terminal.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(terminal);

      await fireEvent.keyDown(terminal, { key: "Home" });
      await flush();

      expect(general.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(general);
    });

    it("Left on an already-collapsed category row is a harmless no-op", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const appearance = screen.getByRole("treeitem", { name: "Appearance" });
      expect(appearance.getAttribute("aria-expanded")).toBe("false");

      await fireEvent.keyDown(appearance, { key: "ArrowLeft" });
      await flush();

      expect(appearance.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("treeitem", { name: "Theme" })).toBeNull();
    });

    // Right must exercise the expand path and Left must exercise the
    // collapse path against an *actually expanded* row — pressing Left
    // first, while still collapsed, would assert a value that was already
    // true and never touch the collapse branch at all (regression: this
    // test used to do exactly that, and the whole suite stayed green with
    // the collapse assignment deleted).
    it("Right expands a collapsed category to reveal its section row, Left collapses it again, neither changing the mounted category", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const appearance = screen.getByRole("treeitem", { name: "Appearance" });

      await fireEvent.keyDown(appearance, { key: "ArrowRight" });
      await flush();

      expect(appearance.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("treeitem", { name: "Theme" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();

      await fireEvent.keyDown(appearance, { key: "ArrowLeft" });
      await flush();

      expect(appearance.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("treeitem", { name: "Theme" })).toBeNull();
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();
    });

    it("Left on a focused section row moves focus to its parent category row", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const general = screen.getByRole("treeitem", { name: "General" });
      await fireEvent.keyDown(general, { key: "ArrowRight" });
      await flush();
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

      const appearance = screen.getByRole("treeitem", { name: "Appearance" });
      await fireEvent.keyDown(appearance, { key: "ArrowRight" });
      await flush();
      await fireEvent.keyDown(appearance, { key: "ArrowDown" });
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

      const appearance = screen.getByRole("treeitem", { name: "Appearance" });
      await fireEvent.keyDown(appearance, { key: "ArrowRight" });
      await flush();
      await fireEvent.keyDown(appearance, { key: "ArrowDown" });
      await flush();
      const themeRow = screen.getByRole("treeitem", { name: "Theme" });

      expect(screen.queryByRole("heading", { name: "Theme" })).toBeNull();
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();

      await fireEvent.keyDown(themeRow, { key: " " });
      await flush();

      expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });

    it("Enter on a focused category row selects it (switches the mounted category) without ever toggling its own expansion", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const appearance = screen.getByRole("treeitem", { name: "Appearance" });
      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();
      expect(appearance.getAttribute("aria-expanded")).toBe("false");

      await fireEvent.keyDown(appearance, { key: "Enter" });
      await flush();

      expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
      // Selecting must never also expand the row.
      expect(appearance.getAttribute("aria-expanded")).toBe("false");

      // Expand it via the caret's own keyboard path, then confirm Enter
      // still never touches expansion state — it doesn't collapse it either.
      await fireEvent.keyDown(appearance, { key: "ArrowRight" });
      await flush();
      expect(appearance.getAttribute("aria-expanded")).toBe("true");

      await fireEvent.keyDown(appearance, { key: "Enter" });
      await flush();
      expect(appearance.getAttribute("aria-expanded")).toBe("true");
    });

    it("falls the tabbable row back to the first visible row when a search unmounts the focused row, and arrow movement still works from there", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      const general = screen.getByRole("treeitem", { name: "General" });
      await fireEvent.keyDown(general, { key: "End" });
      await flush();
      const terminal = screen.getByRole("treeitem", { name: "Terminal" });
      expect(terminal.getAttribute("tabindex")).toBe("0");

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
      await expandCategory("Appearance");

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
      await expandCategory("Appearance");

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
      await expandCategory("General");

      const zoomRow = screen.getByRole("treeitem", { name: "Zoom" });
      await fireEvent.click(zoomRow);
      await flush();

      expect(screen.getByRole("heading", { name: "Zoom" })).toBeTruthy();
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });
  });

  describe("panel sizing", () => {
    it("sizes the panel to a fixed constant, clamped to the viewport on short windows", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();

      const panel = container.querySelector(".settings-panel") as HTMLElement;
      expect(getComputedStyle(panel).height).toBe("580px");
      expect(getComputedStyle(panel).maxHeight).toBe("80vh");
    });

    it("keeps a fixed panel height regardless of how much content a search narrows the panel to", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();

      const panel = container.querySelector(".settings-panel") as HTMLElement;
      const heightBefore = getComputedStyle(panel).height;

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "theme" } });
      await tick();

      expect(getComputedStyle(panel).height).toBe(heightBefore);
    });

    // This is a structural check, not a visual regression guard: jsdom performs
    // no layout, so the computed height is category-independent by construction.
    // What it actually guards against is a category-conditional code path that
    // starts writing an inline height or swapping a sizing class onto the panel.
    // The real visual invariance (no jitter, no unwanted scrollbar) can only be
    // observed in the running app.
    it("keeps a fixed panel height across every category", async () => {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();

      const panel = container.querySelector(".settings-panel") as HTMLElement;
      const heightBefore = getComputedStyle(panel).height;

      for (const name of ["General", "Appearance", "Editor", "Markdown", "Terminal"]) {
        await selectCategory(name);
        expect(getComputedStyle(panel).height).toBe(heightBefore);
      }
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
    // Targeted by accessible name, not the shared `dropdownTrigger(container)`
    // helper: Markdown now has two dropdowns (Default View, Max Width), and
    // that helper selects the first `.dropdown-trigger` in DOM order, which
    // only stays this one because of section ordering elsewhere.
    async function openMarkdownViewDropdown(): Promise<HTMLElement> {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await selectCategory("Markdown");
      await fireEvent.click(screen.getByLabelText("Default view for markdown files"));
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

  describe("markdown max width", () => {
    // Markdown is the first category with two dropdowns (Default View, Max
    // Width), so the shared `dropdownTrigger(container)` helper — which
    // selects the first `.dropdown-trigger` in DOM order — would open
    // Default View instead. The trigger's accessible name (`Dropdown.svelte`
    // puts its `label` prop on as `aria-label`) selects the right one
    // regardless of DOM position.
    async function openMaxWidthDropdown(): Promise<void> {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Markdown");
      await fireEvent.click(screen.getByLabelText("Max width of rendered markdown"));
      await flush();
    }

    it("marks the current preset as selected", async () => {
      proseWidth.set(120);
      await openMaxWidthDropdown();

      expect(screen.getByRole("option", { name: "80ch" }).getAttribute("aria-selected")).toBe("false");
      expect(screen.getByRole("option", { name: "120ch" }).getAttribute("aria-selected")).toBe("true");
    });

    it("clicking a preset updates the shared proseWidth store and closes the dropdown", async () => {
      await openMaxWidthDropdown();

      await fireEvent.click(screen.getByRole("option", { name: "100ch" }));
      await flush();

      expect(get(proseWidth)).toBe(100);
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("clicking Full updates the shared proseWidth store to the \"full\" sentinel", async () => {
      await openMaxWidthDropdown();

      await fireEvent.click(screen.getByRole("option", { name: "Full" }));
      await flush();

      expect(get(proseWidth)).toBe("full");
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

  describe("restore tabs on startup", () => {
    it("shows the checkbox checked by default (on by default)", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("General");

      expect(screen.getByLabelText("Restore previously open tabs on startup")).toHaveProperty("checked", true);
    });

    it("unchecking the toggle turns the setting off, reflected in the shared store", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("General");

      await fireEvent.click(screen.getByLabelText("Restore previously open tabs on startup"));
      await flush();

      expect(get(restoreTabsOnStartup)).toBe(false);
      expect(screen.getByLabelText("Restore previously open tabs on startup")).toHaveProperty("checked", false);
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

  describe("word wrap", () => {
    it("shows the checkbox unchecked by default (off by default, preserving current code-pane behavior)", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      expect(screen.getByLabelText("Wrap long lines")).toHaveProperty("checked", false);
    });

    it("checking the toggle turns the setting on, reflected in the shared store", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      await fireEvent.click(screen.getByLabelText("Wrap long lines"));
      await flush();

      expect(get(wordWrapEnabled)).toBe(true);
      expect(screen.getByLabelText("Wrap long lines")).toHaveProperty("checked", true);
    });
  });

  describe("tab size", () => {
    async function openTabSizeDropdown(): Promise<HTMLElement> {
      settingsOverlay.set({ open: true });
      const { container } = render(SettingsDialog);
      await tick();
      await selectCategory("Editor");
      await fireEvent.click(dropdownTrigger(container));
      await flush();
      return container;
    }

    it("marks the current tab size as selected", async () => {
      tabSize.set(4);
      await openTabSizeDropdown();

      expect(screen.getByRole("option", { name: "2" }).getAttribute("aria-selected")).toBe("false");
      expect(screen.getByRole("option", { name: "4" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("option", { name: "8" }).getAttribute("aria-selected")).toBe("false");
    });

    it("clicking a size option updates the shared tabSize store and closes the dropdown", async () => {
      await openTabSizeDropdown();

      await fireEvent.click(screen.getByRole("option", { name: "8" }));
      await flush();

      expect(get(tabSize)).toBe(8);
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });

  describe("line numbers", () => {
    it("shows the checkbox checked by default (on by default)", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      expect(screen.getByLabelText("Show line numbers")).toHaveProperty("checked", true);
    });

    it("unchecking the toggle turns the setting off, reflected in the shared store", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      await fireEvent.click(screen.getByLabelText("Show line numbers"));
      await flush();

      expect(get(lineNumbersEnabled)).toBe(false);
      expect(screen.getByLabelText("Show line numbers")).toHaveProperty("checked", false);
    });
  });

  describe("auto save", () => {
    it("shows the checkbox unchecked by default (off by default, preserving current always-manual-save behavior)", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      expect(screen.getByLabelText("Automatically save changes")).toHaveProperty("checked", false);
    });

    it("checking the toggle turns the setting on, reflected in the shared store", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();
      await selectCategory("Editor");

      await fireEvent.click(screen.getByLabelText("Automatically save changes"));
      await flush();

      expect(get(autoSaveEnabled)).toBe(true);
      expect(screen.getByLabelText("Automatically save changes")).toHaveProperty("checked", true);
    });
  });

  describe("search: new settings are findable", () => {
    it("finds Word Wrap by keyword", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "wrap" } });
      await tick();

      expect(screen.getByRole("heading", { name: "Word Wrap" })).toBeTruthy();
    });

    it("finds Auto Save by the 'autosave' synonym", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "autosave" } });
      await tick();

      expect(screen.getByRole("heading", { name: "Auto Save" })).toBeTruthy();
    });

    it("finds Restore Tabs on Startup by the 'reopen' synonym", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "reopen" } });
      await tick();

      expect(screen.getByRole("heading", { name: "Restore Tabs on Startup" })).toBeTruthy();
    });

    it("finds Max Width by the 'line length' synonym", async () => {
      settingsOverlay.set({ open: true });
      render(SettingsDialog);
      await tick();

      await fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "line length" } });
      await tick();

      expect(screen.getByRole("heading", { name: "Max Width" })).toBeTruthy();
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
