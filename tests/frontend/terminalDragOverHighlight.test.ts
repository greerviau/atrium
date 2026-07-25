import { describe, it, expect, vi, afterEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import TerminalPane from "../../src/lib/terminal/TerminalPane.svelte";
import { setDragOverTerminalPane } from "../../src/lib/terminal/terminalDropTargets";

// Only the Tauri IPC boundary is mocked, matching terminalOsDrop.test.ts's
// own convention — everything else in the component (including the real
// dragOverTerminalPane store, not mocked here) runs unmodified.
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
  setDragOverTerminalPane(null);
});

async function renderReadyTerminalPane() {
  const rendered = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
  await tick(); // let the async ptySpawn() in onMount resolve and assign terminalId
  return rendered;
}

describe("TerminalPane's pointer-drag drop-target highlight", () => {
  it("adds .drop-target-active once dragOverTerminalPane resolves to the pane's own container, after terminalId has resolved", async () => {
    const { container } = await renderReadyTerminalPane();
    const pane = container.querySelector(".terminal-pane")!;

    setDragOverTerminalPane(pane as HTMLElement);
    await tick();

    expect(pane.classList.contains("drop-target-active")).toBe(true);
  });

  it("removes .drop-target-active when the store resolves to a different element", async () => {
    const { container } = await renderReadyTerminalPane();
    const pane = container.querySelector(".terminal-pane")!;

    setDragOverTerminalPane(pane as HTMLElement);
    await tick();
    expect(pane.classList.contains("drop-target-active")).toBe(true);

    const otherEl = document.createElement("div");
    setDragOverTerminalPane(otherEl);
    await tick();

    expect(pane.classList.contains("drop-target-active")).toBe(false);
  });

  it("removes .drop-target-active when the store is cleared back to null", async () => {
    const { container } = await renderReadyTerminalPane();
    const pane = container.querySelector(".terminal-pane")!;

    setDragOverTerminalPane(pane as HTMLElement);
    await tick();
    expect(pane.classList.contains("drop-target-active")).toBe(true);

    setDragOverTerminalPane(null);
    await tick();

    expect(pane.classList.contains("drop-target-active")).toBe(false);
  });

  it("does not add .drop-target-active while the pty is still spawning, even if the store already resolves to this pane's container", async () => {
    // No `await tick()` after render: the async ptySpawn() kicked off in
    // onMount hasn't resolved yet, so terminalId is still undefined.
    const { container } = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
    const pane = container.querySelector(".terminal-pane")!;

    setDragOverTerminalPane(pane as HTMLElement);
    await tick();

    expect(pane.classList.contains("drop-target-active")).toBe(false);
  });
});
