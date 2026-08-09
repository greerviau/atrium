import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { loadRoot, collapse } from "../../src/lib/stores/fileTree";
import { tabsState, markDirty, type Tab } from "../../src/lib/stores/tabs";
import * as commands from "../../src/lib/ipc/commands";

// Issue #400: the file open in the editor should be the one highlighted in
// the explorer, and only that one — no fill anywhere when no file is open,
// and the fill must follow `tabsState.activeTabPath` regardless of how it
// changed (a tab-strip switch, a restored session, a markdown/terminal
// link), not just an explorer click.
vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
  fsReadFile: vi.fn(),
  fsCreateFile: vi.fn(),
  fsCreateDir: vi.fn(),
  fsRename: vi.fn(),
  fsDelete: vi.fn(),
  localWorkspaceId: () => "local",
  isAppError: (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value && "message" in value,
}));

const ROOT = "/workspace";
const SRC = `${ROOT}/src`;
const INDEX_TS = `${ROOT}/src/index.ts`;
const A_TXT = `${ROOT}/a.txt`;
const B_TXT = `${ROOT}/b.txt`;

function localTab(path: string): Tab {
  return {
    path,
    workspaceId: commands.localWorkspaceId(),
    mode: "code",
    savedDoc: "",
    isDirty: false,
    hasExternalConflict: false,
    isDeleted: false,
    isExternal: false,
  };
}

function rowFor(container: HTMLElement, path: string): HTMLElement {
  const row = container.querySelector(`.row[data-path="${path}"]`);
  if (!row) throw new Error(`no row for ${path}`);
  return row as HTMLElement;
}

/** The only two markers that produce a visible fill per FileTreeNode.svelte's own CSS. */
function hasFill(row: HTMLElement): boolean {
  return row.classList.contains("range-selected") || row.getAttribute("aria-current") === "true";
}

function filledPaths(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".row[data-path]"))
    .filter(hasFill)
    .map((row) => row.dataset.path!);
}

/** Settles any pending expand-to-path/scroll work started by the effect (`FileTree.svelte`'s `$effect`), mirroring the repeated `await tick()` idiom other suites use after an async action (e.g. `App.renameReconciliation.test.ts`). */
async function flushAsync(): Promise<void> {
  await tick();
  await tick();
  await tick();
}

async function renderTree() {
  vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
    if (path === ROOT) {
      return [
        { name: "src", path: SRC, isDir: true, isSymlink: false },
        { name: "a.txt", path: A_TXT, isDir: false, isSymlink: false },
        { name: "b.txt", path: B_TXT, isDir: false, isSymlink: false },
      ];
    }
    if (path === SRC) {
      return [{ name: "index.ts", path: INDEX_TS, isDir: false, isSymlink: false }];
    }
    return [];
  });
  await loadRoot(ROOT);
  const result = render(FileTree);
  await result.findByText("a.txt");
  return result;
}

