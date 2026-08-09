import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { get } from "svelte/store";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { loadRoot, loadChildren, fileTree, type TreeNode } from "../../src/lib/stores/fileTree";
import { draggingPath, dragOverTargetDir, draggingEntry, dragPointerPosition } from "../../src/lib/explorer/explorerDrag";
import { editingPath } from "../../src/lib/explorer/inlineEdit";
import * as commands from "../../src/lib/ipc/commands";
import type { DirEntry } from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
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
const NESTED = `${SRC}/nested`;
const LIB = `${ROOT}/lib`;
const README = `${ROOT}/readme.txt`;

function dirEntry(path: string): DirEntry {
  return { name: path.split("/").pop()!, path, isDir: true, isSymlink: false };
}

function fileEntry(path: string): DirEntry {
  return { name: path.split("/").pop()!, path, isDir: false, isSymlink: false };
}

/** Loads the root plus an expanded `src/nested` subtree, then renders the tree. */
async function renderExpandedTree() {
  vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
    if (path === ROOT) return [dirEntry(SRC), dirEntry(LIB), fileEntry(README)];
    if (path === SRC) return [dirEntry(NESTED)];
    return [];
  });
  await loadRoot(ROOT);
  await loadChildren(SRC);
  return render(FileTree);
}

function rowFor(container: HTMLElement, path: string): HTMLElement {
  return container.querySelector(`.row[data-path="${path}"]`)!;
}

