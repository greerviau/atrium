import { describe, it, expect, beforeEach, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import type { ILink, ILinkProvider, IMarker } from "@xterm/xterm";
import { registerLinkProviders } from "../../src/lib/terminal/linkProviders";
import {
  shellOpenExternal,
  fsResolveCandidates,
  fsAuthorizeTerminalLink,
  type ResolvedPath,
} from "../../src/lib/ipc/commands";
import { showErrorToast } from "../../src/lib/stores/errorToast";
import { openFileReportingErrors } from "../../src/lib/stores/tabs";

vi.mock("../../src/lib/ipc/commands", () => ({
  shellOpenExternal: vi.fn(),
  fsResolveCandidates: vi.fn(() => Promise.resolve([])),
  fsAuthorizeTerminalLink: vi.fn(),
}));

/** Shorthand for an in-workspace `fsResolveCandidates` result. */
function inWorkspace(path: string): ResolvedPath {
  return { path, external: false };
}

vi.mock("../../src/lib/stores/errorToast", () => ({
  showErrorToast: vi.fn(),
  describeError: (err: unknown): string => (err instanceof Error ? err.message : "an unknown error"),
}));

vi.mock("../../src/lib/stores/tabs", () => ({
  openFileReportingErrors: vi.fn(),
}));

const modifierClick = (): MouseEvent => new MouseEvent("click", { metaKey: true });
const plainClick = (): MouseEvent => new MouseEvent("click");

/**
 * `PrLinkProvider` isn't exported directly — `registerLinkProviders` is the
 * module's only public entry point, so this drives it through a minimal
 * fake `Terminal` (just enough of `registerLinkProvider`/`buffer.active.getLine`
 * for `provideLinks` to run) rather than a real xterm.js instance, which has
 * no layout in jsdom to click a link through.
 */
function fakeTerminal(lineText: string): { terminal: Terminal; providers: ILinkProvider[] } {
  const providers: ILinkProvider[] = [];
  const terminal = {
    registerLinkProvider: (provider: ILinkProvider) => {
      providers.push(provider);
      return { dispose: () => {} };
    },
    registerMarker: () => ({ line: 0, dispose: () => {}, onDispose: () => ({ dispose: () => {} }) }) as unknown as IMarker,
    buffer: {
      active: {
        getLine: () => ({
          translateToString: () => lineText,
        }),
      },
    },
  } as unknown as Terminal;
  return { terminal, providers };
}

/**
 * A `fakeTerminal` variant whose `getLine`/`registerMarker` are sensitive to
 * which buffer line is being queried/marked, needed to test that a scrollback
 * line resolves against the cwd in effect when it was printed (see
 * `FilePathLinkProvider.activate`'s MF3 test below), not the fixed single
 * line the plain `fakeTerminal` always returns.
 */
function fakeTerminalWithLines(linesByNumber: Record<number, string>): {
  terminal: Terminal;
  providers: ILinkProvider[];
  setNextMarkerLine: (line0: number) => void;
} {
  const providers: ILinkProvider[] = [];
  let nextMarkerLine = 0;
  const terminal = {
    registerLinkProvider: (provider: ILinkProvider) => {
      providers.push(provider);
      return { dispose: () => {} };
    },
    registerMarker: () =>
      ({ line: nextMarkerLine, dispose: () => {}, onDispose: () => ({ dispose: () => {} }) }) as unknown as IMarker,
    buffer: {
      active: {
        getLine: (line0: number) => ({ translateToString: () => linesByNumber[line0 + 1] ?? "" }),
      },
    },
  } as unknown as Terminal;
  return {
    terminal,
    providers,
    setNextMarkerLine: (line0) => {
      nextMarkerLine = line0;
    },
  };
}

function getFirstLink(provider: ILinkProvider): Promise<ILink> {
  return new Promise((resolve, reject) => {
    provider.provideLinks(1, (links) => {
      if (!links || links.length === 0) {
        reject(new Error("no links provided"));
        return;
      }
      resolve(links[0]);
    });
  });
}

function linksAt(provider: ILinkProvider, bufferLineNumber: number): Promise<ILink> {
  return new Promise((resolve, reject) => {
    provider.provideLinks(bufferLineNumber, (links) => {
      if (!links || links.length === 0) {
        reject(new Error(`no links provided at line ${bufferLineNumber}`));
        return;
      }
      resolve(links[0]);
    });
  });
}

describe("PrLinkProvider.activate", () => {
  beforeEach(() => {
    vi.mocked(shellOpenExternal).mockReset();
    vi.mocked(showErrorToast).mockReset();
  });

  it("calls showErrorToast when shellOpenExternal rejects", async () => {
    vi.mocked(shellOpenExternal).mockRejectedValue(new Error("failed to open URL: no application found"));
    const { terminal, providers } = fakeTerminal("Open https://github.com/greerviau/atrium/pull/99 to review");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[0]);
    link.activate(modifierClick(), link.text);
    expect(shellOpenExternal).toHaveBeenCalledWith("https://github.com/greerviau/atrium/pull/99");

    await new Promise((r) => setTimeout(r, 0));
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining("failed to open URL"));
  });

  it("does not call showErrorToast when shellOpenExternal resolves", async () => {
    vi.mocked(shellOpenExternal).mockResolvedValue(undefined);
    const { terminal, providers } = fakeTerminal("Open https://github.com/greerviau/atrium/pull/99 to review");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[0]);
    link.activate(modifierClick(), link.text);

    await new Promise((r) => setTimeout(r, 0));
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it("does not call shellOpenExternal on a plain click without a modifier", async () => {
    const { terminal, providers } = fakeTerminal("Open https://github.com/greerviau/atrium/pull/99 to review");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[0]);
    link.activate(plainClick(), link.text);

    await new Promise((r) => setTimeout(r, 0));
    expect(shellOpenExternal).not.toHaveBeenCalled();
  });

  it("calls shellOpenExternal on a ctrl+click", async () => {
    vi.mocked(shellOpenExternal).mockResolvedValue(undefined);
    const { terminal, providers } = fakeTerminal("Open https://github.com/greerviau/atrium/pull/99 to review");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[0]);
    link.activate(new MouseEvent("click", { ctrlKey: true }), link.text);

    expect(shellOpenExternal).toHaveBeenCalledWith("https://github.com/greerviau/atrium/pull/99");
  });
});

