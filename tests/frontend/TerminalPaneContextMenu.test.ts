import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { Terminal } from "@xterm/xterm";
import TerminalPane from "../../src/lib/terminal/TerminalPane.svelte";
import * as commands from "../../src/lib/ipc/commands";
import * as clipboardManager from "@tauri-apps/plugin-clipboard-manager";

// Only the Tauri IPC boundary (pty + clipboard) is mocked, matching
// terminalOsDrop.test.ts's own convention — everything else in the
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
  // after the first — matches terminalOsDrop.test.ts's own convention.
  vi.clearAllMocks();
});

// The mouse-reporting tests need a handle on the Terminal the pane built for
// itself, so they can feed it the DECSET sequence a mouse-driven TUI emits and
// let xterm's own parser produce the `modes.mouseTrackingMode` the pane reads.
// `open()` is the one lifecycle point that runs with `this` bound to that
// instance; the spy records it and calls straight through.
const openedTerminals: Terminal[] = [];
const realOpen = Terminal.prototype.open;
vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, parent: HTMLElement) {
  openedTerminals.push(this);
  realOpen.call(this, parent);
});

// DECSET/DECRST 1000 (Send Mouse X & Y on button press and release) — the
// mode herdr, vim, htop and tmux turn on to take over the mouse.
const ENABLE_MOUSE_REPORTING = "\x1b[?1000h";
const DISABLE_MOUSE_REPORTING = "\x1b[?1000l";

async function renderReadyTerminalPane() {
  openedTerminals.length = 0;
  const rendered = render(TerminalPane, { cwd: "/workspace", workspaceId: "local" });
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the async ptySpawn() in onMount resolve
  return { ...rendered, terminal: openedTerminals.at(-1)! };
}

// xterm parses writes off a queue, so the write callback — not a bare tick —
// is what guarantees the mode is in effect before the click under test.
async function writeToTerminal(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

async function openMenu(container: HTMLElement, init: MouseEventInit = {}): Promise<void> {
  await fireEvent.contextMenu(container.querySelector(".terminal-pane")!, { button: 2, ...init });
}

describe("TerminalPane: context menu", () => {
  it("opens the two-group menu: Clipboard, then Terminal", async () => {
    const { container } = await renderReadyTerminalPane();

    await openMenu(container);

    const items = [...container.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) =>
      el.getAttribute("role") === "separator" ? "—" : el.textContent,
    );
    expect(items).toEqual(["Copy⌘C", "Paste⌘V", "—", "Select All⌘A", "Clear"]);
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

describe("TerminalPane: right-click while a program owns the mouse", () => {
  it("leaves the right-click to the program once it enables mouse reporting", async () => {
    const { container, terminal } = await renderReadyTerminalPane();

    await writeToTerminal(terminal, ENABLE_MOUSE_REPORTING);
    await openMenu(container);

    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("still opens on Shift+right-click while mouse reporting is on", async () => {
    const { container, terminal } = await renderReadyTerminalPane();

    await writeToTerminal(terminal, ENABLE_MOUSE_REPORTING);
    await openMenu(container, { shiftKey: true });

    expect(container.querySelector(".context-menu")).not.toBeNull();
  });

  it("opens again once the program turns mouse reporting back off", async () => {
    const { container, terminal } = await renderReadyTerminalPane();

    await writeToTerminal(terminal, ENABLE_MOUSE_REPORTING);
    await writeToTerminal(terminal, DISABLE_MOUSE_REPORTING);
    await openMenu(container);

    expect(container.querySelector(".context-menu")).not.toBeNull();
  });

  it("keeps a Shift+right-click away from xterm, so the program is never told about it", async () => {
    const { container, terminal } = await renderReadyTerminalPane();
    await writeToTerminal(terminal, ENABLE_MOUSE_REPORTING);
    // xterm binds its mouse-reporting listener on the element it owns inside
    // the pane, so a listener there stands in for "xterm saw this click".
    const xtermElement = container.querySelector(".xterm")!;
    const seenByXterm = vi.fn();
    xtermElement.addEventListener("mousedown", seenByXterm);

    await fireEvent.mouseDown(xtermElement, { button: 2, shiftKey: true });
    expect(seenByXterm).not.toHaveBeenCalled();

    await fireEvent.mouseDown(xtermElement, { button: 2 });
    expect(seenByXterm).toHaveBeenCalledTimes(1);
  });

  it("treats macOS Ctrl+left-click as the same right-click gesture", async () => {
    const { container, terminal } = await renderReadyTerminalPane();
    await writeToTerminal(terminal, ENABLE_MOUSE_REPORTING);
    const xtermElement = container.querySelector(".xterm")!;
    const seenByXterm = vi.fn();
    xtermElement.addEventListener("mousedown", seenByXterm);

    // Ctrl+left-click alone is the program's to handle, like a bare right-click.
    await openMenu(container, { button: 0, ctrlKey: true });
    expect(container.querySelector(".context-menu")).toBeNull();

    // Adding Shift claims it for this pane, and keeps it from xterm.
    await fireEvent.mouseDown(xtermElement, { button: 0, ctrlKey: true, shiftKey: true });
    await openMenu(container, { button: 0, ctrlKey: true, shiftKey: true });
    expect(container.querySelector(".context-menu")).not.toBeNull();
    expect(seenByXterm).not.toHaveBeenCalled();
  });
});