function isExpanded(path: string): boolean | undefined {
  function find(node: TreeNode | null | undefined): boolean | undefined {
    if (!node) return undefined;
    if (node.entry.path === path) return node.expanded;
    for (const child of node.children ?? []) {
      const found = find(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return find(get(fileTree).root);
}

/**
 * jsdom implements no `PointerEvent` constructor carrying real coordinates,
 * so pointer gestures are driven through plain bubbling `Event`s stamped
 * with the fields `explorerDrag.ts` reads — the same convention
 * `tableHandles.test.ts` uses for its own pointer-driven drag
 * (`tableHandles.test.ts:536`).
 */
function pointerEvt(
  type: string,
  opts: { clientX?: number; clientY?: number; pointerId?: number; button?: number; buttons?: number } = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "button", { value: opts.button ?? 0, configurable: true });
  Object.defineProperty(event, "buttons", { value: opts.buttons ?? 1, configurable: true });
  Object.defineProperty(event, "pointerId", { value: opts.pointerId ?? 1, configurable: true });
  Object.defineProperty(event, "clientX", { value: opts.clientX ?? 0, configurable: true });
  Object.defineProperty(event, "clientY", { value: opts.clientY ?? 0, configurable: true });
  return event;
}

/**
 * Fixed clientY "slot" per row, plus one for empty space below the rows.
 * jsdom implements no layout, so `document.elementFromPoint` (what
 * `resolveExplorerDropTargetDir` hit-tests with) must be stubbed the same
 * way `explorerDropTargets.test.ts` already does — with a coordinate-to-row
 * map rather than one fixed return value, since several cases below need
 * different rows to resolve at different coordinates in the same test.
 */
const Y = { root: 10, src: 30, srcHover: 36, nested: 50, lib: 70, readme: 90, empty: 500 };

function stubDropTargets(container: HTMLElement): void {
  const byY = new Map<number, Element | null>([
    [Y.root, rowFor(container, ROOT)],
    [Y.src, rowFor(container, SRC)],
    [Y.srcHover, rowFor(container, SRC)], // still hovering SRC's own row, past the click threshold
    [Y.nested, rowFor(container, NESTED)],
    [Y.lib, rowFor(container, LIB)],
    [Y.readme, rowFor(container, README)],
    [Y.empty, container.querySelector(".file-tree")],
  ]);
  document.elementFromPoint = vi.fn((_x: number, y: number) => byY.get(y) ?? null);
}

/** Starts a drag on `row` at `fromY` and moves it past the threshold to `toY`. */
function dragTo(row: HTMLElement, fromY: number, toY: number, pointerId = 1): void {
  row.dispatchEvent(pointerEvt("pointerdown", { clientX: 0, clientY: fromY, pointerId }));
  window.dispatchEvent(pointerEvt("pointermove", { clientX: 0, clientY: toY, pointerId }));
}

function pointerUp(atY: number, pointerId = 1): Promise<boolean> {
  return fireEvent(window, pointerEvt("pointerup", { clientX: 0, clientY: atY, pointerId }));
}

describe("explorer drag-move", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
    vi.mocked(commands.fsRename).mockReset();
    draggingPath.set(null);
    dragOverTargetDir.set(null);
    draggingEntry.set(null);
    dragPointerPosition.set(null);
    editingPath.set(null);
    // jsdom implements neither method at all.
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  afterEach(() => {
    cleanup();
    draggingPath.set(null);
    dragOverTargetDir.set(null);
    draggingEntry.set(null);
    dragPointerPosition.set(null);
    editingPath.set(null);
  });

  it("highlights the target row while dragging, and moves into it on pointerup, refreshing both directories' listings", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);
    vi.mocked(commands.fsListDir).mockClear();

    dragTo(rowFor(container, SRC), Y.src, Y.lib);
    await tick();

    expect(get(dragOverTargetDir)).toBe(LIB);
    expect(rowFor(container, LIB).classList.contains("drop-target-active")).toBe(true);

    await pointerUp(Y.lib);

    await vi.waitFor(() => expect(commands.fsRename).toHaveBeenCalled());
    expect(commands.fsRename).toHaveBeenCalledWith("local", SRC, `${LIB}/src`);
    await vi.waitFor(() => expect(commands.fsListDir).toHaveBeenCalledWith("local", ROOT)); // src's old parent
    expect(commands.fsListDir).toHaveBeenCalledWith("local", LIB); // the new parent
  });

  it("disables horizontal explorer scrolling while a row is being dragged and restores it on release", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);
    const tree = container.querySelector(".file-tree") as HTMLElement;

    expect(getComputedStyle(tree).overflow).toBe("auto");

    dragTo(rowFor(container, SRC), Y.src, Y.lib);
    await tick();

    expect(getComputedStyle(tree).overflowX).toBe("hidden");

    await pointerUp(Y.lib);
    await tick();

    expect(getComputedStyle(tree).overflow).toBe("auto");
    expect(getComputedStyle(tree).overflowX).toBe("");
  });

  it("snaps scrollLeft back the instant it moves during a drag (issue #390 follow-up: the overflow-x lock alone wasn't enough), and stops correcting it once the drag ends", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);
    const tree = container.querySelector(".file-tree") as HTMLElement;

    dragTo(rowFor(container, SRC), Y.src, Y.lib);
    await tick();

    // jsdom doesn't fire `scroll` on a `scrollLeft` assignment on its own
    // (the same manual-dispatch convention `scrollbarAutoHide.test.ts` uses),
    // so this stands in for whatever actually moved it in a real browser —
    // native drag-autoscroll, a wheel event, anything.
    tree.scrollLeft = 40;
    tree.dispatchEvent(new Event("scroll"));

    expect(tree.scrollLeft).toBe(0);

    await pointerUp(Y.lib);
    await tick();

    tree.scrollLeft = 40;
    tree.dispatchEvent(new Event("scroll"));

    expect(tree.scrollLeft).toBe(40);
  });

  it("does not start a drag (or move anything) when the pointer never crosses the threshold, and the row's click still toggles it", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);

    const srcRow = rowFor(container, SRC);
    srcRow.dispatchEvent(pointerEvt("pointerdown", { clientX: 0, clientY: Y.src, pointerId: 1 }));
    window.dispatchEvent(pointerEvt("pointermove", { clientX: 0, clientY: Y.src + 1, pointerId: 1 }));
    await pointerUp(Y.src + 1);

    expect(commands.fsRename).not.toHaveBeenCalled();
    expect(get(draggingPath)).toBeNull();
    expect(isExpanded(SRC)).toBe(true);

    await fireEvent.click(srcRow);

    expect(isExpanded(SRC)).toBe(false);
  });

  it("shows no highlight and performs no move when dragged onto its own row", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);

    dragTo(rowFor(container, SRC), Y.src, Y.srcHover);
    expect(get(draggingPath)).toBe(SRC); // the gesture did cross the drag threshold
    expect(get(dragOverTargetDir)).toBeNull();

    await pointerUp(Y.srcHover);
    expect(commands.fsRename).not.toHaveBeenCalled();
  });

  it("shows no highlight and performs no move when dragged onto its own descendant", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);

    dragTo(rowFor(container, SRC), Y.src, Y.nested);
    expect(get(dragOverTargetDir)).toBeNull();

    await pointerUp(Y.nested);
    expect(commands.fsRename).not.toHaveBeenCalled();
  });

  it("shows no highlight and performs no move when dragged onto its current parent", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);

    dragTo(rowFor(container, SRC), Y.src, Y.root);
    expect(get(dragOverTargetDir)).toBeNull();

    await pointerUp(Y.root);
    expect(commands.fsRename).not.toHaveBeenCalled();
  });

  it("resolves a drop onto a file row to that file's parent directory", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);
    vi.mocked(commands.fsListDir).mockClear();

    // NESTED's own parent is SRC, so dropping it on README (parent: ROOT) is
    // a genuinely different, valid target — unlike dragging SRC itself onto
    // README, which would also resolve to ROOT but be rejected as a same-
    // parent no-op.
    dragTo(rowFor(container, NESTED), Y.nested, Y.readme);
    expect(get(dragOverTargetDir)).toBe(ROOT);

    await pointerUp(Y.readme);

    await vi.waitFor(() => expect(commands.fsRename).toHaveBeenCalled());
    expect(commands.fsRename).toHaveBeenCalledWith("local", NESTED, `${ROOT}/nested`);
  });

  it("moves a row to the workspace root when dropped on empty space below the rows", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);
    vi.mocked(commands.fsListDir).mockClear();

    dragTo(rowFor(container, NESTED), Y.nested, Y.empty);
    expect(get(dragOverTargetDir)).toBe(ROOT);

    await pointerUp(Y.empty);

    await vi.waitFor(() => expect(commands.fsRename).toHaveBeenCalled());
    expect(commands.fsRename).toHaveBeenCalledWith("local", NESTED, `${ROOT}/nested`);
    await vi.waitFor(() => expect(commands.fsListDir).toHaveBeenCalledWith("local", SRC)); // nested's old parent
    expect(commands.fsListDir).toHaveBeenCalledWith("local", ROOT); // the workspace root
  });

  it("fails silently on a destination collision, without refreshing either directory", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = await renderExpandedTree();
    stubDropTargets(container);
    vi.mocked(commands.fsRename).mockRejectedValue({
      code: "ALREADY_EXISTS",
      message: `${LIB}/src`,
    });
    vi.mocked(commands.fsListDir).mockClear();

    dragTo(rowFor(container, SRC), Y.src, Y.lib);
    await pointerUp(Y.lib);

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(commands.fsListDir).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("a plain click with no pointer movement at all still toggles a directory's expansion — the exact interaction #189 reported breaking", async () => {
    const { container } = await renderExpandedTree();

    expect(isExpanded(SRC)).toBe(true);
    await fireEvent.click(rowFor(container, SRC));
    expect(isExpanded(SRC)).toBe(false);
  });

  it("still opens/toggles normally on a later plain click on the drag source, after an earlier drag released over a different row", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);

    dragTo(rowFor(container, SRC), Y.src, Y.lib);
    await pointerUp(Y.lib);
    await vi.waitFor(() => expect(commands.fsRename).toHaveBeenCalled());

    // A later, unrelated interaction with the same row the drag started
    // from: no movement, so this is a plain click, not a drag.
    const srcRow = rowFor(container, SRC);
    expect(isExpanded(SRC)).toBe(true);
    srcRow.dispatchEvent(pointerEvt("pointerdown", { clientX: 0, clientY: Y.src, pointerId: 2 }));
    await fireEvent(window, pointerEvt("pointerup", { clientX: 0, clientY: Y.src, pointerId: 2 }));
    await fireEvent.click(srcRow);

    expect(isExpanded(SRC)).toBe(false);
  });

  it("performs no move on pointercancel after crossing the threshold, and a later unrelated pointer gesture performs no move either", async () => {
    const { container } = await renderExpandedTree();
    stubDropTargets(container);

    dragTo(rowFor(container, SRC), Y.src, Y.lib);
    expect(get(draggingPath)).toBe(SRC);

    await fireEvent(window, pointerEvt("pointercancel", { clientX: 0, clientY: Y.lib, pointerId: 1 }));

    expect(commands.fsRename).not.toHaveBeenCalled();
    expect(get(draggingPath)).toBeNull();
    expect(get(dragOverTargetDir)).toBeNull();

    // The cancelled gesture's own listeners must be fully torn down: an
    // unrelated move/up pair (no matching pointerdown ever started it) must
    // not resurrect a move.
    window.dispatchEvent(pointerEvt("pointermove", { clientX: 0, clientY: Y.readme, pointerId: 1 }));
    await fireEvent(window, pointerEvt("pointerup", { clientX: 0, clientY: Y.readme, pointerId: 1 }));

    expect(commands.fsRename).not.toHaveBeenCalled();
  });

  it("commits an in-flight inline rename when a different row receives a pointerdown, without the row suppressing the browser's own blur-on-focus-shift default action", async () => {
    const { container, findByText } = await renderExpandedTree();
    await fireEvent.contextMenu(rowFor(container, README));
    await fireEvent.click(await findByText("Rename"));
    await tick();

    const input = container.querySelector("input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "renamed.txt" } });

    const otherRow = rowFor(container, LIB);
    const pointerDown = pointerEvt("pointerdown", { clientX: 0, clientY: Y.lib, pointerId: 1 });
    otherRow.dispatchEvent(pointerDown);
    // must-not-preventDefault is what lets the browser's own default action
    // (focusing `otherRow`, which blurs the still-focused rename input) run
    // at all; jsdom's synthetic `Event` dispatch doesn't replicate that
    // default action itself, so it's driven explicitly here.
    expect(pointerDown.defaultPrevented).toBe(false);
    otherRow.focus();

    await vi.waitFor(() =>
      expect(commands.fsRename).toHaveBeenCalledWith("local", README, `${ROOT}/renamed.txt`),
    );

    // Close out the gesture the pointerdown above started (never moved or
    // released), so its window-level listeners don't leak into later tests.
    await fireEvent(window, pointerEvt("pointerup", { clientX: 0, clientY: Y.lib, pointerId: 1 }));
  });
});
