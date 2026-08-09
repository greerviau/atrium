import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import StandaloneFileList from "../../src/lib/explorer/StandaloneFileList.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { standaloneWorkspaceId, localWorkspaceId } from "../../src/lib/ipc/commands";
import * as commands from "../../src/lib/ipc/commands";
import * as reveal from "../../src/lib/ipc/reveal";

// The single-file-workspace explorer (issue #325's cold-launch plan, §7.2,
// §9.3 tests 9-11 and 17): a flat listing of exactly the standalone tabs
// already open, never a directory tree — this component has no root to
// list from and must never ask for one.
vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
  standaloneWorkspaceId: () => "standalone",
  localWorkspaceId: () => "local",
}));

vi.mock("../../src/lib/ipc/reveal", () => ({
  revealInFinder: vi.fn(),
}));

function standaloneTab(path: string): Tab {
  return {
    path,
    workspaceId: standaloneWorkspaceId(),
    mode: "code",
    savedDoc: "",
    isDirty: false,
    hasExternalConflict: false,
    isExternal: true,
    isDeleted: false,
  };
}

function rowFor(container: HTMLElement, path: string): HTMLElement {
  const row = container.querySelector(`.row[data-path="${path}"]`);
  if (!row) throw new Error(`no row for ${path}`);
  return row as HTMLElement;
}

function tabbableRow(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.row[tabindex="0"]');
}

function activeTabPath(): string | null {
  let active: string | null = null;
  tabsState.subscribe((s) => (active = s.activeTabPath))();
  return active;
}

const NOTE = "/tmp/note.md";
const OTHER = "/tmp/dir/other.md";

