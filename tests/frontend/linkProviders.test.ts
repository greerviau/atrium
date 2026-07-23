import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Terminal, ILink, ILinkProvider } from "@xterm/xterm";
import { registerLinkProviders } from "../../src/lib/terminal/linkProviders";
import { shellOpenExternal, fsResolveCandidates } from "../../src/lib/ipc/commands";
import { showErrorToast } from "../../src/lib/stores/errorToast";
import { openFile } from "../../src/lib/stores/tabs";

vi.mock("../../src/lib/ipc/commands", () => ({
  shellOpenExternal: vi.fn(),
  fsResolveCandidates: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../src/lib/stores/errorToast", () => ({
  showErrorToast: vi.fn(),
  describeError: (err: unknown): string => (err instanceof Error ? err.message : "an unknown error"),
}));

vi.mock("../../src/lib/stores/tabs", () => ({
  openFile: vi.fn(),
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
    vi.mocked(openFile).mockReset();
    vi.mocked(showErrorToast).mockReset();
  });

  it("opens the resolved file with parsed line/col on a modifier click", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue(["/repo/src/lib/foo.ts"]);
    vi.mocked(openFile).mockResolvedValue(undefined);
    const { terminal, providers } = fakeTerminal("error at src/lib/foo.ts:42:7");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[1]);
    link.activate(modifierClick(), link.text);

    await new Promise((r) => setTimeout(r, 0));
    expect(openFile).toHaveBeenCalledWith("/repo/src/lib/foo.ts", { line: 42, col: 7 });
  });

  it("does not call openFile on a plain click without a modifier", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue(["/repo/src/lib/foo.ts"]);
    const { terminal, providers } = fakeTerminal("error at src/lib/foo.ts:42:7");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[1]);
    link.activate(plainClick(), link.text);

    await new Promise((r) => setTimeout(r, 0));
    expect(openFile).not.toHaveBeenCalled();
  });

  it("calls showErrorToast when openFile rejects", async () => {
    vi.mocked(fsResolveCandidates).mockResolvedValue(["/repo/src/lib/foo.ts"]);
    vi.mocked(openFile).mockRejectedValue(new Error("ENOENT: no such file or directory"));
    const { terminal, providers } = fakeTerminal("error at src/lib/foo.ts:42:7");
    registerLinkProviders(terminal, "local", "/repo");

    const link = await getFirstLink(providers[1]);
    link.activate(modifierClick(), link.text);

    await new Promise((r) => setTimeout(r, 0));
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
  });
});
