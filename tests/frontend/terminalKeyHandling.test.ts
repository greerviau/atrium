import { describe, it, expect, beforeEach, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { handleTerminalKeyEvent } from "../../src/lib/terminal/terminalKeyHandling";

// jsdom has no matchMedia implementation, and @xterm/xterm's CoreBrowserService
// calls it during terminal.open() setup.
beforeEach(() => {
  window.matchMedia ??= ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});

function setupTerminal(isMacPlatform: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const terminal = new Terminal({ cols: 80, rows: 24 });
  const writeToPty = vi.fn<(data: string) => void>();
  terminal.open(container);
  terminal.attachCustomKeyEventHandler((event) => handleTerminalKeyEvent(event, { isMacPlatform, writeToPty }));

  const received: string[] = [];
  terminal.onData((data) => received.push(data));

  return { terminal, writeToPty, received };
}

// xterm.js's own keyboard encoding (`evaluateKeyboardEvent` in
// `@xterm/xterm`'s `Keyboard.ts`) switches on the legacy `event.keyCode`,
// not `event.key` — real browsers still populate it on a physical keypress,
// so a synthetic event needs it set explicitly for xterm's default encoding
// to recognize the key at all.
const KEY_CODES: Record<string, number> = { Enter: 13, b: 66, r: 82 };

function dispatchKeydown(
  terminal: Terminal,
  init: Pick<KeyboardEventInit, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">,
) {
  const textarea = terminal.textarea;
  if (!textarea) throw new Error("terminal has no focus textarea");
  const event = new KeyboardEvent("keydown", {
    key: init.key,
    keyCode: KEY_CODES[init.key as string],
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  textarea.dispatchEvent(event);
}

describe("handleTerminalKeyEvent wired into a real xterm.js Terminal", () => {
  it("remaps a bare Shift+Enter to ESC CR written directly to the pty, with no plain CR emitted", () => {
    const { terminal, writeToPty, received } = setupTerminal(false);

    dispatchKeydown(terminal, { key: "Enter", shiftKey: true });

    expect(writeToPty).toHaveBeenCalledTimes(1);
    expect(writeToPty).toHaveBeenCalledWith("\x1b\r");
    expect(received.join("")).toBe("");
  });

  it("leaves plain Enter to xterm's own default encoding (CR)", () => {
    const { terminal, writeToPty, received } = setupTerminal(false);

    dispatchKeydown(terminal, { key: "Enter" });

    expect(writeToPty).not.toHaveBeenCalled();
    expect(received.join("")).toBe("\r");
  });

  it("leaves Alt+Enter to xterm's own existing ESC CR encoding, unaffected", () => {
    const { terminal, writeToPty, received } = setupTerminal(false);

    dispatchKeydown(terminal, { key: "Enter", altKey: true });

    expect(writeToPty).not.toHaveBeenCalled();
    expect(received.join("")).toBe("\x1b\r");
  });

  it("falls through to xterm's default encoding for Shift+Alt+Enter, since altKey excludes the new branch", () => {
    const { terminal, writeToPty, received } = setupTerminal(false);

    dispatchKeydown(terminal, { key: "Enter", shiftKey: true, altKey: true });

    expect(writeToPty).not.toHaveBeenCalled();
    expect(received.join("")).toBe("\x1b\r");
  });

  it("still swallows the Ctrl+B toggle accelerator (non-mac guard)", () => {
    const { terminal, writeToPty, received } = setupTerminal(false);

    dispatchKeydown(terminal, { key: "b", ctrlKey: true });

    expect(writeToPty).not.toHaveBeenCalled();
    expect(received.join("")).toBe("");
  });

  it("still swallows the Ctrl+R toggle accelerator (non-mac guard)", () => {
    const { terminal, writeToPty, received } = setupTerminal(false);

    dispatchKeydown(terminal, { key: "r", ctrlKey: true });

    expect(writeToPty).not.toHaveBeenCalled();
    expect(received.join("")).toBe("");
  });

  it("does not swallow Ctrl+B on macOS, where CmdOrCtrl resolves to Cmd instead", () => {
    const { terminal, writeToPty, received } = setupTerminal(true);

    dispatchKeydown(terminal, { key: "b", ctrlKey: true });

    expect(writeToPty).not.toHaveBeenCalled();
    expect(received.join("")).toBe("\x02");
  });

  it("swallows Cmd+B on macOS", () => {
    const { terminal, writeToPty, received } = setupTerminal(true);

    dispatchKeydown(terminal, { key: "b", metaKey: true });

    expect(writeToPty).not.toHaveBeenCalled();
    expect(received.join("")).toBe("");
  });

  it("remaps Shift+Enter on macOS the same as elsewhere", () => {
    const { terminal, writeToPty, received } = setupTerminal(true);

    dispatchKeydown(terminal, { key: "Enter", shiftKey: true });

    expect(writeToPty).toHaveBeenCalledTimes(1);
    expect(writeToPty).toHaveBeenCalledWith("\x1b\r");
    expect(received.join("")).toBe("");
  });

  it("prevents the browser's native default action for Shift+Enter, same as xterm's own cancel() does for plain Enter", () => {
    const { terminal } = setupTerminal(false);
    const textarea = terminal.textarea!;

    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: KEY_CODES.Enter,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(shiftEnter);
    // Returning `false` from attachCustomKeyEventHandler only tells xterm's
    // own _keyDown to skip its default encoding; it does not itself call
    // preventDefault, so the handler must call it directly or the browser's
    // native "insert a newline" action for a textarea still runs.
    expect(shiftEnter.defaultPrevented).toBe(true);

    const plainEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: KEY_CODES.Enter,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(plainEnter);
    expect(plainEnter.defaultPrevented).toBe(true);
  });
});

describe("handleTerminalKeyEvent as a pure function", () => {
  it("only writes to the pty and returns false on keydown for Shift+Enter, not on keyup", () => {
    const writeToPty = vi.fn<(data: string) => void>();
    const base: KeyboardEventInit = {
      key: "Enter",
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    };

    const keydownResult = handleTerminalKeyEvent(new KeyboardEvent("keydown", base), {
      isMacPlatform: false,
      writeToPty,
    });
    expect(keydownResult).toBe(false);
    expect(writeToPty).toHaveBeenCalledTimes(1);
    expect(writeToPty).toHaveBeenCalledWith("\x1b\r");

    writeToPty.mockClear();
    const keyupResult = handleTerminalKeyEvent(new KeyboardEvent("keyup", base), {
      isMacPlatform: false,
      writeToPty,
    });
    expect(keyupResult).toBe(true);
    expect(writeToPty).not.toHaveBeenCalled();
  });
});
