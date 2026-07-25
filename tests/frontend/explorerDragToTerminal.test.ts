import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { loadRoot } from "../../src/lib/stores/fileTree";
import { draggingPath, dragOverTargetDir } from "../../src/lib/explorer/explorerDrag";
import { dragOverTerminalPane, registerTerminalDropTarget } from "../../src/lib/terminal/terminalDropTargets";
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
const LIB = `${ROOT}/lib`;

function dirEntry(path: string): DirEntry {
  return { name: path.split("/").pop()!, path, isDir: true, isSymlink: false };
}

/** Loads a flat root (`src`, `lib`) and renders the tree — this suite only needs enough explorer structure to start a drag and to prove the terminal branch behaves correctly alongside it. */
async function renderTree() {
  vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
    if (path === ROOT) return [dirEntry(SRC), dirEntry(LIB)];
    return [];
  });
  await loadRoot(ROOT);
  return render(FileTree);
}

function rowFor(container: HTMLElement, path: string): HTMLElement {
  return container.querySelector(`.row[data-path="${path}"]`)!;
}

/**
 * jsdom implements no `PointerEvent` constructor carrying real coordinates,
 * so pointer gestures are driven through plain bubbling `Event`s stamped
 * with the fields `explorerDrag.ts` reads — the same convention
 * `explorerDragMove.test.ts` uses for its own pointer-driven drag.
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

/** Fixed clientY "slot" per hit target, mirroring `explorerDragMove.test.ts`'s own Y-slot convention for stubbing `document.elementFromPoint`. */
const Y = { src: 30, lib: 70, terminalA: 200, terminalB: 260, editor: 300 };

