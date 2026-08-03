import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { loadRoot, loadChildren } from "../../src/lib/stores/fileTree";
import * as commands from "../../src/lib/ipc/commands";

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

function rowFor(container: HTMLElement, path: string): HTMLElement {
  const row = container.querySelector(`.row[data-path="${path}"]`);
  if (!row) throw new Error(`no row for ${path}`);
  return row as HTMLElement;
}

function groupFor(container: HTMLElement, path: string): HTMLElement | null {
  return rowFor(container, path).parentElement?.querySelector(':scope > [role="group"]') ?? null;
}

function tabbableRow(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.row[tabindex="0"]');
}

async function renderTree() {
  vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
    if (path === ROOT) {
      return [
        { name: "src", path: SRC, isDir: true, isSymlink: false },
        { name: "a.txt", path: A_TXT, isDir: false, isSymlink: false },
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

describe("FileTree: keyboard navigation and ARIA tree semantics (issue #266)", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps exactly one row at tabindex=0, starting at the root, and moves it with ArrowDown/ArrowUp/Home/End", async () => {
    const { container } = await renderTree();

    expect(tabbableRow(container)).toBe(rowFor(container, ROOT));

    await fireEvent.keyDown(rowFor(container, ROOT), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, SRC)));
    expect(document.activeElement).toBe(rowFor(container, SRC));

    await fireEvent.keyDown(rowFor(container, SRC), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, A_TXT)));

    // Clamped at the end: a further ArrowDown stays put.
    await fireEvent.keyDown(rowFor(container, A_TXT), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, A_TXT)));

    await fireEvent.keyDown(rowFor(container, A_TXT), { key: "ArrowUp" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, SRC)));

    await fireEvent.keyDown(rowFor(container, SRC), { key: "End" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, A_TXT)));
    expect(document.activeElement).toBe(rowFor(container, A_TXT));

    await fireEvent.keyDown(rowFor(container, A_TXT), { key: "Home" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, ROOT)));
    expect(document.activeElement).toBe(rowFor(container, ROOT));

    expect(container.querySelectorAll('.row[tabindex="0"]')).toHaveLength(1);
  });

  it("ArrowRight expands a closed directory without moving focus, then a second ArrowRight moves focus into its first child", async () => {
    const { container } = await renderTree();
    await fireEvent.keyDown(rowFor(container, ROOT), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, SRC)));

    expect(container.querySelector(`.row[data-path="${INDEX_TS}"]`)).toBeNull();

    await fireEvent.keyDown(rowFor(container, SRC), { key: "ArrowRight" });
    await vi.waitFor(() => expect(container.querySelector(`.row[data-path="${INDEX_TS}"]`)).toBeTruthy());
    expect(tabbableRow(container)).toBe(rowFor(container, SRC));

    await fireEvent.keyDown(rowFor(container, SRC), { key: "ArrowRight" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, INDEX_TS)));
    expect(document.activeElement).toBe(rowFor(container, INDEX_TS));
  });

  it("ArrowRight is a no-op on a file", async () => {
    const { container } = await renderTree();
    await fireEvent.keyDown(rowFor(container, ROOT), { key: "ArrowDown" });
    await fireEvent.keyDown(rowFor(container, SRC), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, A_TXT)));

    await fireEvent.keyDown(rowFor(container, A_TXT), { key: "ArrowRight" });
    expect(tabbableRow(container)).toBe(rowFor(container, A_TXT));
  });

  it("ArrowRight on an already-open but empty directory does not move focus to the next sibling", async () => {
    vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
      if (path === ROOT) {
        return [
          { name: "empty", path: `${ROOT}/empty`, isDir: true, isSymlink: false },
          { name: "src", path: SRC, isDir: true, isSymlink: false },
        ];
      }
      if (path === `${ROOT}/empty`) return [];
      if (path === SRC) return [{ name: "index.ts", path: INDEX_TS, isDir: false, isSymlink: false }];
      return [];
    });
    await loadRoot(ROOT);
    const { container } = render(FileTree);
    await vi.waitFor(() => expect(container.querySelector(`.row[data-path="${ROOT}/empty"]`)).toBeTruthy());

    const emptyPath = `${ROOT}/empty`;
    rowFor(container, emptyPath).focus();
    await fireEvent.keyDown(rowFor(container, emptyPath), { key: "ArrowRight" });
    await vi.waitFor(() =>
      expect(rowFor(container, emptyPath).getAttribute("aria-expanded")).toBe("true"),
    );

    // A second ArrowRight, now that the directory is open but has no
    // children, must stay put rather than jumping to the "src" sibling that
    // happens to be the next entry in `visibleRows`.
    await fireEvent.keyDown(rowFor(container, emptyPath), { key: "ArrowRight" });
    expect(tabbableRow(container)).toBe(rowFor(container, emptyPath));
    expect(document.activeElement).toBe(rowFor(container, emptyPath));
  });

  it("ArrowLeft collapses an open directory without moving focus; on a closed directory or a file it moves focus to the parent", async () => {
    const { container } = await renderTree();
    await fireEvent.keyDown(rowFor(container, ROOT), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, SRC)));

    // Closed directory: ArrowLeft moves focus to the parent (root).
    await fireEvent.keyDown(rowFor(container, SRC), { key: "ArrowLeft" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, ROOT)));

    // File: ArrowLeft also moves focus to its parent (root).
    await fireEvent.keyDown(rowFor(container, ROOT), { key: "ArrowDown" });
    await fireEvent.keyDown(rowFor(container, SRC), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, A_TXT)));
    await fireEvent.keyDown(rowFor(container, A_TXT), { key: "ArrowLeft" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, ROOT)));

    // Open directory: ArrowLeft collapses it, focus unchanged.
    await fireEvent.keyDown(rowFor(container, ROOT), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, SRC)));
    await fireEvent.keyDown(rowFor(container, SRC), { key: "ArrowRight" });
    await vi.waitFor(() => expect(container.querySelector(`.row[data-path="${INDEX_TS}"]`)).toBeTruthy());

    await fireEvent.keyDown(rowFor(container, SRC), { key: "ArrowLeft" });
    await vi.waitFor(() => expect(container.querySelector(`.row[data-path="${INDEX_TS}"]`)).toBeNull());
    expect(tabbableRow(container)).toBe(rowFor(container, SRC));
  });

  it("marks aria-selected='true' on exactly the focused row", async () => {
    const { container } = await renderTree();
    expect(rowFor(container, ROOT).getAttribute("aria-selected")).toBe("true");
    expect(rowFor(container, SRC).getAttribute("aria-selected")).toBe("false");
    expect(rowFor(container, A_TXT).getAttribute("aria-selected")).toBe("false");

    await fireEvent.keyDown(rowFor(container, ROOT), { key: "ArrowDown" });
    await vi.waitFor(() => {
      expect(rowFor(container, SRC).getAttribute("aria-selected")).toBe("true");
      expect(rowFor(container, ROOT).getAttribute("aria-selected")).toBe("false");
    });
  });

  it("shift-click selects every visible row between the anchor and target without activating the target", async () => {
    const { container } = await renderTree();
    const tree = container.querySelector('[role="tree"]');

    await fireEvent.click(rowFor(container, SRC));
    await vi.waitFor(() => expect(container.querySelector(`.row[data-path="${INDEX_TS}"]`)).toBeTruthy());
    await fireEvent.click(rowFor(container, A_TXT), { shiftKey: true });

    expect(tree?.getAttribute("aria-multiselectable")).toBe("true");
    expect(rowFor(container, ROOT).getAttribute("aria-selected")).toBe("false");
    expect(rowFor(container, SRC).getAttribute("aria-selected")).toBe("true");
    expect(rowFor(container, INDEX_TS).getAttribute("aria-selected")).toBe("true");
    expect(rowFor(container, A_TXT).getAttribute("aria-selected")).toBe("true");
    expect(commands.fsReadFile).not.toHaveBeenCalled();

    await fireEvent.click(rowFor(container, SRC));

    expect(rowFor(container, ROOT).getAttribute("aria-selected")).toBe("false");
    expect(rowFor(container, SRC).getAttribute("aria-selected")).toBe("true");
    expect(rowFor(container, A_TXT).getAttribute("aria-selected")).toBe("false");
  });

  it("sets aria-level to nesting depth (1-based) and wraps a directory's children in role=group", async () => {
    const { container } = await renderTree();

    expect(rowFor(container, ROOT).getAttribute("aria-level")).toBe("1");
    expect(rowFor(container, SRC).getAttribute("aria-level")).toBe("2");
    expect(rowFor(container, A_TXT).getAttribute("aria-level")).toBe("2");

    expect(groupFor(container, ROOT)?.contains(rowFor(container, SRC))).toBe(true);
    // A file never gets a role=group wrapper: it has no children to hold.
    expect(groupFor(container, A_TXT)).toBeNull();

    await fireEvent.keyDown(rowFor(container, ROOT), { key: "ArrowDown" });
    await fireEvent.keyDown(rowFor(container, SRC), { key: "ArrowRight" });
    await vi.waitFor(() => expect(container.querySelector(`.row[data-path="${INDEX_TS}"]`)).toBeTruthy());

    expect(rowFor(container, INDEX_TS).getAttribute("aria-level")).toBe("3");
    expect(groupFor(container, SRC)?.contains(rowFor(container, INDEX_TS))).toBe(true);
  });

  it("gives the tree an accessible name", async () => {
    const { container } = await renderTree();
    expect(container.querySelector('[role="tree"]')?.getAttribute("aria-label")).toBe(
      "File Explorer",
    );
  });

  it("Space and Enter still toggle the focused directory (regression: FileTreeNode's own row-level keydown handling is unmodified)", async () => {
    const { container } = await renderTree();
    await fireEvent.keyDown(rowFor(container, ROOT), { key: "ArrowDown" });
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(rowFor(container, SRC)));

    await fireEvent.keyDown(rowFor(container, SRC), { key: " " });
    await vi.waitFor(() => expect(container.querySelector(`.row[data-path="${INDEX_TS}"]`)).toBeTruthy());

    await fireEvent.keyDown(rowFor(container, SRC), { key: "Enter" });
    await vi.waitFor(() => expect(container.querySelector(`.row[data-path="${INDEX_TS}"]`)).toBeNull());
  });

  it("F2 and Ctrl+Backspace still fire on a focused row now that the container also handles keydown (regression)", async () => {
    const { container } = await renderTree();
    const fileRow = rowFor(container, A_TXT);
    fileRow.focus();

    await fireEvent.keyDown(fileRow, { key: "F2" });
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("a.txt");
    await fireEvent.keyDown(input, { key: "Escape" });

    await fireEvent.keyDown(rowFor(container, A_TXT), { key: "Backspace", ctrlKey: true });
    expect(container.querySelector(".modal-backdrop")).toBeTruthy();
    expect(commands.fsDelete).not.toHaveBeenCalled();
  });

  it("reconciles a stale focused row so the explorer never drops out of the tab sequence", async () => {
    const { container } = await renderTree();
    const fileRow = rowFor(container, A_TXT);
    fileRow.focus();
    await vi.waitFor(() => expect(tabbableRow(container)).toBe(fileRow));

    // Trigger 1: the root's listing refreshes without the focused row (e.g.
    // an fs:changed handler, or a sibling delete/rename reloading the parent
    // directory) - a.txt disappears out from under the focused row.
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([
      { name: "src", path: SRC, isDir: true, isSymlink: false },
    ]);
    await loadChildren(ROOT);
    await vi.waitFor(() => {
      expect(container.querySelector(`.row[data-path="${A_TXT}"]`)).toBeNull();
      expect(container.querySelectorAll('.row[tabindex="0"]')).toHaveLength(1);
    });

    // Trigger 2: the whole tree reloads for a different workspace root.
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([]);
    await loadRoot("/other");
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.row[tabindex="0"]')).toHaveLength(1);
      expect(tabbableRow(container)).toBe(rowFor(container, "/other"));
    });
  });
});
