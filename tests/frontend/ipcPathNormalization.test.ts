import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import * as commands from "../../src/lib/ipc/commands";
import { onFsChanged, onDockOpenPath, onDragDropEvent } from "../../src/lib/ipc/events";

/**
 * Boundary coverage for the plan's §4.2 tables: every path-typed field
 * named there comes back canonical from `commands.ts`/`events.ts`, given
 * a raw native-Windows-separator (spelling A) or verbatim (spelling B)
 * payload — the shape Rust actually sends. Mocks `invoke`/`listen` rather
 * than `commands.ts`/`events.ts` themselves, so this exercises the real
 * normalization code, not a stand-in for it.
 */

vi.mock("@tauri-apps/api/core", () => {
  class FakeChannel<T> {
    onmessage: ((event: T) => void) | undefined;
  }
  return { invoke: vi.fn(), Channel: FakeChannel };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const getCurrentWebviewMock = vi.mocked(getCurrentWebview);

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  getCurrentWebviewMock.mockReset();
});

describe("commands.ts normalizes every path-typed field named in the plan's boundary table", () => {
  it("workspaceOpenFolderDialog", async () => {
    invokeMock.mockResolvedValueOnce("C:\\ws");
    expect(await commands.workspaceOpenFolderDialog()).toBe("C:/ws");
  });

  it("workspaceOpenFolderDialog passes a null result through untouched", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await commands.workspaceOpenFolderDialog()).toBeNull();
  });

  it("workspaceGetRecents normalizes RecentProject.path", async () => {
    invokeMock.mockResolvedValueOnce([{ path: "C:\\ws\\proj", name: "proj", lastOpenedAt: 1 }]);
    const recents = await commands.workspaceGetRecents();
    expect(recents[0].path).toBe("C:/ws/proj");
  });

  it("workspaceTakePendingOpen normalizes every element", async () => {
    invokeMock.mockResolvedValueOnce(["C:\\ws\\a.md", "\\\\?\\C:\\ws\\b.md"]);
    expect(await commands.workspaceTakePendingOpen()).toEqual(["C:/ws/a.md", "C:/ws/b.md"]);
  });

  it("gitGetContext normalizes repositoryRoot, worktreePath, worktrees[].path, and branches[].worktreePath", async () => {
    invokeMock.mockResolvedValueOnce({
      repositoryRoot: "C:\\repo",
      worktreePath: "C:\\repo\\wt",
      branch: "main",
      head: "abc123",
      worktrees: [{ path: "C:\\repo\\wt2", branch: "feature", head: "def456", isCurrent: false }],
      branches: [
        { name: "main", worktreePath: "C:\\repo\\wt", isCurrent: true },
        { name: "detached", worktreePath: null, isCurrent: false },
      ],
    });

    const context = await commands.gitGetContext("C:\\repo");

    expect(context?.repositoryRoot).toBe("C:/repo");
    expect(context?.worktreePath).toBe("C:/repo/wt");
    expect(context?.worktrees[0].path).toBe("C:/repo/wt2");
    expect(context?.branches[0].worktreePath).toBe("C:/repo/wt");
    expect(context?.branches[1].worktreePath).toBeNull();
  });

  it("gitGetContext passes a null result through untouched", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await commands.gitGetContext("C:\\repo")).toBeNull();
  });

  it("fsListDir normalizes DirEntry.path", async () => {
    invokeMock.mockResolvedValueOnce([{ name: "a.ts", path: "C:\\ws\\a.ts", isDir: false, isSymlink: false }]);
    const entries = await commands.fsListDir("local", "C:\\ws");
    expect(entries[0].path).toBe("C:/ws/a.ts");
  });

  it("fsResolveCandidates normalizes ResolvedPath.path and passes a null element through", async () => {
    invokeMock.mockResolvedValueOnce([{ path: "C:\\ws\\a.ts", external: false }, null]);
    const resolved = await commands.fsResolveCandidates("local", []);
    expect(resolved[0]?.path).toBe("C:/ws/a.ts");
    expect(resolved[1]).toBeNull();
  });

  it("fsAuthorizeTerminalLink normalizes AuthorizedLink.path, including a verbatim (spelling B) form", async () => {
    invokeMock.mockResolvedValueOnce({ path: "\\\\?\\C:\\ws\\a.ts", workspaceId: "local" });
    const link = await commands.fsAuthorizeTerminalLink("local", { raw: "a.ts", cwdHint: "" });
    expect(link.path).toBe("C:/ws/a.ts");
  });

  it("searchWorkspace normalizes SearchMatch.path", async () => {
    invokeMock.mockResolvedValueOnce({
      matches: [{ path: "C:\\ws\\a.ts", line: 1, column: 0, lineText: "x", matchStart: 0, matchEnd: 1 }],
      truncated: false,
    });
    const results = await commands.searchWorkspace("local", "x", { caseSensitive: false, regex: false });
    expect(results.matches[0].path).toBe("C:/ws/a.ts");
  });

  it("findFiles normalizes FileMatch.path but leaves displayPath untouched", async () => {
    invokeMock.mockResolvedValueOnce({
      matches: [{ path: "C:\\ws\\a.ts", displayPath: "a.ts", score: 1, matchIndices: [] }],
      truncated: false,
    });
    const results = await commands.findFiles("local", "a");
    expect(results.matches[0].path).toBe("C:/ws/a.ts");
    expect(results.matches[0].displayPath).toBe("a.ts");
  });

  it("ptySubscribe normalizes the title variant's cwd, leaving data/exit variants untouched", async () => {
    const onEvent = vi.fn();
    invokeMock.mockResolvedValueOnce(undefined);
    await commands.ptySubscribe("term1", onEvent);

    const call = invokeMock.mock.calls.find(([cmd]) => cmd === "pty_subscribe");
    expect(call).toBeDefined();
    const channel = (call![1] as { channel: { onmessage?: (e: unknown) => void } }).channel;

    channel.onmessage!({ type: "title", cwd: "C:\\ws", program: null });
    expect(onEvent).toHaveBeenCalledWith({ type: "title", cwd: "C:/ws", program: null });

    channel.onmessage!({ type: "data", data: "hello" });
    expect(onEvent).toHaveBeenCalledWith({ type: "data", data: "hello" });
  });
});

