import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { loadRoot, loadChildren } from "../../src/lib/stores/fileTree";
import { draggingPath } from "../../src/lib/explorer/explorerDrag";
import { EXPLORER_PATH_DRAG_TYPE } from "../../src/lib/util/dragDropTypes";
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

// Standing in for a real `DataTransfer` (jsdom implements no drag-and-drop),
// following terminalDragDrop.test.ts's own convention.
function dataTransferStub(payload: Record<string, string> = {}): DataTransfer {
  const store = { ...payload };
  return {
    setData: vi.fn((format: string, data: string) => {
      store[format] = data;
    }),
    getData: (format: string) => store[format] ?? "",
    types: Object.keys(store),
    effectAllowed: "none",
    dropEffect: "none",
  } as unknown as DataTransfer;
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

/** Fires a real dragstart on `sourcePath`'s row, exercising FileTreeNode's own draggingPath wiring. */
async function dragStartOn(container: HTMLElement, sourcePath: string): Promise<void> {
  const row = container.querySelector(`.row[data-path="${sourcePath}"]`)!;
  await fireEvent.dragStart(row, { dataTransfer: dataTransferStub() });
}

function rowFor(container: HTMLElement, path: string): HTMLElement {
  return container.querySelector(`.row[data-path="${path}"]`)!;
}

describe("explorer drag-move", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
    vi.mocked(commands.fsRename).mockReset();
    draggingPath.set(null);
  });

  afterEach(() => {
    cleanup();
    draggingPath.set(null);
  });

  it("shows the move affordance when dragging a directory row over another directory row", async () => {
    const { container } = await renderExpandedTree();
    await dragStartOn(container, SRC);

    const target = rowFor(container, LIB);
    const dataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: SRC });
    const dragOverEvent = await fireEvent.dragOver(target, { dataTransfer });

    expect(dragOverEvent).toBe(false); // fireEvent returns false when defaultPrevented
    expect(dataTransfer.dropEffect).toBe("move");
    expect(target.classList.contains("drop-target-active")).toBe(true);
  });

  it("moves a directory into another directory on drop, refreshing both directories' listings", async () => {
    const { container } = await renderExpandedTree();
    await dragStartOn(container, SRC);
    vi.mocked(commands.fsListDir).mockClear();

    const target = rowFor(container, LIB);
    const dataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: SRC });
    const dropEvent = await fireEvent.drop(target, { dataTransfer });

    expect(dropEvent).toBe(false); // fireEvent.drop returns false when defaultPrevented
    expect(commands.fsRename).toHaveBeenCalledWith("local", SRC, `${LIB}/src`);
    expect(commands.fsListDir).toHaveBeenCalledWith("local", ROOT); // src's old parent
    expect(commands.fsListDir).toHaveBeenCalledWith("local", LIB); // the new parent
  });

  it("refuses to drop a directory onto itself", async () => {
    const { container } = await renderExpandedTree();
    await dragStartOn(container, SRC);

    const target = rowFor(container, SRC);
    const overDataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: SRC });
    const dragOverEvent = await fireEvent.dragOver(target, { dataTransfer: overDataTransfer });
    expect(dragOverEvent).toBe(true); // not prevented
    expect(target.classList.contains("drop-target-active")).toBe(false);

    // A forced drop (bypassing the dragover gate) must still refuse.
    const dropDataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: SRC });
    await fireEvent.drop(target, { dataTransfer: dropDataTransfer });
    expect(commands.fsRename).not.toHaveBeenCalled();
  });

  it("refuses to drop a directory onto its own descendant", async () => {
    const { container } = await renderExpandedTree();
    await dragStartOn(container, SRC);

    const target = rowFor(container, NESTED);
    const overDataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: SRC });
    const dragOverEvent = await fireEvent.dragOver(target, { dataTransfer: overDataTransfer });
    expect(dragOverEvent).toBe(true); // not prevented
    expect(target.classList.contains("drop-target-active")).toBe(false);

    const dropDataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: SRC });
    await fireEvent.drop(target, { dataTransfer: dropDataTransfer });
    expect(commands.fsRename).not.toHaveBeenCalled();
  });

  it("refuses to drop onto a file row", async () => {
    const { container } = await renderExpandedTree();
    await dragStartOn(container, SRC);

    const target = rowFor(container, README);
    const overDataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: SRC });
    await fireEvent.dragOver(target, { dataTransfer: overDataTransfer });
    expect(target.classList.contains("drop-target-active")).toBe(false);

    const dropDataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: SRC });
    await fireEvent.drop(target, { dataTransfer: dropDataTransfer });
    expect(commands.fsRename).not.toHaveBeenCalled();
  });

  it("moves a row to the workspace root when dropped on empty space below the rows", async () => {
    const { container } = await renderExpandedTree();
    await dragStartOn(container, NESTED);
    vi.mocked(commands.fsListDir).mockClear();

    const emptyArea = container.querySelector(".file-tree")!;
    const dataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: NESTED });
    const dropEvent = await fireEvent.drop(emptyArea, { dataTransfer });

    expect(dropEvent).toBe(false);
    expect(commands.fsRename).toHaveBeenCalledWith("local", NESTED, `${ROOT}/nested`);
    expect(commands.fsListDir).toHaveBeenCalledWith("local", SRC); // nested's old parent
    expect(commands.fsListDir).toHaveBeenCalledWith("local", ROOT); // the workspace root
  });

  it("does not fall through to a root-level move when dropped over an invalid nested row", async () => {
    const { container } = await renderExpandedTree();
    await dragStartOn(container, SRC);

    // Dropping src onto its own descendant is rejected by the row's own
    // guard (no preventDefault), so the event bubbles unprevented up to the
    // tree container — which must recognize it landed inside a row and not
    // reinterpret it as an empty-space drop onto the workspace root.
    const target = rowFor(container, NESTED);
    const dataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: SRC });
    await fireEvent.drop(target, { dataTransfer });

    expect(commands.fsRename).not.toHaveBeenCalledWith("local", SRC, expect.stringContaining(ROOT));
  });

  it("fails silently on a destination collision, without refreshing either directory", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = await renderExpandedTree();
    await dragStartOn(container, SRC);
    vi.mocked(commands.fsRename).mockRejectedValue({
      code: "ALREADY_EXISTS",
      message: `${LIB}/src`,
    });
    vi.mocked(commands.fsListDir).mockClear();

    const target = rowFor(container, LIB);
    const dataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: SRC });
    await fireEvent.drop(target, { dataTransfer });

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(commands.fsListDir).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
