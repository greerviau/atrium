import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { Terminal } from "@xterm/xterm";
import TerminalPane from "../../src/lib/terminal/TerminalPane.svelte";
import * as commands from "../../src/lib/ipc/commands";
import * as clipboardManager from "@tauri-apps/plugin-clipboard-manager";

// Only the Tauri IPC boundary (pty + clipboard) is mocked, matching
// terminalDragDrop.test.ts's own convention — everything else in the
// component (xterm.js, the context-menu wiring) runs unmodified.
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

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
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
  // `vi.restoreAllMocks()` would also wipe the `mockResolvedValue`s set up
  // in the `vi.mock` factories above (they're plain `vi.fn()`s, not
  // `vi.spyOn` spies), breaking `ptySpawn`/`ptySubscribe` for every test
  // after the first — matches terminalDragDrop.test.ts's own convention.
  vi.clearAllMocks();
});

async function renderReadyTerminalPane() {
  const rendered = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the async ptySpawn() in onMount resolve
  return rendered;
}

async function openMenu(container: HTMLElement): Promise<void> {
  await fireEvent.contextMenu(container.querySelector(".terminal-pane")!);
}

describe("TerminalPane: context menu", () => {
  it("opens the two-group menu: Clipboard, then Terminal", async () => {
    const { container } = await renderReadyTerminalPane();

    await openMenu(container);

    const items = [...container.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) =>
      el.getAttribute("role") === "separator" ? "—" : el.textContent,
    );
    expect(items).toEqual(["Copy", "Paste", "—", "Select All", "Clear"]);
  });

  it("disables Copy when there is no selection", async () => {
    vi.spyOn(Terminal.prototype, "hasSelection").mockReturnValue(false);
    const { container, findByText } = await renderReadyTerminalPane();

    await openMenu(container);

    expect(((await findByText("Copy")) as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Copy once there is a selection, and writes the selected text to the clipboard", async () => {
    vi.spyOn(Terminal.prototype, "hasSelection").mockReturnValue(true);
    vi.spyOn(Terminal.prototype, "getSelection").mockReturnValue("hello world");
    const { container, findByText } = await renderReadyTerminalPane();

    await openMenu(container);
    const copyButton = (await findByText("Copy")) as HTMLButtonElement;
    expect(copyButton.disabled).toBe(false);

    await fireEvent.click(copyButton);

    expect(clipboardManager.writeText).toHaveBeenCalledWith("hello world");
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("calls selectAll on the terminal instance and closes the menu", async () => {
    const selectAllSpy = vi.spyOn(Terminal.prototype, "selectAll");
    const { container, findByText } = await renderReadyTerminalPane();

    await openMenu(container);
    await fireEvent.click(await findByText("Select All"));

    expect(selectAllSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("calls clear on the terminal instance and closes the menu", async () => {
    const clearSpy = vi.spyOn(Terminal.prototype, "clear");
    const { container, findByText } = await renderReadyTerminalPane();

    await openMenu(container);
    await fireEvent.click(await findByText("Clear"));

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("reads the clipboard and pastes its text into the pty on Paste", async () => {
    vi.mocked(clipboardManager.readText).mockResolvedValue("pasted text");
    const { container, findByText } = await renderReadyTerminalPane();

    await openMenu(container);
    await fireEvent.click(await findByText("Paste"));

    await vi.waitFor(() => {
      expect(commands.ptyWrite).toHaveBeenCalledWith("term-1", "pasted text");
    });
  });

  it("is a no-op when the clipboard has no text", async () => {
    vi.mocked(clipboardManager.readText).mockResolvedValue("");
    const { container, findByText } = await renderReadyTerminalPane();

    await openMenu(container);
    await fireEvent.click(await findByText("Paste"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands.ptyWrite).not.toHaveBeenCalled();
  });

  it("closes the menu on an outside click", async () => {
    const { container } = await renderReadyTerminalPane();

    await openMenu(container);
    expect(container.querySelector(".context-menu")).not.toBeNull();

    await fireEvent.click(document.body);
    expect(container.querySelector(".context-menu")).toBeNull();
  });
});
