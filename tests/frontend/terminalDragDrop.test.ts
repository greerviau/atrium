import { describe, it, expect, vi, afterEach } from "vitest";
import { tick } from "svelte";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTreeNode from "../../src/lib/explorer/FileTreeNode.svelte";
import TerminalPane from "../../src/lib/terminal/TerminalPane.svelte";
import type { TreeNode } from "../../src/lib/stores/fileTree";
import { EXPLORER_PATH_DRAG_TYPE } from "../../src/lib/util/dragDropTypes";
import * as commands from "../../src/lib/ipc/commands";

// Only the Tauri IPC boundary is mocked, matching TerminalPanel.test.ts /
// App.terminalAutoSpawn.test.ts's own convention — everything else in each
// component (drag/drop wiring, the pty write path) runs unmodified.
vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    ptySpawn: vi.fn().mockResolvedValue("term-1"),
    ptySubscribe: vi.fn().mockResolvedValue(undefined),
    ptyWrite: vi.fn().mockResolvedValue(undefined),
    ptyResize: vi.fn().mockResolvedValue(undefined),
    ptyKill: vi.fn().mockResolvedValue(undefined),
  };
});

// xterm.js probes window.matchMedia (for its DPR-change listener) on open(),
// and TerminalPane observes its container's size — neither is implemented
// by jsdom.
window.matchMedia ??= ((query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList) as typeof window.matchMedia;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeNode(overrides: Partial<TreeNode["entry"]> = {}): TreeNode {
  return {
    entry: {
      name: "file.txt",
      path: "/workspace/file.txt",
      isDir: false,
      isSymlink: false,
      ...overrides,
    },
    expanded: false,
    children: undefined,
  };
}

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

async function renderReadyTerminalPane() {
  const rendered = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
  await tick(); // let the async ptySpawn() in onMount resolve and assign terminalId
  return rendered;
}

describe("explorer-to-terminal drag and drop", () => {
  it("makes a file row a drag source that puts its path on the private drag type, not text/plain", async () => {
    const node = makeNode();
    const { container } = render(FileTreeNode, { node });

    const row = container.querySelector(".row")!;
    expect(row.getAttribute("draggable")).toBe("true");

    const dataTransfer = dataTransferStub();
    await fireEvent.dragStart(row, { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith(EXPLORER_PATH_DRAG_TYPE, "/workspace/file.txt");
    // Never text/plain: that generic type is also read by CodeMirror's own
    // drop handler, which would insert the path into an open editor buffer.
    expect(dataTransfer.setData).not.toHaveBeenCalledWith("text/plain", expect.anything());
  });

  it("makes a directory row a drag source too", async () => {
    const node = makeNode({ name: "src", path: "/workspace/src", isDir: true });
    const { container } = render(FileTreeNode, { node });

    const row = container.querySelector(".row")!;
    expect(row.getAttribute("draggable")).toBe("true");

    const dataTransfer = dataTransferStub();
    await fireEvent.dragStart(row, { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith(EXPLORER_PATH_DRAG_TYPE, "/workspace/src");
  });

  it("dragover accepts the app's private path type and shows the copy affordance", async () => {
    const { container } = await renderReadyTerminalPane();

    const pane = container.querySelector(".terminal-pane")!;
    const dataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: "/workspace/file.txt" });
    const dragOverEvent = await fireEvent.dragOver(pane, { dataTransfer });

    expect(dragOverEvent).toBe(false); // fireEvent returns false when defaultPrevented
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(pane.classList.contains("drop-target-active")).toBe(true);
  });

  it("dragover ignores a payload that isn't the app's private path type", async () => {
    const { container } = await renderReadyTerminalPane();

    const pane = container.querySelector(".terminal-pane")!;
    const dataTransfer = dataTransferStub({ "text/plain": "some text" });
    const dragOverEvent = await fireEvent.dragOver(pane, { dataTransfer });

    expect(dragOverEvent).toBe(true); // not prevented
    expect(pane.classList.contains("drop-target-active")).toBe(false);
  });

  it("dropping a path onto a terminal pane writes the shell-quoted, bracketed-paste-wrapped path to the pty and focuses the terminal", async () => {
    const { container } = await renderReadyTerminalPane();

    const pane = container.querySelector(".terminal-pane")!;
    const dataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: "/workspace/My Documents/file.txt" });
    const dropEvent = await fireEvent.drop(pane, { dataTransfer });

    expect(dropEvent).toBe(false); // fireEvent.drop returns false when defaultPrevented
    expect(commands.ptyWrite).toHaveBeenCalledWith(
      "term-1",
      "\x1b[200~'/workspace/My Documents/file.txt' \x1b[201~",
    );
    expect(container.querySelector(".xterm-helper-textarea")).toBe(document.activeElement);
  });

  it("clears the drop-target affordance on drop", async () => {
    const { container } = await renderReadyTerminalPane();

    const pane = container.querySelector(".terminal-pane")!;
    const dataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: "/workspace/file.txt" });
    await fireEvent.dragOver(pane, { dataTransfer });
    expect(pane.classList.contains("drop-target-active")).toBe(true);

    await fireEvent.drop(pane, { dataTransfer });
    expect(pane.classList.contains("drop-target-active")).toBe(false);
  });

  it("a drop with no path payload (e.g. only text/plain) is a no-op", async () => {
    const { container } = await renderReadyTerminalPane();

    const pane = container.querySelector(".terminal-pane")!;
    const dataTransfer = dataTransferStub({ "text/plain": "not a path drag" });
    const dropEvent = await fireEvent.drop(pane, { dataTransfer });

    expect(dropEvent).toBe(true); // not prevented, since nothing was inserted
    expect(commands.ptyWrite).not.toHaveBeenCalled();
  });

  it("keeps the drop-target affordance while the pointer moves within the pane's own subtree", async () => {
    const { container } = await renderReadyTerminalPane();

    const pane = container.querySelector(".terminal-pane")!;
    const child = pane.querySelector(".xterm-helper-textarea")!;
    const dataTransfer = dataTransferStub({ [EXPLORER_PATH_DRAG_TYPE]: "/workspace/file.txt" });
    await fireEvent.dragOver(pane, { dataTransfer });
    expect(pane.classList.contains("drop-target-active")).toBe(true);

    // jsdom has no DragEvent constructor, so @testing-library/dom's
    // fireEvent.dragLeave silently drops a `relatedTarget` passed via its
    // init object (it isn't a plain Event property) — dispatch a manually
    // built event instead, the same way the library patches `dataTransfer`.
    function dragLeaveWithRelatedTarget(relatedTarget: EventTarget | null): Promise<boolean> {
      const event = new Event("dragleave", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
      return fireEvent(pane, event);
    }

    await dragLeaveWithRelatedTarget(child);
    expect(pane.classList.contains("drop-target-active")).toBe(true);

    await dragLeaveWithRelatedTarget(null);
    expect(pane.classList.contains("drop-target-active")).toBe(false);
  });
});
