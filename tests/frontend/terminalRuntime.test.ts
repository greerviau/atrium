import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimTerminalRuntime,
  getTerminalRuntime,
  registerTerminalRuntime,
  releaseTerminalRuntime,
  type TerminalRuntime,
} from "../../src/lib/terminal/terminalRuntime";

function runtime(sessionId: string): { value: TerminalRuntime; terminal: { dispose: ReturnType<typeof vi.fn> } } {
  const terminal = { dispose: vi.fn() };
  const value = {
    terminal,
    fitAddon: {},
    terminalId: `${sessionId}-pty`,
    owner: null,
  } as unknown as TerminalRuntime;
  return { value, terminal };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal tab runtime handoff", () => {
  it("keeps the xterm runtime alive when a tab remounts in another pane", () => {
    vi.useFakeTimers();
    const sessionId = "session-handoff";
    const oldOwner = Symbol();
    const newOwner = Symbol();
    const created = runtime(sessionId);
    registerTerminalRuntime(sessionId, created.value);
    expect(claimTerminalRuntime(sessionId, oldOwner)).toBe(created.value);

    releaseTerminalRuntime(sessionId, oldOwner, vi.fn());
    expect(claimTerminalRuntime(sessionId, newOwner)).toBe(created.value);
    vi.runAllTimers();

    expect(created.terminal.dispose).not.toHaveBeenCalled();
    expect(getTerminalRuntime(sessionId)?.owner).toBe(newOwner);
  });

  it("disposes the runtime when no replacement claims it", () => {
    vi.useFakeTimers();
    const sessionId = "session-close";
    const owner = Symbol();
    const created = runtime(sessionId);
    registerTerminalRuntime(sessionId, created.value);
    claimTerminalRuntime(sessionId, owner);

    releaseTerminalRuntime(sessionId, owner, vi.fn());
    vi.runAllTimers();

    expect(created.terminal.dispose).toHaveBeenCalledOnce();
    expect(getTerminalRuntime(sessionId)).toBeUndefined();
  });
});