describe("events.ts normalizes every path-typed field named in the plan's boundary table", () => {
  it("onFsChanged normalizes path and fromPath", async () => {
    let handler: ((event: unknown) => void) | undefined;
    listenMock.mockImplementation((_id, h) => {
      handler = h as (event: unknown) => void;
      return Promise.resolve(() => {});
    });

    const received = vi.fn();
    await onFsChanged(received);
    handler!({ payload: { workspaceId: "local", path: "C:\\ws\\a.ts", kind: "rename", fromPath: "C:\\ws\\b.ts" } });

    expect(received).toHaveBeenCalledWith({
      workspaceId: "local",
      path: "C:/ws/a.ts",
      kind: "rename",
      fromPath: "C:/ws/b.ts",
    });
  });

  it("onFsChanged leaves a missing fromPath as undefined, not a normalized empty string", async () => {
    let handler: ((event: unknown) => void) | undefined;
    listenMock.mockImplementation((_id, h) => {
      handler = h as (event: unknown) => void;
      return Promise.resolve(() => {});
    });

    const received = vi.fn();
    await onFsChanged(received);
    handler!({ payload: { workspaceId: "local", path: "C:\\ws\\a.ts", kind: "create" } });

    expect(received).toHaveBeenCalledWith({ workspaceId: "local", path: "C:/ws/a.ts", kind: "create", fromPath: undefined });
  });

  it("onDockOpenPath normalizes the payload string", async () => {
    let handler: ((event: unknown) => void) | undefined;
    listenMock.mockImplementation((_id, h) => {
      handler = h as (event: unknown) => void;
      return Promise.resolve(() => {});
    });

    const received = vi.fn();
    await onDockOpenPath(received);
    handler!({ payload: "C:\\ws\\a.ts" });

    expect(received).toHaveBeenCalledWith("C:/ws/a.ts");
  });

  it("onDragDropEvent normalizes event.paths on the drop variant", async () => {
    let handler: ((event: DragDropEvent) => void) | undefined;
    getCurrentWebviewMock.mockReturnValue({
      onDragDropEvent: (h: (event: { payload: DragDropEvent }) => void) => {
        handler = (payload) => h({ payload });
        return Promise.resolve(() => {});
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const received = vi.fn();
    await onDragDropEvent(received);
    handler!({ type: "drop", paths: ["C:\\ws\\a.ts", "C:\\ws\\b.ts"], position: { x: 0, y: 0 } as never });

    expect(received).toHaveBeenCalledWith({
      type: "drop",
      paths: ["C:/ws/a.ts", "C:/ws/b.ts"],
      position: { x: 0, y: 0 },
    });
  });

  it("onDragDropEvent leaves the enter variant's paths untouched (not read downstream, per the plan)", async () => {
    let handler: ((event: DragDropEvent) => void) | undefined;
    getCurrentWebviewMock.mockReturnValue({
      onDragDropEvent: (h: (event: { payload: DragDropEvent }) => void) => {
        handler = (payload) => h({ payload });
        return Promise.resolve(() => {});
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const received = vi.fn();
    await onDragDropEvent(received);
    handler!({ type: "enter", paths: ["C:\\ws\\a.ts"], position: { x: 0, y: 0 } as never });

    expect(received).toHaveBeenCalledWith({ type: "enter", paths: ["C:\\ws\\a.ts"], position: { x: 0, y: 0 } });
  });
});
