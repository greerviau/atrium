import { describe, it, expect, vi, afterEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import TerminalPane from "../../src/lib/terminal/TerminalPane.svelte";
import * as commands from "../../src/lib/ipc/commands";
import * as terminalDropTargets from "../../src/lib/terminal/terminalDropTargets";

// Only the Tauri IPC boundary is mocked, matching terminalDragDrop.test.ts's
// own convention — everything else in the component runs unmodified.
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

const { unregister } = vi.hoisted(() => ({ unregister: vi.fn() }));
vi.mock("../../src/lib/terminal/terminalDropTargets", () => ({
  registerTerminalDropTarget: vi.fn().mockReturnValue(unregister),
}));

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

async function renderReadyTerminalPane() {
  const rendered = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
  await tick(); // let the async ptySpawn() in onMount resolve and assign terminalId
  return rendered;
}

describe("TerminalPane OS-level drop registration", () => {
  it("registers exactly once on mount, with its own .terminal-pane container element and a callback", async () => {
    const { container } = await renderReadyTerminalPane();

    expect(terminalDropTargets.registerTerminalDropTarget).toHaveBeenCalledTimes(1);
    const [el, callback] = vi.mocked(terminalDropTargets.registerTerminalDropTarget).mock.calls[0];
    expect(el).toBe(container.querySelector(".terminal-pane"));
    expect(typeof callback).toBe("function");
  });

  it("calls the unregister function returned by registerTerminalDropTarget on unmount", async () => {
    await renderReadyTerminalPane();

    expect(unregister).not.toHaveBeenCalled();
    cleanup();

    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("the registered callback shell-quotes and space-joins multiple paths, writes them to the pty, and focuses the terminal", async () => {
    const { container } = await renderReadyTerminalPane();

    const callback = vi.mocked(terminalDropTargets.registerTerminalDropTarget).mock.calls[0][1];
    callback(["/workspace/a", "/workspace/My Documents/file.txt"]);

    expect(commands.ptyWrite).toHaveBeenCalledWith(
      "term-1",
      "/workspace/a '/workspace/My Documents/file.txt' ",
    );
    expect(container.querySelector(".xterm-helper-textarea")).toBe(document.activeElement);
  });

  it("the registered callback is a no-op before the pty has spawned", async () => {
    // No `await tick()` here: the async ptySpawn() kicked off in onMount
    // hasn't resolved yet, so terminalId is still undefined — mirrors
    // terminalDragDrop.test.ts's own "refuses the drop while spawning" case.
    render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });

    const callback = vi.mocked(terminalDropTargets.registerTerminalDropTarget).mock.calls[0][1];
    callback(["/workspace/a"]);

    expect(commands.ptyWrite).not.toHaveBeenCalled();
  });
});
