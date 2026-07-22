import { describe, it, expect, vi, afterEach } from "vitest";
import { tick } from "svelte";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTreeNode from "../../src/lib/explorer/FileTreeNode.svelte";
import TerminalPane from "../../src/lib/terminal/TerminalPane.svelte";
import type { TreeNode } from "../../src/lib/stores/fileTree";
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

describe("explorer-to-terminal drag and drop", () => {
  it("makes a file tree row a drag source that puts its path on the dataTransfer", async () => {
    const node = makeNode();
    const { container } = render(FileTreeNode, { node });

    const row = container.querySelector(".row")!;
    expect(row.getAttribute("draggable")).toBe("true");

    const dataTransfer = dataTransferStub();
    await fireEvent.dragStart(row, { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "/workspace/file.txt");
  });

  it("dropping a path onto a terminal pane writes the shell-quoted path to the pty and focuses the terminal", async () => {
    const { container } = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
    await tick(); // let the async ptySpawn() in onMount resolve and assign terminalId

    const pane = container.querySelector(".terminal-pane")!;
    const dataTransfer = dataTransferStub({ "text/plain": "/workspace/My Documents/file.txt" });
    const dropEvent = await fireEvent.drop(pane, { dataTransfer });

    expect(dropEvent).toBe(false); // fireEvent.drop returns false when defaultPrevented
    expect(commands.ptyWrite).toHaveBeenCalledWith("term-1", "'/workspace/My Documents/file.txt'");
  });

  it("a drop with no text/plain payload is a no-op", async () => {
    const { container } = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
    await tick(); // let the async ptySpawn() in onMount resolve and assign terminalId

    const pane = container.querySelector(".terminal-pane")!;
    const dataTransfer = dataTransferStub();
    const dropEvent = await fireEvent.drop(pane, { dataTransfer });

    expect(dropEvent).toBe(true); // not prevented, since nothing was inserted
    expect(commands.ptyWrite).not.toHaveBeenCalled();
  });
});
