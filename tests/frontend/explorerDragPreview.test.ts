import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { get } from "svelte/store";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import ExplorerDragPreview from "../../src/lib/explorer/ExplorerDragPreview.svelte";
import { loadRoot, loadChildren } from "../../src/lib/stores/fileTree";
import { draggingPath, dragOverTargetDir, draggingEntry, dragPointerPosition } from "../../src/lib/explorer/explorerDrag";
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

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const ROOT = "/workspace";
const SRC = `${ROOT}/src`;
const LIB = `${ROOT}/lib`;
const README = `${ROOT}/readme.txt`;

function dirEntry(path: string): DirEntry {
  return { name: path.split("/").pop()!, path, isDir: true, isSymlink: false };
}

function fileEntry(path: string): DirEntry {
  return { name: path.split("/").pop()!, path, isDir: false, isSymlink: false };
}

/** Loads the root, then renders the tree alongside the preview, the way `App.svelte` mounts them side by side. */
async function renderTreeWithPreview() {
  vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
    if (path === ROOT) return [dirEntry(SRC), dirEntry(LIB), fileEntry(README)];
    return [];
  });
  await loadRoot(ROOT);
  const treeResult = render(FileTree);
  render(ExplorerDragPreview);
  return treeResult;
}

function rowFor(container: HTMLElement, path: string): HTMLElement {
  return container.querySelector(`.row[data-path="${path}"]`)!;
}

function previewEl(): HTMLElement | null {
  return document.body.querySelector(".drag-preview");
}

/**
 * jsdom implements no `PointerEvent` constructor carrying real coordinates,
 * so pointer gestures are driven through plain bubbling `Event`s stamped
 * with the fields `explorerDrag.ts` reads — the same convention
 * `explorerDragMove.test.ts` uses.
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

/** Coordinate map so `resolveExplorerDropTargetDir`'s hit-test resolves consistently regardless of the (varying) drag coordinates used in this file. */
function stubDropTargets(container: HTMLElement): void {
  const rows = new Map<string, Element>([
    [ROOT, rowFor(container, ROOT)],
    [SRC, rowFor(container, SRC)],
    [LIB, rowFor(container, LIB)],
    [README, rowFor(container, README)],
  ]);
  document.elementFromPoint = vi.fn(() => rows.get(SRC) ?? null);
}

/** Starts a drag on `row` at (fromX, fromY) and moves past the threshold to (toX, toY) — varying both axes, unlike `explorerDragMove.test.ts`'s fixed-X `dragTo`. */
function dragTo(row: HTMLElement, fromX: number, fromY: number, toX: number, toY: number, pointerId = 1): void {
  row.dispatchEvent(pointerEvt("pointerdown", { clientX: fromX, clientY: fromY, pointerId }));
  window.dispatchEvent(pointerEvt("pointermove", { clientX: toX, clientY: toY, pointerId }));
}

function pointerUp(atX: number, atY: number, pointerId = 1): Promise<boolean> {
  return fireEvent(window, pointerEvt("pointerup", { clientX: atX, clientY: atY, pointerId }));
}