describe("FilePathLinkProvider.activate", () => {
  beforeEach(() => {
    vi.mocked(fsResolveCandidates).mockReset();
    vi.mocked(fsAuthorizeTerminalLink).mockReset();
    vi.mocked(openFileReportingErrors).mockReset();
    vi.mocked(showErrorToast).mockReset();
  });

  it("opens the resolved file with parsed line/col on a modifier click", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue([inWorkspace("/repo/src/lib/foo.ts")]);
    vi.mocked(openFileReportingErrors).mockReturnValue(undefined);
    const { terminal, providers } = fakeTerminal("error at src/lib/foo.ts:42:7");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[1]);
    link.activate(modifierClick(), link.text);

    await new Promise((r) => setTimeout(r, 0));
    expect(openFileReportingErrors).toHaveBeenCalledWith(
      "/repo/src/lib/foo.ts",
      { line: 42, col: 7 },
      undefined,
      { expandExplorerToFile: false },
    );
  });

  it("does not call openFileReportingErrors on a plain click without a modifier", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue([inWorkspace("/repo/src/lib/foo.ts")]);
    const { terminal, providers } = fakeTerminal("error at src/lib/foo.ts:42:7");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[1]);
    link.activate(plainClick(), link.text);

    await new Promise((r) => setTimeout(r, 0));
    expect(openFileReportingErrors).not.toHaveBeenCalled();
  });

  it("does not call fsAuthorizeTerminalLink for an in-workspace link (MF2 guard: no round trip, no walk on the click path)", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue([inWorkspace("/repo/src/lib/foo.ts")]);
    const { terminal, providers } = fakeTerminal("error at src/lib/foo.ts:42:7");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[1]);
    link.activate(modifierClick(), link.text);

    await new Promise((r) => setTimeout(r, 0));
    expect(fsAuthorizeTerminalLink).not.toHaveBeenCalled();
    expect(openFileReportingErrors).toHaveBeenCalledWith(
      "/repo/src/lib/foo.ts",
      { line: 42, col: 7 },
      undefined,
      { expandExplorerToFile: false },
    );
  });

  it("authorizes an external link before opening it, and opens the path/workspaceId the authorize call returned, not the ones resolution returned", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue([{ path: "/etc/resolution-time-path.txt", external: true }]);
    vi.mocked(fsAuthorizeTerminalLink).mockResolvedValue({
      path: "/etc/authorized-path.txt",
      workspaceId: "standalone",
    });
    const { terminal, providers } = fakeTerminal("cat /etc/resolution-time-path.txt");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[1]);
    link.activate(modifierClick(), link.text);

    await new Promise((r) => setTimeout(r, 0));
    expect(fsAuthorizeTerminalLink).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ raw: "/etc/resolution-time-path.txt" }),
    );
    expect(openFileReportingErrors).toHaveBeenCalledWith(
      "/etc/authorized-path.txt",
      undefined,
      "standalone",
      { expandExplorerToFile: false },
    );
  });

  it("toasts and does not open the file when fsAuthorizeTerminalLink rejects", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue([{ path: "/etc/resolution-time-path.txt", external: true }]);
    vi.mocked(fsAuthorizeTerminalLink).mockRejectedValue(new Error("terminal link no longer resolves"));
    const { terminal, providers } = fakeTerminal("cat /etc/resolution-time-path.txt");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[1]);
    link.activate(modifierClick(), link.text);

    await new Promise((r) => setTimeout(r, 0));
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining("terminal link no longer resolves"));
    expect(openFileReportingErrors).not.toHaveBeenCalled();
  });

  it("resolves the whole batch to nulls and creates no links when fsResolveCandidates rejects", async () => {
    vi.mocked(fsResolveCandidates).mockRejectedValue(new Error("IPC transport closed"));
    const { terminal, providers } = fakeTerminal("error at src/lib/foo.ts:42:7");
    registerLinkProviders(terminal, "local", "/repo");

    const links = await new Promise<ILink[] | undefined>((resolve) => {
      providers[1].provideLinks(1, resolve);
    });

    expect(links).toBeUndefined();
  });

  it("resolves an old scrollback line against the cwd in effect when it was printed, not the cwd at click time (issue #305, MF3)", async () => {
    // Line 1 was printed at the spawn cwd, before any `cd`. Line 5 was
    // printed after `cd test_project` -- the `cd`'s marker lands at (0-based)
    // line 4, i.e. at-or-before line 5 but after line 1.
    const { terminal, providers, setNextMarkerLine } = fakeTerminalWithLines({
      1: "open docs/plan.md",
      5: "open docs/plan.md",
    });
    vi.mocked(fsResolveCandidates).mockImplementation((_workspaceId, candidates) =>
      Promise.resolve(
        candidates.map((c) =>
          inWorkspace(c.cwdHint === "/repo" ? "/repo/docs/plan.md" : "/repo/project/docs/plan.md"),
        ),
      ),
    );
    const handle = registerLinkProviders(terminal, "local", "/repo");

    setNextMarkerLine(4);
    handle.setCwdHint("/repo/project");

    const oldLink = await linksAt(providers[1], 1);
    const newLink = await linksAt(providers[1], 5);

    expect(fsResolveCandidates).toHaveBeenCalledWith(
      "local",
      expect.arrayContaining([expect.objectContaining({ cwdHint: "/repo" })]),
    );
    expect(fsResolveCandidates).toHaveBeenCalledWith(
      "local",
      expect.arrayContaining([expect.objectContaining({ cwdHint: "/repo/project" })]),
    );
    expect(oldLink).toBeDefined();
    expect(newLink).toBeDefined();
  });

  it("re-resolves relative candidates against an updated cwd hint after setCwdHint, for a line at or after the cd", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue([inWorkspace("/repo/project/docs/plan.md")]);
    const { terminal, providers } = fakeTerminal("open docs/plan.md");
    const handle = registerLinkProviders(terminal, "local", "/repo");
    handle.setCwdHint("/repo/project"); // fake's registerMarker defaults to line 0, at-or-before the queried line 1

    await getFirstLink(providers[1]);

    expect(fsResolveCandidates).toHaveBeenCalledWith(
      "local",
      expect.arrayContaining([expect.objectContaining({ cwdHint: "/repo/project" })]),
    );
  });

  it("strips surrounding quotes before sending a quoted candidate for resolution", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue([inWorkspace("/repo/my file.txt")]);
    const { terminal, providers } = fakeTerminal("cat: 'my file.txt': No such file or directory");
    registerLinkProviders(terminal, "local", "/repo");

    await getFirstLink(providers[1]);

    expect(fsResolveCandidates).toHaveBeenCalledWith(
      "local",
      expect.arrayContaining([expect.objectContaining({ raw: "my file.txt" })]),
    );
  });

  it("re-anchors a still-current cwd segment whose marker is disposed out of order, instead of falling back to an older cd's cwd (N1)", async () => {
    // Simulates ESC[2J disposing a *newer* marker while an older one
    // survives: ordinary scrollback trimming always disposes oldest-first,
    // but a partial screen clear can dispose out of order. Without the
    // onDispose re-anchor, a line printed after this would wrongly resolve
    // against the older `cd`'s cwd instead of the still-current one.
    const providers: ILinkProvider[] = [];
    const markers: { line: number; disposeListeners: Array<() => void> }[] = [];
    let cursorLine = 0;
    const terminal = {
      registerLinkProvider: (provider: ILinkProvider) => {
        providers.push(provider);
        return { dispose: () => {} };
      },
      registerMarker: () => {
        const marker = { line: cursorLine, disposeListeners: [] as Array<() => void> };
        markers.push(marker);
        return {
          get line() {
            return marker.line;
          },
          dispose: () => {},
          onDispose: (cb: () => void) => {
            marker.disposeListeners.push(cb);
            return { dispose: () => {} };
          },
        } as unknown as IMarker;
      },
      buffer: {
        active: {
          getLine: (line0: number) => ({ translateToString: () => (line0 === 29 ? "open docs/plan.md" : "") }),
        },
      },
    } as unknown as Terminal;

    vi.mocked(fsResolveCandidates).mockImplementation((_workspaceId, candidates) =>
      Promise.resolve(candidates.map((c) => (c.cwdHint === "/repo/sub_b" ? inWorkspace("/repo/sub_b/docs/plan.md") : null))),
    );

    const handle = registerLinkProviders(terminal, "local", "/repo");

    cursorLine = 10;
    handle.setCwdHint("/repo/sub_a"); // markers[0], line 10

    cursorLine = 20;
    handle.setCwdHint("/repo/sub_b"); // markers[1], line 20

    // Simulate `ESC[2J` disposing the newer marker (sub_b) while the older
    // one (sub_a) survives, at a new cursor position after the clear.
    cursorLine = 25;
    markers[1].line = -1;
    markers[1].disposeListeners.forEach((cb) => cb());
    await Promise.resolve(); // let the deferred (queueMicrotask) re-anchor run

    // Line 30 (0-based 29) was printed after the clear, still under sub_b.
    const link = await linksAt(providers[1], 30);
    expect(link).toBeDefined();
    expect(fsResolveCandidates).toHaveBeenCalledWith(
      "local",
      expect.arrayContaining([expect.objectContaining({ cwdHint: "/repo/sub_b" })]),
    );
  });
});