describe("FileTree: highlights the currently open file (issue #400)", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
    Element.prototype.scrollIntoView = vi.fn();
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("highlights no row when no file is ever opened", async () => {
    const { container } = await renderTree();
    await flushAsync();

    expect(filledPaths(container)).toEqual([]);
  });

  it("highlights no row once the only open tab is closed", async () => {
    tabsState.set({ tabs: [localTab(A_TXT)], activeTabPath: A_TXT });
    const { container } = await renderTree();
    await flushAsync();
    expect(filledPaths(container)).toEqual([A_TXT]);

    tabsState.set({ tabs: [], activeTabPath: null });
    await flushAsync();

    expect(filledPaths(container)).toEqual([]);
  });

  it("highlights exactly the open file's row, and moves the highlight when the active tab changes directly (a tab-strip switch, not an explorer click)", async () => {
    tabsState.set({
      tabs: [localTab(A_TXT), localTab(B_TXT)],
      activeTabPath: A_TXT,
    });
    const { container } = await renderTree();
    await flushAsync();
    expect(filledPaths(container)).toEqual([A_TXT]);

    tabsState.update((s) => ({ ...s, activeTabPath: B_TXT }));
    await flushAsync();

    expect(filledPaths(container)).toEqual([B_TXT]);
  });

  it("leaves the open-file highlight in place when a different row is clicked to browse (aria-selected moves, the fill does not)", async () => {
    tabsState.set({ tabs: [localTab(A_TXT)], activeTabPath: A_TXT });
    const { container } = await renderTree();
    await flushAsync();

    // Click the (initially collapsed) "src" directory row — selects and
    // expands it, but does not open anything, so the fill must stay on
    // a.txt. (Clicking the already-expanded root row instead would collapse
    // it via the same click handler, hiding a.txt entirely — not what this
    // test means by "browse".)
    await fireEvent.click(rowFor(container, SRC));

    expect(rowFor(container, SRC).getAttribute("aria-selected")).toBe("true");
    expect(rowFor(container, A_TXT).getAttribute("aria-selected")).toBe("false");
    expect(filledPaths(container)).toEqual([A_TXT]);
  });

  it("expands a collapsed ancestor directory and scrolls to the open file's row", async () => {
    tabsState.set({ tabs: [localTab(INDEX_TS)], activeTabPath: INDEX_TS });
    const { container } = await renderTree();

    // The expand-and-scroll chain is asynchronous (an `fsListDir` round trip
    // plus a `tick()`), so wait for its true end condition — the scroll
    // call — rather than the row's existence alone, which can settle one or
    // more microtask hops earlier.
    await vi.waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());

    expect(rowFor(container, SRC).getAttribute("aria-expanded")).toBe("true");
    expect(rowFor(container, INDEX_TS).getAttribute("aria-current")).toBe("true");
  });

  it("does not re-expand a directory the user just collapsed while its file stays open", async () => {
    tabsState.set({ tabs: [localTab(INDEX_TS)], activeTabPath: INDEX_TS });
    const { container } = await renderTree();
    await vi.waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(rowFor(container, SRC).getAttribute("aria-expanded")).toBe("true");

    collapse(SRC);
    await flushAsync();

    expect(rowFor(container, SRC).getAttribute("aria-expanded")).toBe("false");
  });

  it("does not re-run scrollIntoView for a tabsState write that leaves activeTabPath unchanged", async () => {
    tabsState.set({ tabs: [localTab(INDEX_TS)], activeTabPath: INDEX_TS });
    await renderTree();
    await vi.waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    const callsAfterInitialReveal = vi.mocked(Element.prototype.scrollIntoView).mock.calls.length;

    markDirty(INDEX_TS);
    await flushAsync();

    expect(vi.mocked(Element.prototype.scrollIntoView).mock.calls.length).toBe(callsAfterInitialReveal);
  });

  it("shows a fill on every row of a genuine multi-row range selection, including the open file itself", async () => {
    tabsState.set({ tabs: [localTab(A_TXT)], activeTabPath: A_TXT });
    const { container } = await renderTree();
    await flushAsync();

    // a.txt is already the open file; shift-clicking b.txt right after
    // extends the (adjacent, top-level) selection to cover both rows.
    await fireEvent.click(rowFor(container, A_TXT));
    await fireEvent.click(rowFor(container, B_TXT), { shiftKey: true });

    expect(rowFor(container, A_TXT).classList.contains("range-selected")).toBe(true);
    expect(rowFor(container, A_TXT).getAttribute("aria-current")).toBe("true");
    expect(rowFor(container, B_TXT).classList.contains("range-selected")).toBe(true);
    expect(filledPaths(container).sort()).toEqual([A_TXT, B_TXT].sort());
  });

  // Round-2 implementation review: activeTabPath is not guaranteed to be in
  // the same separator form as a tree node's own (native) entry.path — e.g.
  // a markdown link's relative-path resolution normalizes backslashes to
  // "/". Pins both halves: the row still gets highlighted, and the reveal
  // effect still scrolls to it, despite the mismatch.
  it("highlights and scrolls to the open file even when activeTabPath uses different path separators than the tree's own node paths", async () => {
    const winRoot = "C:\\ws";
    const winSrc = "C:\\ws\\src";
    const winIndex = "C:\\ws\\src\\index.ts";
    vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
      if (path === winRoot) return [{ name: "src", path: winSrc, isDir: true, isSymlink: false }];
      if (path === winSrc) return [{ name: "index.ts", path: winIndex, isDir: false, isSymlink: false }];
      return [];
    });
    await loadRoot(winRoot);
    // A backslashed data-path breaks a naive `[data-path="..."]` CSS
    // selector (backslash is a CSS escape character), so this test — unlike
    // `rowFor` above — filters `querySelectorAll` results on `.dataset.path`
    // in JS instead of embedding the path in the selector string.
    tabsState.set({ tabs: [localTab("C:/ws/src/index.ts")], activeTabPath: "C:/ws/src/index.ts" });
    const { container } = render(FileTree);
    await vi.waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());

    const indexRow = Array.from(container.querySelectorAll<HTMLElement>(".row[data-path]")).find(
      (row) => row.dataset.path === winIndex,
    );
    expect(indexRow).toBeTruthy();
    expect(indexRow?.getAttribute("aria-current")).toBe("true");
  });
});
