import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, fireEvent, cleanup, screen } from "@testing-library/svelte";
import StatusBar from "../../src/lib/shell/StatusBar.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { cursorPosition } from "../../src/lib/stores/editorStatus";
import { explorerVisible, terminalVisible } from "../../src/lib/stores/layout";

vi.mock("../../src/lib/stores/layout", async () => {
  const { writable } = await import("svelte/store");
  const explorerVisible = writable(true);
  const terminalVisible = writable(true);
  return {
    explorerVisible,
    terminalVisible,
    toggleExplorerVisible: vi.fn(() => explorerVisible.update((v) => !v)),
    toggleTerminalVisible: vi.fn(() => terminalVisible.update((v) => !v)),
  };
});

vi.mock("../../src/lib/search/searchOverlay", async () => {
  const { writable } = await import("svelte/store");
  return {
    searchOverlay: writable({ open: false }),
    openSearch: vi.fn(),
  };
});

vi.mock("../../src/lib/stores/settingsOverlay", async () => {
  const { writable } = await import("svelte/store");
  return {
    settingsOverlay: writable({ open: false }),
    openSettings: vi.fn(),
  };
});

const ACTIVE_TAB: Tab = {
  path: "/proj/src/app.ts",
  mode: "code",
  savedDoc: "",
  isDirty: false,
  hasExternalConflict: false,
};

describe("StatusBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.set({ id: "local", root: "/proj" });
    tabsState.set({ tabs: [], activeTabPath: null });
    cursorPosition.set(null);
    explorerVisible.set(true);
    terminalVisible.set(true);
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll(".atrium-tooltip").forEach((el) => el.remove());
  });

  it("does not render at all with no workspace open", () => {
    workspace.set({ id: "local", root: null });
    const { container } = render(StatusBar);

    expect(container.querySelector(".status-bar")).toBeNull();
  });

  it("renders an empty right group with no tabs open", () => {
    const { container } = render(StatusBar);

    expect(container.querySelector(".status-bar")).not.toBeNull();
    expect(container.querySelector(".indicators")).toBeNull();
  });

  it("renders the workspace-relative path, cursor position, and language label for the active tab", async () => {
    tabsState.set({ tabs: [ACTIVE_TAB], activeTabPath: ACTIVE_TAB.path });
    cursorPosition.set({ line: 4, col: 9, selection: null });
    render(StatusBar);
    await tick();

    expect(screen.getByText("TypeScript")).toBeTruthy();
    expect(screen.getByText("Ln 4, Col 9")).toBeTruthy();
    expect(screen.getByText("src/app.ts")).toBeTruthy();
  });

  it("updates when tabsState/cursorPosition change", async () => {
    render(StatusBar);
    tabsState.set({ tabs: [ACTIVE_TAB], activeTabPath: ACTIVE_TAB.path });
    cursorPosition.set({ line: 1, col: 1, selection: null });
    await tick();

    expect(screen.getByText("Ln 1, Col 1")).toBeTruthy();

    cursorPosition.set({ line: 2, col: 3, selection: null });
    await tick();

    expect(screen.getByText("Ln 2, Col 3")).toBeTruthy();
  });

  it("shows a single-line selection's extent", async () => {
    tabsState.set({ tabs: [ACTIVE_TAB], activeTabPath: ACTIVE_TAB.path });
    cursorPosition.set({ line: 4, col: 9, selection: { lines: 1, chars: 5 } });
    render(StatusBar);
    await tick();

    expect(screen.getByText("Ln 4, Col 9 (5 selected)")).toBeTruthy();
  });

  it("shows a multi-line selection's extent", async () => {
    tabsState.set({ tabs: [ACTIVE_TAB], activeTabPath: ACTIVE_TAB.path });
    cursorPosition.set({ line: 6, col: 1, selection: { lines: 3, chars: 40 } });
    render(StatusBar);
    await tick();

    expect(screen.getByText("Ln 6, Col 1 (3 lines, 40 selected)")).toBeTruthy();
  });

  it("clicking the search button calls openSearch with no arguments (content mode), not the click MouseEvent", async () => {
    const { openSearch } = await import("../../src/lib/search/searchOverlay");
    render(StatusBar);

    await fireEvent.click(screen.getByLabelText("Search (⌘⇧F)"));

    // Regression test for the `onclick={openSearch}` bare-reference bug:
    // a bare reference forwards the native MouseEvent as `openSearch`'s
    // first argument, which is neither "content" nor "files" and would
    // fail to typecheck as `SearchMode`. `onclick={() => openSearch()}`
    // must call it with zero arguments so the default ("content") applies.
    expect(openSearch).toHaveBeenCalledOnce();
    expect(openSearch).toHaveBeenCalledWith();
  });

  it("clicking the settings button calls openSettings", async () => {
    const { openSettings } = await import("../../src/lib/stores/settingsOverlay");
    render(StatusBar);

    await fireEvent.click(screen.getByLabelText("Settings (⌘,)"));

    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("clicking the explorer toggle calls toggleExplorerVisible and reflects aria-pressed from explorerVisible", async () => {
    const { toggleExplorerVisible } = await import("../../src/lib/stores/layout");
    render(StatusBar);

    const button = screen.getByLabelText("Toggle Explorer (⌘B)");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    await fireEvent.click(button);

    expect(toggleExplorerVisible).toHaveBeenCalledOnce();
  });

  it("clicking the terminal toggle calls toggleTerminalVisible and reflects aria-pressed from terminalVisible", async () => {
    terminalVisible.set(false);
    const { toggleTerminalVisible } = await import("../../src/lib/stores/layout");
    render(StatusBar);

    const button = screen.getByLabelText("Toggle Terminal (⌘R)");
    expect(button.getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(button);

    expect(toggleTerminalVisible).toHaveBeenCalledOnce();
  });

  it("none of the action buttons carry a native title attribute", () => {
    const { container } = render(StatusBar);

    const buttons = container.querySelectorAll(".status-group.actions .status-btn");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.hasAttribute("title")).toBe(false);
    }
  });

  it("shows an Atrium-styled tooltip with the Mac glyph, not Cmd/Ctrl text, on hover", async () => {
    vi.useFakeTimers();
    render(StatusBar);

    const button = screen.getByLabelText("Toggle Explorer (⌘B)");
    await fireEvent.mouseEnter(button);
    vi.advanceTimersByTime(400);

    const tooltipEl = document.querySelector(".atrium-tooltip");
    expect(tooltipEl).not.toBeNull();
    expect(tooltipEl!.textContent).toContain("Toggle Explorer");
    expect(tooltipEl!.textContent).toContain("⌘B");
    expect(tooltipEl!.textContent).not.toMatch(/Cmd|Ctrl/);

    vi.useRealTimers();
  });

  it("renders all four action-button icons as SVGs with matching width/height", () => {
    const { container } = render(StatusBar);

    const icons = container.querySelectorAll(".status-group.actions .status-btn svg");
    expect(icons).toHaveLength(4);

    const sizes = Array.from(icons).map((svg) => ({
      width: svg.getAttribute("width"),
      height: svg.getAttribute("height"),
    }));

    for (const size of sizes.slice(1)) {
      expect(size).toEqual(sizes[0]);
    }
    expect(sizes[0].width).toBeTruthy();
    expect(sizes[0].width).toBe(sizes[0].height);
  });
});