describe("StandaloneFileList (issue #325)", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
    vi.mocked(reveal.revealInFinder).mockReset().mockResolvedValue(undefined);
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  afterEach(() => {
    cleanup();
  });

  // Test 9/10 (§9.3) — exactly the standalone tab(s), by basename, and
  // never a call to `fsListDir`: the negative assertion that would catch a
  // future "just reuse FileTree/fs_list_dir" regression on this component.
  it("lists exactly the open standalone tabs and never calls fsListDir", () => {
    tabsState.set({ tabs: [standaloneTab(NOTE)], activeTabPath: NOTE });
    const { getByText, queryByText } = render(StandaloneFileList);

    expect(getByText("note.md")).toBeTruthy();
    expect(queryByText("dir")).toBeNull();
    expect(commands.fsListDir).not.toHaveBeenCalled();
  });

  // Test 11 (§9.3) — two standalone files list both, with neither the
  // parent directory nor a sibling ever appearing, since nothing here is
  // ever read off disk.
  it("lists both files when two are open standalone, with no parent or sibling rows", () => {
    tabsState.set({
      tabs: [standaloneTab(NOTE), standaloneTab(OTHER)],
      activeTabPath: NOTE,
    });
    const { container, getByText, queryByText } = render(StandaloneFileList);

    expect(getByText("note.md")).toBeTruthy();
    expect(getByText("other.md")).toBeTruthy();
    expect(queryByText("tmp")).toBeNull();
    expect(queryByText("dir")).toBeNull();
    expect(container.querySelectorAll(".row")).toHaveLength(2);
    expect(commands.fsListDir).not.toHaveBeenCalled();
  });

  // A local (project) tab is never mistaken for a standalone one, even if
  // both happen to be open at the same time (e.g. right after a folder is
  // opened from standalone mode).
  it("excludes a local-workspace tab from the list", () => {
    tabsState.set({
      tabs: [standaloneTab(NOTE), { ...standaloneTab(OTHER), workspaceId: localWorkspaceId() }],
      activeTabPath: NOTE,
    });
    const { queryByText } = render(StandaloneFileList);

    expect(queryByText("note.md")).toBeTruthy();
    expect(queryByText("other.md")).toBeNull();
  });

  // Clicking a row activates that tab (sets it as the active tab); no
  // `fs_list_dir`/`fs_read_file` round trip is needed since the tab is
  // already open.
  it("clicking a row activates that tab", async () => {
    tabsState.set({
      tabs: [standaloneTab(NOTE), standaloneTab(OTHER)],
      activeTabPath: NOTE,
    });
    const { container } = render(StandaloneFileList);

    await fireEvent.click(rowFor(container, OTHER));

    expect(activeTabPath()).toBe(OTHER);
  });

  it("shift-click selects the contiguous row range without activating the target", async () => {
    const third = "/tmp/third.md";
    tabsState.set({
      tabs: [standaloneTab(NOTE), standaloneTab(OTHER), standaloneTab(third)],
      activeTabPath: NOTE,
    });
    const { container } = render(StandaloneFileList);

    await fireEvent.click(rowFor(container, NOTE));
    await fireEvent.click(rowFor(container, third), { shiftKey: true });

    expect(container.querySelector('[role="tree"]')?.getAttribute("aria-multiselectable")).toBe("true");
    expect(rowFor(container, NOTE).getAttribute("aria-selected")).toBe("true");
    expect(rowFor(container, OTHER).getAttribute("aria-selected")).toBe("true");
    expect(rowFor(container, third).getAttribute("aria-selected")).toBe("true");
    expect(activeTabPath()).toBe(NOTE);

    await fireEvent.click(rowFor(container, OTHER));

    expect(rowFor(container, NOTE).getAttribute("aria-selected")).toBe("false");
    expect(rowFor(container, OTHER).getAttribute("aria-selected")).toBe("true");
    expect(rowFor(container, third).getAttribute("aria-selected")).toBe("false");
    expect(activeTabPath()).toBe(OTHER);
  });

  // Test 17 (§9.3) — keyboard/ARIA parity with the single-level subset of
  // FileTree's own semantics (#333): role="tree"/"treeitem", roving
  // tabindex starting at the first row, Up/Down/Home/End movement, no
  // expand/collapse (there is nothing to expand).
  it("exposes tree/treeitem roles with a roving tabindex, moved by ArrowDown/ArrowUp/Home/End", async () => {
    const third = "/tmp/third.md";
    tabsState.set({
      tabs: [standaloneTab(NOTE), standaloneTab(OTHER), standaloneTab(third)],
      activeTabPath: NOTE,
    });
    const { container } = render(StandaloneFileList);

    expect(container.querySelector('[role="tree"]')).toBeTruthy();
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
    expect(tabbableRow(container)).toBe(rowFor(container, NOTE));

    await fireEvent.keyDown(rowFor(container, NOTE), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, OTHER)));

    await fireEvent.keyDown(rowFor(container, OTHER), { key: "End" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, third)));

    await fireEvent.keyDown(rowFor(container, third), { key: "Home" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, NOTE)));

    await fireEvent.keyDown(rowFor(container, NOTE), { key: "ArrowUp" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, NOTE)));
  });

  it("Enter activates the focused row", async () => {
    tabsState.set({
      tabs: [standaloneTab(NOTE), standaloneTab(OTHER)],
      activeTabPath: NOTE,
    });
    const { container } = render(StandaloneFileList);

    await fireEvent.keyDown(rowFor(container, NOTE), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, OTHER)));
    await fireEvent.keyDown(rowFor(container, OTHER), { key: "Enter" });

    expect(activeTabPath()).toBe(OTHER);
  });

  // Reveal in Finder is the one context-menu action offered — it takes a
  // single path and needs no containing directory, unlike New/Rename/Delete
  // (each a hard rejection on `StandaloneWorkspace`, so none are offered).
  it("right-click offers Reveal in Finder, which calls revealInFinder with that row's path", async () => {
    tabsState.set({ tabs: [standaloneTab(NOTE)], activeTabPath: NOTE });
    const { container, getByRole } = render(StandaloneFileList);

    await fireEvent.contextMenu(rowFor(container, NOTE));
    const item = getByRole("menuitem", { name: "Reveal in Finder" });
    await fireEvent.click(item);

    expect(reveal.revealInFinder).toHaveBeenCalledWith(NOTE);
  });

  // Issue #400: the open file is highlighted here too, and moving keyboard
  // focus without activating a tab (unlike a click, which always activates)
  // must not leave a second, stale fill behind.
  describe("highlights the currently open file (issue #400)", () => {
    /** The only two markers that produce a visible fill per this component's own CSS. */
    function hasFill(row: HTMLElement): boolean {
      return row.classList.contains("range-selected") || row.getAttribute("aria-current") === "true";
    }

    function filledPaths(container: HTMLElement): string[] {
      return Array.from(container.querySelectorAll<HTMLElement>(".row[data-path]"))
        .filter(hasFill)
        .map((row) => row.dataset.path!);
    }

    it("highlights exactly the active tab's row, and moves with it", async () => {
      tabsState.set({
        tabs: [standaloneTab(NOTE), standaloneTab(OTHER)],
        activeTabPath: NOTE,
      });
      const { container } = render(StandaloneFileList);

      expect(filledPaths(container)).toEqual([NOTE]);

      tabsState.update((s) => ({ ...s, activeTabPath: OTHER }));
      await Promise.resolve();

      expect(filledPaths(container)).toEqual([OTHER]);
    });

    it("moving keyboard focus without activating a tab does not paint a second fill", async () => {
      tabsState.set({
        tabs: [standaloneTab(NOTE), standaloneTab(OTHER)],
        activeTabPath: NOTE,
      });
      const { container } = render(StandaloneFileList);

      await fireEvent.keyDown(rowFor(container, NOTE), { key: "ArrowDown" });
      await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, OTHER)));

      // Focus moved to "other.md" (it's now the roving-tabindex row and
      // `aria-selected`), but activating it requires Enter/Space/click —
      // arrow navigation alone must not activate it, so the fill stays on
      // the still-open "note.md".
      expect(activeTabPath()).toBe(NOTE);
      expect(rowFor(container, OTHER).getAttribute("aria-selected")).toBe("true");
      expect(filledPaths(container)).toEqual([NOTE]);
    });

    it("shows a fill on every row of a genuine multi-row range selection, including the open file itself", async () => {
      const third = "/tmp/third.md";
      tabsState.set({
        tabs: [standaloneTab(NOTE), standaloneTab(OTHER), standaloneTab(third)],
        activeTabPath: NOTE,
      });
      const { container } = render(StandaloneFileList);

      await fireEvent.click(rowFor(container, NOTE));
      await fireEvent.click(rowFor(container, third), { shiftKey: true });

      expect(rowFor(container, NOTE).classList.contains("range-selected")).toBe(true);
      expect(rowFor(container, NOTE).getAttribute("aria-current")).toBe("true");
      expect(rowFor(container, OTHER).classList.contains("range-selected")).toBe(true);
      expect(rowFor(container, third).classList.contains("range-selected")).toBe(true);
      expect(filledPaths(container).sort()).toEqual([NOTE, OTHER, third].sort());
    });
  });
});
