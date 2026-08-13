import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { handleLinkClick } from "../../src/lib/editor/markdown/widgets";
import { openFile, openFileReportingErrors, tabsState } from "../../src/lib/stores/tabs";
import { workspace } from "../../src/lib/stores/workspace";
import { fsAuthorizeTerminalLink } from "../../src/lib/ipc/commands";
import * as commands from "../../src/lib/ipc/commands";

/**
 * Issue #464's core acceptance criterion: a markdown link to an
 * already-open file must focus the existing tab, not open a duplicate with
 * independent, desynchronized dirty state. Uses the real `openFile`
 * (`tabs.ts`) and the real `handleLinkClick`/`resolveRelative`
 * (`widgets.ts`/`path.ts`) rather than mocking either away, so this
 * exercises the actual convergence the fix relies on: `resolveRelative`'s
 * result and the already-open tab's `path` must be the identical string for
 * `openFile`'s raw `t.path === path` check to find it.
 */

vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    fsReadFile: vi.fn().mockResolvedValue("content"),
    fsCheckFileAccess: vi.fn().mockResolvedValue(undefined),
  };
});

// `fsAuthorizeTerminalLink` is left real (only `fsReadFile`/`fsCheckFileAccess`
// are stubbed above), so its own boundary normalization runs for real; this
// mocks one level lower, the `invoke` call underneath it.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  tabsState.set({ tabs: [], activeTabPath: null });
  workspace.set({ id: "local", root: "C:/ws" });
  vi.mocked(commands.fsReadFile).mockClear();
  invokeMock.mockReset();
});

describe("a markdown link to an already-open file, under a Windows root", () => {
  it("focuses the existing tab instead of opening a duplicate", async () => {
    await openFile("C:/ws/a.md");
    await openFile("C:/ws/b.md");
    expect(get(tabsState).tabs).toHaveLength(2);

    handleLinkClick("b.md", "C:/ws/a.md");
    await vi.waitFor(() => {
      expect(get(tabsState).activeTabPath).toBe("C:/ws/b.md");
    });

    expect(get(tabsState).tabs).toHaveLength(2); // not 3
    expect(commands.fsReadFile).toHaveBeenCalledTimes(2); // a.md, b.md — never re-read for the click
  });

  it("still focuses the existing tab when the link target resolves through a native-Windows-separator document path", async () => {
    await openFile("C:/ws/sub/a.md");
    await openFile("C:/ws/sub/b.md");
    expect(get(tabsState).tabs).toHaveLength(2);

    // documentPath arriving in native form (e.g. from a tab whose own path
    // predates full boundary coverage somewhere) must still resolve to the
    // same canonical target the open tab uses.
    handleLinkClick("b.md", "C:\\ws\\sub\\a.md");
    await vi.waitFor(() => {
      expect(get(tabsState).activeTabPath).toBe("C:/ws/sub/b.md");
    });

    expect(get(tabsState).tabs).toHaveLength(2);
  });

  it("a terminal link resolving through a spelling-B (verbatim) path also focuses the existing tab", async () => {
    await openFile("C:/ws/b.md");
    expect(get(tabsState).tabs).toHaveLength(1);

    invokeMock.mockResolvedValueOnce({ path: "\\\\?\\C:\\ws\\b.md", workspaceId: "local" });
    const authorized = await fsAuthorizeTerminalLink("local", { raw: "b.md", cwdHint: "C:/ws" });
    expect(authorized.path).toBe("C:/ws/b.md"); // the boundary already folded the verbatim prefix

    openFileReportingErrors(authorized.path, undefined, authorized.workspaceId);
    await vi.waitFor(() => {
      expect(get(tabsState).activeTabPath).toBe("C:/ws/b.md");
    });

    expect(get(tabsState).tabs).toHaveLength(1); // not 2
  });
});