describe("explorer drag preview", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
    draggingPath.set(null);
    dragOverTargetDir.set(null);
    draggingEntry.set(null);
    dragPointerPosition.set(null);
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
  });

  it("shows no preview element when no drag is in progress", async () => {
    await renderTreeWithPreview();
    expect(previewEl()).toBeNull();
  });

  it("shows the preview with the dragged folder's name and icon once the drag threshold is crossed, positioned per the degenerate clamp formula", async () => {
    const { container } = await renderTreeWithPreview();
    stubDropTargets(container);

    dragTo(rowFor(container, SRC), 100, 200, 130, 230);
    await tick();

    const el = previewEl();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("src");
    expect(el!.querySelector(".explorer-icon.icon-folder-closed")).not.toBeNull();
    // previewWidth/previewHeight stay 0 under jsdom (no layout, ResizeObserver
    // stub never fires), so the clamp degenerates to left = x + 14, top = y + 12.
    expect(el!.style.transform).toBe("translate3d(144px, 242px, 0)");

    await pointerUp(130, 230);
  });

  it("shows the preview with the dragged file's icon, distinct from a folder's", async () => {
    const { container } = await renderTreeWithPreview();
    stubDropTargets(container);

    dragTo(rowFor(container, README), 100, 200, 130, 230);
    await tick();

    const el = previewEl();
    expect(el!.textContent).toContain("readme.txt");
    expect(el!.querySelector(".explorer-icon.icon-generic")).not.toBeNull();

    await pointerUp(130, 230);
  });

  it("follows the cursor: a second pointermove after the threshold moves the preview to the new coordinates", async () => {
    const { container } = await renderTreeWithPreview();
    stubDropTargets(container);

    dragTo(rowFor(container, SRC), 100, 200, 130, 230);
    await tick();
    expect(previewEl()!.style.transform).toBe("translate3d(144px, 242px, 0)");

    window.dispatchEvent(pointerEvt("pointermove", { clientX: 300, clientY: 100, pointerId: 1 }));
    await tick();

    expect(previewEl()!.style.transform).toBe("translate3d(314px, 112px, 0)");

    await pointerUp(300, 100);
  });

  it("keeps showing the row that was picked up, not whichever row the pointer currently resolves to as a drop target", async () => {
    const { container } = await renderTreeWithPreview();
    stubDropTargets(container); // always resolves the drop target to SRC's row

    dragTo(rowFor(container, README), 100, 200, 130, 230);
    await tick();

    expect(get(dragOverTargetDir)).toBe(SRC);
    expect(previewEl()!.textContent).toContain("readme.txt");
    expect(previewEl()!.textContent).not.toContain("src");

    await pointerUp(130, 230);
  });

  it("clears the preview on pointerup", async () => {
    const { container } = await renderTreeWithPreview();
    stubDropTargets(container);

    dragTo(rowFor(container, SRC), 100, 200, 130, 230);
    await tick();
    expect(previewEl()).not.toBeNull();

    await pointerUp(130, 230);
    await tick();

    expect(previewEl()).toBeNull();
  });

  it("clears the preview on pointercancel", async () => {
    const { container } = await renderTreeWithPreview();
    stubDropTargets(container);

    dragTo(rowFor(container, SRC), 100, 200, 130, 230);
    await tick();
    expect(previewEl()).not.toBeNull();

    await fireEvent(window, pointerEvt("pointercancel", { clientX: 130, clientY: 230, pointerId: 1 }));
    await tick();

    expect(previewEl()).toBeNull();
  });

  it("shows no preview when the pointer never crosses the drag threshold", async () => {
    const { container } = await renderTreeWithPreview();
    stubDropTargets(container);

    const srcRow = rowFor(container, SRC);
    srcRow.dispatchEvent(pointerEvt("pointerdown", { clientX: 100, clientY: 200, pointerId: 1 }));
    window.dispatchEvent(pointerEvt("pointermove", { clientX: 101, clientY: 200, pointerId: 1 }));
    await tick();

    expect(previewEl()).toBeNull();

    await pointerUp(101, 200);
  });

  it("draggingEntry and dragPointerPosition are set/cleared together with draggingPath", async () => {
    const { container } = await renderTreeWithPreview();
    stubDropTargets(container);

    expect(get(draggingPath)).toBeNull();
    expect(get(draggingEntry)).toBeNull();
    expect(get(dragPointerPosition)).toBeNull();

    dragTo(rowFor(container, SRC), 100, 200, 130, 230);
    await tick();

    expect(get(draggingPath)).toBe(SRC);
    expect(get(draggingEntry)).not.toBeNull();
    expect(get(draggingEntry)!.path).toBe(SRC);
    expect(get(dragPointerPosition)).toEqual({ x: 130, y: 230 });

    await pointerUp(130, 230);
    await tick();

    expect(get(draggingPath)).toBeNull();
    expect(get(draggingEntry)).toBeNull();
    expect(get(dragPointerPosition)).toBeNull();
  });
});
