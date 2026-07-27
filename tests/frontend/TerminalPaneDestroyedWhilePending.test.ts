import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import TerminalPane from "../../src/lib/terminal/TerminalPane.svelte";
import * as commands from "../../src/lib/ipc/commands";

// Only the Tauri IPC boundary is mocked, matching TerminalPaneContextMenu.test.ts's own
// convention — everything else in the component (xterm.js, the Svelte lifecycle) runs
// unmodified, so these tests exercise the real onMount/onDestroy race.
vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    ptySpawn: vi.fn(),
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
  // `vi.restoreAllMocks()` would also wipe the `mockResolvedValue`s set up
  // in the `vi.mock` factory above (they're plain `vi.fn()`s, not
  // `vi.spyOn` spies), breaking `ptySubscribe`/etc for every test after the
  // first — matches TerminalPaneContextMenu.test.ts's own convention.
  vi.clearAllMocks();
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TerminalPane: destroyed while spawn is pending", () => {
  it("kills the pty once ptySpawn resolves after the pane has already been destroyed", async () => {
    let resolveSpawn!: (id: string) => void;
    vi.mocked(commands.ptySpawn).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    const { unmount } = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
    await flushMicrotasks(); // let onMount run up to the pending `await ptySpawn(...)`

    unmount(); // destroyed while the spawn is still in flight — the exact scenario in the issue

    resolveSpawn("term-1");
    await flushMicrotasks();

    expect(commands.ptyKill).toHaveBeenCalledWith("term-1");
    expect(commands.ptySubscribe).not.toHaveBeenCalled();
  });

  it("still kills the pty on ordinary teardown once spawn already resolved", async () => {
    vi.mocked(commands.ptySpawn).mockResolvedValue("term-1");

    const { unmount } = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
    await flushMicrotasks(); // let the async ptySpawn()/ptySubscribe() in onMount resolve

    unmount();

    expect(commands.ptyKill).toHaveBeenCalledTimes(1);
    expect(commands.ptyKill).toHaveBeenCalledWith("term-1");
  });

  it("does not write to a disposed terminal if a pty event arrives after the pane is torn down", async () => {
    vi.mocked(commands.ptySpawn).mockResolvedValue("term-1");
    let capturedCallback: ((event: { type: string; data?: string }) => void) | undefined;
    vi.mocked(commands.ptySubscribe).mockImplementation((_id, cb) => {
      capturedCallback = cb as typeof capturedCallback;
      return Promise.resolve();
    });

    const { unmount } = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
    await flushMicrotasks(); // let spawn + subscribe resolve

    unmount();

    expect(() => capturedCallback?.({ type: "data", data: "aGVsbG8=" })).not.toThrow();
  });
});
