import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

export interface TerminalRuntime {
  terminal: Terminal;
  fitAddon: FitAddon;
  terminalId: string | undefined;
  owner: symbol | null;
  onExit?: (elapsedMs: number) => void;
  onTitleChange?: (title: string) => void;
  disposeExtras?: () => void;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const runtimes = new Map<string, TerminalRuntime>();

export function registerTerminalRuntime(sessionId: string, runtime: TerminalRuntime): void {
  runtimes.set(sessionId, runtime);
}

export function getTerminalRuntime(sessionId: string | undefined): TerminalRuntime | undefined {
  return sessionId ? runtimes.get(sessionId) : undefined;
}

export function claimTerminalRuntime(sessionId: string, owner: symbol): TerminalRuntime | undefined {
  const runtime = runtimes.get(sessionId);
  if (!runtime) return undefined;
  if (runtime.cleanupTimer !== undefined) {
    clearTimeout(runtime.cleanupTimer);
    runtime.cleanupTimer = undefined;
  }
  runtime.owner = owner;
  return runtime;
}

/** Keeps a terminal alive across the synchronous unmount/remount caused by moving it between panels. */
export function releaseTerminalRuntime(sessionId: string, owner: symbol, dispose: () => void): void {
  const runtime = runtimes.get(sessionId);
  if (!runtime || runtime.owner !== owner) return;
  runtime.owner = null;
  runtime.disposeExtras ??= dispose;
  runtime.cleanupTimer = setTimeout(() => {
    if (runtime.owner !== null || runtimes.get(sessionId) !== runtime) return;
    runtimes.delete(sessionId);
    runtime.disposeExtras?.();
    runtime.terminal.dispose();
  }, 0);
}

export function removeTerminalRuntime(sessionId: string, runtime: TerminalRuntime): void {
  if (runtimes.get(sessionId) === runtime) runtimes.delete(sessionId);
}