/**
 * The hand-rolled fake `registerMarker` above reproduces the *event* of an
 * out-of-order marker disposal, but not xterm mutating and iterating its own
 * `Buffer.markers` array around the `onDispose` callback — which is exactly
 * what a synchronous re-anchor re-enters, hanging indefinitely (see the PR
 * #343 review). These drive a real `@xterm/xterm` `Terminal` through the two
 * sequences that actually dispose a marker out of order, to prove the
 * deferred (`queueMicrotask`) re-anchor doesn't hang.
 */
describe("FilePathLinkProvider — N1 real-terminal regression (screen clear / alt-screen exit)", () => {
  beforeEach(() => {
    // jsdom has no matchMedia implementation, and @xterm/xterm's
    // CoreBrowserService calls it during terminal.open() setup.
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
    vi.mocked(fsResolveCandidates).mockReset();
  });

  function realTerminal(): { terminal: Terminal; providers: ILinkProvider[] } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const terminal = new Terminal({ cols: 80, rows: 24 });
    terminal.open(container);
    const providers: ILinkProvider[] = [];
    const original = terminal.registerLinkProvider.bind(terminal);
    vi.spyOn(terminal, "registerLinkProvider").mockImplementation((provider: ILinkProvider) => {
      providers.push(provider);
      return original(provider);
    });
    return { terminal, providers };
  }

  function write(terminal: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => terminal.write(data, resolve));
  }

  it("does not hang when the real terminfo clear sequence disposes a still-current segment's marker", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue([inWorkspace("/repo/project/docs/plan.md")]);
    const { terminal, providers } = realTerminal();
    const handle = registerLinkProviders(terminal, "local", "/repo");

    await write(terminal, "line one\r\nline two\r\nline three\r\n");
    handle.setCwdHint("/repo/project"); // segment marker at the current cursor row
    await write(terminal, "more output\r\n");
    // The real terminfo `clear`/Ctrl-L sequence: cursor home, then erase-in-display.
    // eraseInDisplay(2) clears rows bottom-up while the cursor sits at row 0
    // (having just been homed), so it reaches the just-registered marker's
    // row and disposes it while it's still the newest segment.
    await write(terminal, "\x1b[H\x1b[2J");
    await write(terminal, "open docs/plan.md");

    const row = terminal.buffer.active.cursorY + terminal.buffer.active.baseY;
    const link = await linksAt(providers[1], row + 1);
    expect(link).toBeDefined();
    expect(fsResolveCandidates).toHaveBeenCalledWith(
      "local",
      expect.arrayContaining([expect.objectContaining({ cwdHint: "/repo/project" })]),
    );
  }, 2000);

  it("does not hang when leaving the alt screen disposes a still-current segment's marker", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue([inWorkspace("/repo/project/docs/plan.md")]);
    const { terminal, providers } = realTerminal();
    const handle = registerLinkProviders(terminal, "local", "/repo");

    await write(terminal, "\x1b[?1049h"); // enter the alt screen (e.g. vim opening)
    handle.setCwdHint("/repo/project"); // segment marker lands on the alt buffer
    await write(terminal, "\x1b[?1049l"); // leave the alt screen (e.g. vim quitting) -- clears all alt-buffer markers
    await write(terminal, "open docs/plan.md");

    const row = terminal.buffer.active.cursorY + terminal.buffer.active.baseY;
    const link = await linksAt(providers[1], row + 1);
    expect(link).toBeDefined();
    expect(fsResolveCandidates).toHaveBeenCalledWith(
      "local",
      expect.arrayContaining([expect.objectContaining({ cwdHint: "/repo/project" })]),
    );
  }, 2000);
});