function stubDropTargets(container: HTMLElement, byTarget: Map<number, Element | null>): void {
  const byY = new Map<number, Element | null>([
    [Y.src, rowFor(container, SRC)],
    [Y.lib, rowFor(container, LIB)],
    ...byTarget,
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

describe("explorer drag into a terminal pane", () => {
  let terminalPaneA: HTMLDivElement;
  let terminalPaneB: HTMLDivElement;
  let editorEl: HTMLDivElement;
  let insertA: ReturnType<typeof vi.fn>;
  let insertB: ReturnType<typeof vi.fn>;
  let unregisterA: () => void;
  let unregisterB: () => void;

  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
    vi.mocked(commands.fsRename).mockReset();
    draggingPath.set(null);
    dragOverTargetDir.set(null);
    dragOverTerminalPane.set(null);
    // jsdom implements neither method at all.
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();

    terminalPaneA = document.createElement("div");
    terminalPaneA.className = "terminal-pane";
    document.body.appendChild(terminalPaneA);
    terminalPaneB = document.createElement("div");
    terminalPaneB.className = "terminal-pane";
    document.body.appendChild(terminalPaneB);
    editorEl = document.createElement("div");
    editorEl.className = "editor";
    document.body.appendChild(editorEl);

    insertA = vi.fn();
    insertB = vi.fn();
    unregisterA = registerTerminalDropTarget(terminalPaneA, insertA);
    unregisterB = registerTerminalDropTarget(terminalPaneB, insertB);
  });

  afterEach(() => {
    cleanup();
    unregisterA();
    unregisterB();
    terminalPaneA.remove();
    terminalPaneB.remove();
    editorEl.remove();
    draggingPath.set(null);
    dragOverTargetDir.set(null);
    dragOverTerminalPane.set(null);
  });

  it("releasing over a registered terminal pane inserts the dragged path and performs no move", async () => {
    const { container } = await renderTree();
    stubDropTargets(container, new Map([[Y.terminalA, terminalPaneA]]));

    dragTo(rowFor(container, SRC), Y.src, Y.terminalA);
    await pointerUp(Y.terminalA);

    expect(insertA).toHaveBeenCalledWith([SRC]);
    expect(insertB).not.toHaveBeenCalled();
    expect(commands.fsRename).not.toHaveBeenCalled();
  });

  it("hovering a terminal pane mid-drag resolves dragOverTerminalPane and keeps dragOverTargetDir null", async () => {
    const { container } = await renderTree();
    stubDropTargets(container, new Map([[Y.terminalA, terminalPaneA]]));

    dragTo(rowFor(container, SRC), Y.src, Y.terminalA);

    expect(get(dragOverTerminalPane)).toBe(terminalPaneA);
    expect(get(dragOverTargetDir)).toBeNull();

    await pointerUp(Y.terminalA);
  });

  it("hovering back onto the explorer after the terminal clears dragOverTerminalPane and resolves dragOverTargetDir normally", async () => {
    const { container } = await renderTree();
    stubDropTargets(container, new Map([[Y.terminalA, terminalPaneA]]));

    const row = rowFor(container, SRC);
    row.dispatchEvent(pointerEvt("pointerdown", { clientX: 0, clientY: Y.src, pointerId: 1 }));
    window.dispatchEvent(pointerEvt("pointermove", { clientX: 0, clientY: Y.terminalA, pointerId: 1 }));
    expect(get(dragOverTerminalPane)).toBe(terminalPaneA);
    expect(get(dragOverTargetDir)).toBeNull();

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 0, clientY: Y.lib, pointerId: 1 }));
    expect(get(dragOverTerminalPane)).toBeNull();
    expect(get(dragOverTargetDir)).toBe(LIB);

    await pointerUp(Y.lib);
    await vi.waitFor(() => expect(commands.fsRename).toHaveBeenCalled());
    expect(insertA).not.toHaveBeenCalled();
    expect(insertB).not.toHaveBeenCalled();
  });

  it("a fast release resolves the insert callback from the pointerup's own coordinates, not the stale last-move point", async () => {
    const { container } = await renderTree();
    stubDropTargets(container, new Map([[Y.terminalA, terminalPaneA], [Y.terminalB, terminalPaneB]]));

    // The last pointermove the gesture saw hovered pane A...
    dragTo(rowFor(container, SRC), Y.src, Y.terminalA);
    expect(get(dragOverTerminalPane)).toBe(terminalPaneA);

    // ...but the pointerup itself lands over pane B, a point no pointermove
    // ever reported. Without `onUp`'s coordinate refresh, `end()` would
    // insert into pane A (the stale last-move point) instead.
    await pointerUp(Y.terminalB);

    expect(insertB).toHaveBeenCalledWith([SRC]);
    expect(insertA).not.toHaveBeenCalled();
  });

  it("pointercancel after crossing the threshold performs no insert and clears dragOverTerminalPane", async () => {
    const { container } = await renderTree();
    stubDropTargets(container, new Map([[Y.terminalA, terminalPaneA]]));

    dragTo(rowFor(container, SRC), Y.src, Y.terminalA);
    expect(get(dragOverTerminalPane)).toBe(terminalPaneA);

    await fireEvent(window, pointerEvt("pointercancel", { clientX: 0, clientY: Y.terminalA, pointerId: 1 }));

    expect(insertA).not.toHaveBeenCalled();
    expect(get(dragOverTerminalPane)).toBeNull();
    expect(get(draggingPath)).toBeNull();
  });

  it("releasing over neither the explorer nor a terminal pane is a no-op", async () => {
    const { container } = await renderTree();
    stubDropTargets(container, new Map([[Y.editor, editorEl]]));

    dragTo(rowFor(container, SRC), Y.src, Y.editor);
    expect(get(dragOverTerminalPane)).toBeNull();
    expect(get(dragOverTargetDir)).toBeNull();

    await pointerUp(Y.editor);

    expect(insertA).not.toHaveBeenCalled();
    expect(insertB).not.toHaveBeenCalled();
    expect(commands.fsRename).not.toHaveBeenCalled();
  });
});
