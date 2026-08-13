import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  tabsState,
  openFile,
  openFileReportingErrors,
  toggleMarkdownViewMode,
  markDirty,
  reconcileExternalChange,
  reloadFromDisk,
  reloadFromDiskReportingErrors,
  dismissConflict,
  requestCloseTab,
  requestSave,
  notifySaveComplete,
  notifySaveFailed,
  requestSaveReportingErrors,
  markPathDeleted,
  renameOpenTabs,
  tabRenameSignal,
  saveTab,
  type Tab,
} from "../../src/lib/stores/tabs";
import { closePrompt } from "../../src/lib/stores/closePrompt";
import { workspace } from "../../src/lib/stores/workspace";
import { getRecentFiles } from "../../src/lib/stores/recentFiles";
import { errorToast } from "../../src/lib/stores/errorToast";
import { markdownDefaultView, DEFAULT_MARKDOWN_VIEW } from "../../src/lib/stores/markdownDefaultView";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsCheckFileAccess: vi.fn(),
  fsReadFile: vi.fn(),
  fsWriteFile: vi.fn(),
  localWorkspaceId: () => "local",
  standaloneWorkspaceId: () => "standalone",
  isAppError: (value: unknown): value is { code: string; message: string } =>
    typeof value === "object" && value !== null && "code" in value && "message" in value,
}));

function markdownTab(path: string, overrides: Partial<Tab> = {}): Tab {
  return {
    path,
    workspaceId: "local",
    mode: "markdown",
    savedDoc: "",
    isDirty: false,
    hasExternalConflict: false,
    isExternal: false,
    isDeleted: false,
    viewMode: "rendered",
    ...overrides,
  };
}

function codeTab(path: string, overrides: Partial<Tab> = {}): Tab {
  return {
    path,
    workspaceId: "local",
    mode: "code",
    savedDoc: "",
    isDirty: false,
    hasExternalConflict: false,
    isExternal: false,
    isDeleted: false,
    ...overrides,
  };
}

describe("toggleMarkdownViewMode", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  it("flips rendered to source and back for a markdown tab", () => {
    tabsState.set({ tabs: [markdownTab("/notes.md")], activeTabPath: "/notes.md" });

    toggleMarkdownViewMode("/notes.md");
    expect(get(tabsState).tabs[0].viewMode).toBe("source");

    toggleMarkdownViewMode("/notes.md");
    expect(get(tabsState).tabs[0].viewMode).toBe("rendered");
  });

  it("is a no-op for a code tab", () => {
    tabsState.set({ tabs: [codeTab("/main.rs")], activeTabPath: "/main.rs" });

    toggleMarkdownViewMode("/main.rs");

    expect(get(tabsState).tabs[0].viewMode).toBeUndefined();
  });

  it("only affects the targeted tab's path, leaving other open tabs untouched", () => {
    tabsState.set({
      tabs: [markdownTab("/a.md"), markdownTab("/b.md")],
      activeTabPath: "/a.md",
    });

    toggleMarkdownViewMode("/a.md");

    const tabs = get(tabsState).tabs;
    expect(tabs.find((t) => t.path === "/a.md")?.viewMode).toBe("source");
    expect(tabs.find((t) => t.path === "/b.md")?.viewMode).toBe("rendered");
  });

  it("is a no-op for an unknown path", () => {
    tabsState.set({ tabs: [markdownTab("/a.md")], activeTabPath: "/a.md" });

    toggleMarkdownViewMode("/missing.md");

    expect(get(tabsState).tabs[0].viewMode).toBe("rendered");
  });
});

describe("openFile", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
    vi.mocked(commands.fsCheckFileAccess).mockReset().mockResolvedValue(undefined);
    vi.mocked(commands.fsReadFile).mockReset().mockResolvedValue("# Hello");
    markdownDefaultView.set(DEFAULT_MARKDOWN_VIEW);
  });

  it("opens a fresh markdown tab starting at viewMode 'rendered'", async () => {
    await openFile("/notes.md");

    const tab = get(tabsState).tabs.find((t) => t.path === "/notes.md");
    expect(tab?.mode).toBe("markdown");
    expect(tab?.viewMode).toBe("rendered");
  });

  it("opens a fresh markdown tab honoring the current markdownDefaultView setting, not a hardcoded default", async () => {
    markdownDefaultView.set("source");

    await openFile("/notes.md");

    const tab = get(tabsState).tabs.find((t) => t.path === "/notes.md");
    expect(tab?.viewMode).toBe("source");
  });

  it("leaves viewMode unset for a fresh code tab", async () => {
    await openFile("/main.rs");

    const tab = get(tabsState).tabs.find((t) => t.path === "/main.rs");
    expect(tab?.mode).toBe("code");
    expect(tab?.viewMode).toBeUndefined();
  });

  it("opens an image tab without reading binary bytes through the UTF-8 command", async () => {
    await openFile("/images/photo.PNG");

    expect(get(tabsState).tabs.find((t) => t.path === "/images/photo.PNG")).toMatchObject({
      mode: "image",
      savedDoc: "",
      isDirty: false,
    });
    expect(commands.fsCheckFileAccess).toHaveBeenCalledWith("local", "/images/photo.PNG");
    expect(commands.fsReadFile).not.toHaveBeenCalled();
  });

  it("records the opened path in the workspace's recent-files list when a workspace root is set", async () => {
    localStorage.clear();
    workspace.set({ id: "local", root: "/proj" });

    await openFile("/proj/notes.md");

    expect(getRecentFiles("/proj")).toEqual(["/proj/notes.md"]);

    workspace.set({ id: "local", root: null });
  });

  it("does not record recency when no workspace root is set", async () => {
    localStorage.clear();
    workspace.set({ id: "local", root: null });

    await openFile("/notes.md");

    expect(getRecentFiles("/notes.md")).toEqual([]);
  });

  it("records recency for a tab that is already open (focused, not re-fetched), not just a fresh one", async () => {
    localStorage.clear();
    workspace.set({ id: "local", root: "/proj" });
    tabsState.set({
      tabs: [codeTab("/proj/existing.md")],
      activeTabPath: "/proj/existing.md",
    });

    await openFile("/proj/existing.md");

    expect(getRecentFiles("/proj")).toEqual(["/proj/existing.md"]);

    workspace.set({ id: "local", root: null });
  });

  it("derives isExternal: false for a path inside the workspace root", async () => {
    workspace.set({ id: "local", root: "/proj" });

    await openFile("/proj/notes.md");

    const tab = get(tabsState).tabs.find((t) => t.path === "/proj/notes.md");
    expect(tab?.isExternal).toBe(false);

    workspace.set({ id: "local", root: null });
  });

  it("derives isExternal: true for a path outside the workspace root", async () => {
    workspace.set({ id: "local", root: "/proj" });

    await openFile("/home/alice/outside.md");

    const tab = get(tabsState).tabs.find((t) => t.path === "/home/alice/outside.md");
    expect(tab?.isExternal).toBe(true);

    workspace.set({ id: "local", root: null });
  });

  it("skips recording recency for an outside-workspace (external) open", async () => {
    localStorage.clear();
    workspace.set({ id: "local", root: "/proj" });

    await openFile("/home/alice/outside.md");

    expect(getRecentFiles("/proj")).toEqual([]);

    workspace.set({ id: "local", root: null });
  });

  // Test 1 (frontend half, issue #325): the workspaceId argument actually
  // passed to fsReadFile, not merely that a mocked open resolves — a mock
  // decoupled from the real argument would pass even if `openFile` ignored
  // its `workspaceId` parameter and always read through "local".
  it("reads through the given workspaceId, not a hardcoded local", async () => {
    await openFile("/tmp/standalone-note.md", undefined, "standalone");

    expect(commands.fsReadFile).toHaveBeenCalledWith("standalone", "/tmp/standalone-note.md");
  });

  it("defaults workspaceId to local when the caller doesn't pass one", async () => {
    await openFile("/proj/notes.md");

    expect(commands.fsReadFile).toHaveBeenCalledWith("local", "/proj/notes.md");
  });

  // Regression test for the isExternal bug found while designing issue
  // #325: `isPathUnderOrEqual(path, root ?? "")` degenerates to a bare
  // `startsWith("/")` check when `root` is null, so a standalone open (no
  // workspace root at all) would wrongly compute `isExternal: false`
  // without the `workspaceId !== localWorkspaceId()` short-circuit.
  it("derives isExternal: true for a standalone open with no workspace root, not the isPathUnderOrEqual('', ...) degenerate case", async () => {
    workspace.set({ id: "local", root: null });

    await openFile("/tmp/standalone-note.md", undefined, "standalone");

    const tab = get(tabsState).tabs.find((t) => t.path === "/tmp/standalone-note.md");
    expect(tab?.isExternal).toBe(true);
  });
});

describe("openFileReportingErrors", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
    errorToast.set(null);
  });

  it("shows an error toast when the underlying text-file open rejects", async () => {
    vi.mocked(commands.fsReadFile).mockRejectedValueOnce(new Error("file is not valid UTF-8: /archive.bin"));

    openFileReportingErrors("/archive.bin");
    await Promise.resolve();
    await Promise.resolve();

    expect(get(errorToast)).toBe("Couldn't open file: file is not valid UTF-8: /archive.bin");
  });

  it("shows an error toast when image access validation rejects", async () => {
    vi.mocked(commands.fsCheckFileAccess).mockRejectedValueOnce(new Error("image disappeared"));

    openFileReportingErrors("/img.png");
    await Promise.resolve();
    await Promise.resolve();

    expect(get(errorToast)).toBe("Couldn't open file: image disappeared");
  });

  it("leaves the error toast untouched when the open succeeds", async () => {
    vi.mocked(commands.fsReadFile).mockResolvedValueOnce("# Hello");

    openFileReportingErrors("/notes.md");
    await Promise.resolve();
    await Promise.resolve();

    expect(get(errorToast)).toBeNull();
  });
});

describe("reconcileExternalChange / reloadFromDisk / dismissConflict", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
    vi.mocked(commands.fsReadFile).mockReset();
  });

  it("does not route an image modification through the UTF-8 text reader", async () => {
    tabsState.set({
      tabs: [codeTab("/photo.png", { mode: "image" })],
      activeTabPath: "/photo.png",
    });

    await reconcileExternalChange("/photo.png");

    expect(commands.fsReadFile).not.toHaveBeenCalled();
  });

  it("reconcileExternalChange silently updates savedDoc for a clean tab and never sets hasExternalConflict", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "old", isDirty: false })],
      activeTabPath: "/notes.md",
    });
    vi.mocked(commands.fsReadFile).mockResolvedValue("new disk contents");

    await reconcileExternalChange("/notes.md");

    const tab = get(tabsState).tabs[0];
    expect(tab.savedDoc).toBe("new disk contents");
    expect(tab.isDirty).toBe(false);
    expect(tab.hasExternalConflict).toBe(false);
  });

  // Precondition load-bearing to this test: `isDirty: true` must be seeded.
  // On a clean tab the read-and-update path runs instead and
  // `hasExternalConflict` stays false regardless of the fix under test — the
  // assertions below are only meaningful for a dirty tab.
  it("reconcileExternalChange on a dirty tab reads disk and sets hasExternalConflict only when the content differs from savedDoc, leaving savedDoc/isDirty untouched", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "original", isDirty: true })],
      activeTabPath: "/notes.md",
    });
    vi.mocked(commands.fsReadFile).mockResolvedValue("changed elsewhere");

    await reconcileExternalChange("/notes.md");

    const tab = get(tabsState).tabs[0];
    expect(commands.fsReadFile).toHaveBeenCalledWith(tab.workspaceId, "/notes.md");
    expect(tab.hasExternalConflict).toBe(true);
    expect(tab.savedDoc).toBe("original");
    expect(tab.isDirty).toBe(true);
  });

  // MF1 regression (self-write echo): a dirty tab's disk read that comes
  // back identical to savedDoc is our own write (manual or auto-save)
  // echoing through the file watcher, not a genuine external change, and
  // must not raise the conflict banner.
  it("reconcileExternalChange on a dirty tab does not set hasExternalConflict when disk content matches savedDoc (self-write echo)", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "original", isDirty: true })],
      activeTabPath: "/notes.md",
    });
    vi.mocked(commands.fsReadFile).mockResolvedValue("original");

    await reconcileExternalChange("/notes.md");

    const tab = get(tabsState).tabs[0];
    expect(tab.hasExternalConflict).toBe(false);
    expect(tab.savedDoc).toBe("original");
    expect(tab.isDirty).toBe(true);
  });

  // Regression: reconcileExternalChange must re-read live tabsState after
  // the disk read, not branch on the snapshot taken before it — that
  // snapshot can go stale while the read is in flight. Failure A: a real
  // external change lands while the tab was clean by the stale snapshot;
  // branching on that stale value silently adopts the external content into
  // savedDoc with no conflict ever raised, an unattended keystroke away from
  // auto-save overwriting it. The fix re-reads tabsState after the await, so
  // the keystroke that landed mid-read is seen and the dirty branch (not the
  // clean branch) correctly runs, still raising the conflict since the disk
  // content differs from the tab's own savedDoc.
  it("re-reads live state after the disk read, so a keystroke landing mid-read does not silently lose an external change", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "original", isDirty: false })],
      activeTabPath: "/notes.md",
    });
    let resolveRead!: (value: string) => void;
    vi.mocked(commands.fsReadFile).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const pending = reconcileExternalChange("/notes.md");
    // A keystroke lands while the disk read above is still in flight.
    markDirty("/notes.md");
    resolveRead("external content");
    await pending;

    const tab = get(tabsState).tabs[0];
    expect(tab.isDirty).toBe(true);
    expect(tab.hasExternalConflict).toBe(true);
    expect(tab.savedDoc).toBe("original");
  });

  // Failure B: this tab's own write (manual or auto-save) completes while
  // the read triggered by the watcher's echo of that same write is still in
  // flight. Branching on the stale (dirty, old-savedDoc) snapshot compares
  // the fresh disk read against the wrong baseline and raises a spurious
  // conflict on the app's own write — a narrowed recurrence of the defect
  // this function was written to eliminate. The fix re-reads tabsState after
  // the await, sees the tab is now clean (the save already completed), and
  // correctly takes the clean branch instead.
  it("re-reads live state after the disk read, so its own save completing mid-read is not mistaken for a conflict", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "S", isDirty: true })],
      activeTabPath: "/notes.md",
    });
    vi.mocked(commands.fsWriteFile).mockResolvedValue(undefined);
    let resolveRead!: (value: string) => void;
    vi.mocked(commands.fsReadFile).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const pending = reconcileExternalChange("/notes.md");
    // This tab's own save completes while the read above is still in flight.
    await saveTab("/notes.md", "B");
    resolveRead("B");
    await pending;

    const tab = get(tabsState).tabs[0];
    expect(tab.hasExternalConflict).toBe(false);
    expect(tab.savedDoc).toBe("B");
    expect(tab.isDirty).toBe(false);
  });

  // The previous test (own save completing mid-read) takes the *clean*
  // branch once live state is re-read, so it never actually exercises the
  // dirty branch's `contents !== live.savedDoc` comparison — a mutation
  // reverting just that comparison's `live.savedDoc` back to the stale
  // `tab.savedDoc` snapshot survives it. This closes that gap: the tab goes
  // dirty *again* (a further keystroke) before the read resolves, so the
  // dirty branch runs, and only a correctly-live `savedDoc` ("B", from the
  // completed save) makes the echo compare equal and stay silent — the
  // stale snapshot ("S", from before the save) would wrongly differ and
  // raise a spurious conflict.
  it("re-reads live savedDoc (not the pre-await snapshot) when the tab goes dirty again after its own save completes mid-read", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "S", isDirty: true })],
      activeTabPath: "/notes.md",
    });
    vi.mocked(commands.fsWriteFile).mockResolvedValue(undefined);
    let resolveRead!: (value: string) => void;
    vi.mocked(commands.fsReadFile).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const pending = reconcileExternalChange("/notes.md");
    // This tab's own save completes mid-read...
    await saveTab("/notes.md", "B");
    // ...and a further keystroke re-dirties it before the read resolves.
    markDirty("/notes.md");
    resolveRead("B");
    await pending;

    const tab = get(tabsState).tabs[0];
    expect(tab.hasExternalConflict).toBe(false);
    expect(tab.savedDoc).toBe("B");
    expect(tab.isDirty).toBe(true);
  });

  // The `!live` guard exists for a tab closed while its own reconcile read
  // is still in flight — the type checker enforces the null check, but this
  // pins the actual runtime behavior: no throw, no resurrection of the
  // closed tab.
  it("resolves without throwing or recreating the tab when it's closed while the disk read is still in flight", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "original", isDirty: false })],
      activeTabPath: "/notes.md",
    });
    let resolveRead!: (value: string) => void;
    vi.mocked(commands.fsReadFile).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const pending = reconcileExternalChange("/notes.md");
    // The tab is closed while the read above is still in flight.
    tabsState.set({ tabs: [], activeTabPath: null });
    resolveRead("external content");

    await expect(pending).resolves.toBeUndefined();
    expect(get(tabsState).tabs).toHaveLength(0);
  });

  // Test 1 (frontend half, issue #325) — reconcileExternalChange/reloadFromDisk
  // read through the *tab's own* workspaceId, not a hardcoded "local".
  it("reconcileExternalChange reads through the tab's own workspaceId", async () => {
    tabsState.set({
      tabs: [codeTab("/tmp/standalone.md", { workspaceId: "standalone", savedDoc: "old", isDirty: false })],
      activeTabPath: "/tmp/standalone.md",
    });
    vi.mocked(commands.fsReadFile).mockResolvedValue("new disk contents");

    await reconcileExternalChange("/tmp/standalone.md");

    expect(commands.fsReadFile).toHaveBeenCalledWith("standalone", "/tmp/standalone.md");
  });

  it("reloadFromDisk reads through the tab's own workspaceId", async () => {
    tabsState.set({
      tabs: [
        codeTab("/tmp/standalone.md", { workspaceId: "standalone", savedDoc: "original", isDirty: true, hasExternalConflict: true }),
      ],
      activeTabPath: "/tmp/standalone.md",
    });
    vi.mocked(commands.fsReadFile).mockResolvedValue("disk contents");

    await reloadFromDisk("/tmp/standalone.md");

    expect(commands.fsReadFile).toHaveBeenCalledWith("standalone", "/tmp/standalone.md");
  });

  it("reloadFromDisk on a conflicted tab clears isDirty and hasExternalConflict and adopts disk contents", async () => {
    tabsState.set({
      tabs: [
        codeTab("/notes.md", { savedDoc: "original", isDirty: true, hasExternalConflict: true }),
      ],
      activeTabPath: "/notes.md",
    });
    vi.mocked(commands.fsReadFile).mockResolvedValue("disk contents");

    await reloadFromDisk("/notes.md");

    const tab = get(tabsState).tabs[0];
    expect(tab.savedDoc).toBe("disk contents");
    expect(tab.isDirty).toBe(false);
    expect(tab.hasExternalConflict).toBe(false);
  });

  it("reloadFromDisk clears isDeleted along with isDirty and hasExternalConflict", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "unsaved", isDirty: true, isDeleted: true })],
      activeTabPath: "/notes.md",
    });
    vi.mocked(commands.fsReadFile).mockResolvedValue("disk contents");

    await reloadFromDisk("/notes.md");

    expect(get(tabsState).tabs[0].isDeleted).toBe(false);
  });

  it("dismissConflict on a conflicted tab clears only hasExternalConflict, keeping the local edit", () => {
    tabsState.set({
      tabs: [
        codeTab("/notes.md", { savedDoc: "my edits", isDirty: true, hasExternalConflict: true }),
      ],
      activeTabPath: "/notes.md",
    });

    dismissConflict("/notes.md");

    const tab = get(tabsState).tabs[0];
    expect(tab.hasExternalConflict).toBe(false);
    expect(tab.savedDoc).toBe("my edits");
    expect(tab.isDirty).toBe(true);
  });

  it("markDirty followed by a repeated reconcileExternalChange stays a no-op on savedDoc/isDirty (regression guard for issue #76)", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "original", isDirty: false })],
      activeTabPath: "/notes.md",
    });
    markDirty("/notes.md");
    vi.mocked(commands.fsReadFile).mockResolvedValue("changed once");

    await reconcileExternalChange("/notes.md");
    expect(get(tabsState).tabs[0].hasExternalConflict).toBe(true);

    vi.mocked(commands.fsReadFile).mockResolvedValue("changed twice");
    await reconcileExternalChange("/notes.md");

    const tab = get(tabsState).tabs[0];
    expect(tab.savedDoc).toBe("original");
    expect(tab.isDirty).toBe(true);
    expect(tab.hasExternalConflict).toBe(true);
  });
});

describe("markPathDeleted", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
    errorToast.set(null);
  });

  it("closes a clean tab outright and toasts that it was closed", () => {
    tabsState.set({ tabs: [codeTab("/notes.md")], activeTabPath: "/notes.md" });

    markPathDeleted("/notes.md");

    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(tabsState).activeTabPath).toBeNull();
    expect(get(errorToast)).toBe("notes.md was deleted — its tab was closed.");
  });

  it("flags a dirty tab isDeleted instead of closing it, and does not toast", () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { isDirty: true, savedDoc: "unsaved" })],
      activeTabPath: "/notes.md",
    });

    markPathDeleted("/notes.md");

    const tabs = get(tabsState).tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].isDeleted).toBe(true);
    expect(tabs[0].isDirty).toBe(true);
    expect(tabs[0].savedDoc).toBe("unsaved");
    expect(get(errorToast)).toBeNull();
  });

  it("clears hasExternalConflict on a dirty tab it flags, so the deleted banner isn't masked by the conflict banner (modify-then-delete)", () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { isDirty: true, hasExternalConflict: true })],
      activeTabPath: "/notes.md",
    });

    markPathDeleted("/notes.md");

    const tab = get(tabsState).tabs[0];
    expect(tab.isDeleted).toBe(true);
    expect(tab.hasExternalConflict).toBe(false);
  });

  it("cascades to every open tab nested under a deleted directory, mixing clean-close and dirty-flag outcomes", () => {
    tabsState.set({
      tabs: [
        codeTab("/dir/clean.md"),
        codeTab("/dir/dirty.md", { isDirty: true }),
        codeTab("/dir/nested/deep.md"),
        codeTab("/other.md"),
      ],
      activeTabPath: "/dir/clean.md",
    });

    markPathDeleted("/dir");

    const tabs = get(tabsState).tabs;
    expect(tabs.map((t) => t.path)).toEqual(["/dir/dirty.md", "/other.md"]);
    expect(tabs.find((t) => t.path === "/dir/dirty.md")?.isDeleted).toBe(true);
  });

  it("falls back to the last remaining tab when the active tab was closed", () => {
    tabsState.set({
      tabs: [codeTab("/notes.md"), codeTab("/other.md")],
      activeTabPath: "/notes.md",
    });

    markPathDeleted("/notes.md");

    expect(get(tabsState).activeTabPath).toBe("/other.md");
  });

  it("is a no-op for a path with no open tabs at or under it", () => {
    tabsState.set({ tabs: [codeTab("/other.md")], activeTabPath: "/other.md" });

    markPathDeleted("/missing.md");

    expect(get(tabsState).tabs).toHaveLength(1);
    expect(get(errorToast)).toBeNull();
  });

  it("names only the filename in the toast for a Windows backslash path", () => {
    tabsState.set({ tabs: [codeTab("C:\\ws\\notes.md")], activeTabPath: "C:\\ws\\notes.md" });

    markPathDeleted("C:\\ws\\notes.md");

    expect(get(errorToast)).toBe("notes.md was deleted — its tab was closed.");
  });

  it("cascades to tabs under a deleted directory on a Windows backslash path", () => {
    tabsState.set({
      tabs: [codeTab("C:\\ws\\src\\a.ts"), codeTab("C:\\ws\\src\\b.ts")],
      activeTabPath: "C:\\ws\\src\\a.ts",
    });

    markPathDeleted("C:\\ws\\src");

    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(errorToast)).toBe("a.ts, b.ts were deleted — their tabs were closed.");
  });
});

describe("renameOpenTabs", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
    tabRenameSignal.set(null);
  });

  it("re-keys an exact-match tab, preserving savedDoc/isDirty/viewMode", () => {
    tabsState.set({
      tabs: [markdownTab("/notes.md", { savedDoc: "unsaved edit", isDirty: true, viewMode: "source" })],
      activeTabPath: "/notes.md",
    });

    renameOpenTabs("/notes.md", "/notes-renamed.md");

    const tabs = get(tabsState).tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].path).toBe("/notes-renamed.md");
    expect(tabs[0].savedDoc).toBe("unsaved edit");
    expect(tabs[0].isDirty).toBe(true);
    expect(tabs[0].viewMode).toBe("source");
  });

  it("re-keys every tab nested under a renamed directory", () => {
    tabsState.set({
      tabs: [
        codeTab("/dir/a.md"),
        codeTab("/dir/nested/b.md"),
        codeTab("/other.md"),
      ],
      activeTabPath: "/dir/a.md",
    });

    renameOpenTabs("/dir", "/renamed");

    const paths = get(tabsState).tabs.map((t) => t.path);
    expect(paths).toEqual(["/renamed/a.md", "/renamed/nested/b.md", "/other.md"]);
  });

  it("re-keys activeTabPath when it matches the renamed path", () => {
    tabsState.set({ tabs: [codeTab("/notes.md")], activeTabPath: "/notes.md" });

    renameOpenTabs("/notes.md", "/notes-renamed.md");

    expect(get(tabsState).activeTabPath).toBe("/notes-renamed.md");
  });

  it("leaves activeTabPath untouched when it doesn't match the renamed path", () => {
    tabsState.set({
      tabs: [codeTab("/notes.md"), codeTab("/other.md")],
      activeTabPath: "/other.md",
    });

    renameOpenTabs("/notes.md", "/notes-renamed.md");

    expect(get(tabsState).activeTabPath).toBe("/other.md");
  });

  it("is a no-op for an unrelated path, including not setting tabRenameSignal", () => {
    tabsState.set({ tabs: [codeTab("/other.md")], activeTabPath: "/other.md" });

    renameOpenTabs("/notes.md", "/notes-renamed.md");

    expect(get(tabsState).tabs).toEqual([codeTab("/other.md")]);
    expect(get(tabRenameSignal)).toBeNull();
  });

  it("sets tabRenameSignal to the from/to pair when a rename actually applies", () => {
    tabsState.set({ tabs: [codeTab("/notes.md")], activeTabPath: "/notes.md" });

    renameOpenTabs("/notes.md", "/notes-renamed.md");

    expect(get(tabRenameSignal)).toEqual({ from: "/notes.md", to: "/notes-renamed.md" });
  });

  it("drops a clean tab already open at the computed destination, keeping only the renamed survivor (external rename onto an open path)", () => {
    tabsState.set({
      tabs: [codeTab("/a.md", { savedDoc: "a's content" }), codeTab("/b.md", { savedDoc: "b's content" })],
      activeTabPath: "/a.md",
    });

    renameOpenTabs("/a.md", "/b.md");

    const tabs = get(tabsState).tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].path).toBe("/b.md");
    expect(tabs[0].savedDoc).toBe("a's content");
  });

  it("toasts when the displaced tab was dirty, since its unsaved edits are discarded", () => {
    errorToast.set(null);
    tabsState.set({
      tabs: [codeTab("/a.md"), codeTab("/b.md", { isDirty: true, savedDoc: "unsaved" })],
      activeTabPath: "/a.md",
    });

    renameOpenTabs("/a.md", "/b.md");

    expect(get(errorToast)).toBe("b.md was overwritten by an external rename — its unsaved edits were discarded.");
  });

  it("names only the filename when toasting a displaced dirty tab on a Windows-shaped path", () => {
    // Both tabs are already in the canonical (forward-slash) form here, as
    // every real tab is by the time it reaches `tabsState` — every path
    // enters through the IPC boundary (`commands.ts`/`events.ts`) or through
    // `contextMenu.ts`'s own `joinPath`, both of which canonicalize. This
    // pins that `basename`'s filename-only toast still reads correctly off
    // a Windows-shaped path, without resurrecting a spelling divergence
    // that can no longer occur for real.
    errorToast.set(null);
    tabsState.set({
      tabs: [codeTab("C:/ws/a.md"), codeTab("C:/ws/b.md", { isDirty: true, savedDoc: "unsaved" })],
      activeTabPath: "C:/ws/a.md",
    });

    renameOpenTabs("C:/ws/a.md", "C:/ws/b.md");

    expect(get(errorToast)).toBe(
      "b.md was overwritten by an external rename — its unsaved edits were discarded.",
    );
  });

  it("does not toast when the displaced tab was clean", () => {
    errorToast.set(null);
    tabsState.set({
      tabs: [codeTab("/a.md"), codeTab("/b.md")],
      activeTabPath: "/a.md",
    });

    renameOpenTabs("/a.md", "/b.md");

    expect(get(errorToast)).toBeNull();
  });

  it("falls back activeTabPath to the last remaining tab when the active tab was the one displaced", () => {
    tabsState.set({
      tabs: [codeTab("/a.md"), codeTab("/b.md")],
      activeTabPath: "/b.md",
    });

    renameOpenTabs("/a.md", "/b.md");

    expect(get(tabsState).activeTabPath).toBe("/b.md");
    expect(get(tabsState).tabs).toHaveLength(1);
    // The survivor at /b.md is the renamed tab (originally /a.md), not the
    // displaced one — activeTabPath falls back to it since it's now the
    // only tab left, not because it "matched" the old active path.
    expect(get(tabsState).tabs[0].path).toBe("/b.md");
  });
});

describe("reconcileExternalChange's NOT_FOUND and FILE_TOO_LARGE catches", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
    errorToast.set(null);
    vi.mocked(commands.fsReadFile).mockReset();
  });

  it("calls markPathDeleted instead of throwing when fsReadFile rejects with NOT_FOUND", async () => {
    tabsState.set({ tabs: [codeTab("/notes.md")], activeTabPath: "/notes.md" });
    vi.mocked(commands.fsReadFile).mockRejectedValue({ code: "NOT_FOUND", message: "not found" });

    await expect(reconcileExternalChange("/notes.md")).resolves.toBeUndefined();

    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(errorToast)).toBe("notes.md was deleted — its tab was closed.");
  });

  it("shows an error toast instead of throwing when fsReadFile rejects with FILE_TOO_LARGE, leaving the tab's savedDoc untouched", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "last-known contents" })],
      activeTabPath: "/notes.md",
    });
    vi.mocked(commands.fsReadFile).mockRejectedValue({
      code: "FILE_TOO_LARGE",
      message: "'/notes.md' is 12.3 MiB, which exceeds the 10.0 MiB open limit",
    });

    await expect(reconcileExternalChange("/notes.md")).resolves.toBeUndefined();

    expect(get(errorToast)).toBe("'/notes.md' is 12.3 MiB, which exceeds the 10.0 MiB open limit");
    expect(get(tabsState).tabs[0].savedDoc).toBe("last-known contents");
  });

  it("still rejects for a non-NOT_FOUND, non-FILE_TOO_LARGE error", async () => {
    tabsState.set({ tabs: [codeTab("/notes.md")], activeTabPath: "/notes.md" });
    const error = { code: "PERMISSION_DENIED", message: "denied" };
    vi.mocked(commands.fsReadFile).mockRejectedValue(error);

    await expect(reconcileExternalChange("/notes.md")).rejects.toBe(error);
    expect(get(tabsState).tabs).toHaveLength(1);
  });

  it("shows an error toast instead of throwing when fsReadFile rejects with EXTERNAL_FILE_CHANGED", async () => {
    tabsState.set({
      tabs: [codeTab("/home/alice/outside.md", { savedDoc: "last-known contents", isExternal: true })],
      activeTabPath: "/home/alice/outside.md",
    });
    vi.mocked(commands.fsReadFile).mockRejectedValue({
      code: "EXTERNAL_FILE_CHANGED",
      message: "'/home/alice/outside.md' has changed since it was opened — close and reopen it to continue",
    });

    await expect(reconcileExternalChange("/home/alice/outside.md")).resolves.toBeUndefined();

    expect(get(errorToast)).toBe(
      "'/home/alice/outside.md' has changed since it was opened — close and reopen it to continue",
    );
    expect(get(tabsState).tabs[0].savedDoc).toBe("last-known contents");
  });
});

describe("requestCloseTab", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
    closePrompt.set(null);
  });

  it("closes a clean tab immediately without raising the unsaved-changes prompt", () => {
    tabsState.set({ tabs: [codeTab("/main.rs")], activeTabPath: "/main.rs" });

    requestCloseTab("/main.rs");

    expect(get(tabsState).tabs).toHaveLength(0);
    expect(get(closePrompt)).toBeNull();
  });

  it("raises the tab prompt for a dirty tab instead of closing it", () => {
    tabsState.set({ tabs: [codeTab("/main.rs", { isDirty: true })], activeTabPath: "/main.rs" });

    requestCloseTab("/main.rs");

    expect(get(tabsState).tabs).toHaveLength(1);
    expect(get(closePrompt)).toEqual({ kind: "tab", path: "/main.rs" });
  });

  it("is a no-op for an unknown path", () => {
    tabsState.set({ tabs: [codeTab("/main.rs")], activeTabPath: "/main.rs" });

    requestCloseTab("/missing.rs");

    expect(get(tabsState).tabs).toHaveLength(1);
    expect(get(closePrompt)).toBeNull();
  });

  it("activates the tab that shifted into the closed tab's position, not the last tab", () => {
    tabsState.set({
      tabs: [codeTab("/a.rs"), codeTab("/b.rs"), codeTab("/c.rs")],
      activeTabPath: "/b.rs",
    });

    requestCloseTab("/b.rs");

    expect(get(tabsState).activeTabPath).toBe("/c.rs");
  });

  it("activates the closed tab's right neighbour, not the last tab, when closing the first tab", () => {
    tabsState.set({
      tabs: [codeTab("/a.rs"), codeTab("/b.rs"), codeTab("/c.rs")],
      activeTabPath: "/a.rs",
    });

    requestCloseTab("/a.rs");

    expect(get(tabsState).activeTabPath).toBe("/b.rs");
  });

  it("activates the new last tab when closing the rightmost tab", () => {
    tabsState.set({
      tabs: [codeTab("/a.rs"), codeTab("/b.rs"), codeTab("/c.rs")],
      activeTabPath: "/c.rs",
    });

    requestCloseTab("/c.rs");

    expect(get(tabsState).activeTabPath).toBe("/b.rs");
  });
});

describe("saveTab", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
    vi.mocked(commands.fsWriteFile).mockReset().mockResolvedValue(undefined);
  });

  it("clears isDeleted along with isDirty and hasExternalConflict on a successful save", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { isDirty: true, isDeleted: true })],
      activeTabPath: "/notes.md",
    });

    await saveTab("/notes.md", "new contents");

    const tab = get(tabsState).tabs[0];
    expect(tab.isDeleted).toBe(false);
    expect(tab.isDirty).toBe(false);
    expect(tab.savedDoc).toBe("new contents");
  });

  // Regression: saveTab used to clear hasExternalConflict/isDeleted
  // unconditionally after its write resolved, the same read-before/use-after
  // shape reconcileExternalChange was fixed for — except here the "read" is
  // the pre-write tab state and the "use" is a blanket overwrite regardless
  // of what happened during fsWriteFile's own round trip. A flag already
  // true before the write started is resolved by a successful save (the
  // existing "keep mine" behavior, asserted above); a flag that turns true
  // only *during* the write is a genuinely new external event this save
  // knows nothing about, and must survive it — silently clearing it is what
  // makes the conflict banner disappear the instant it appears.
  it("does not clear a hasExternalConflict raised while its own write is still in flight", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { isDirty: true, hasExternalConflict: false })],
      activeTabPath: "/notes.md",
    });
    let resolveWrite!: () => void;
    vi.mocked(commands.fsWriteFile).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    const pending = saveTab("/notes.md", "new contents");
    // A genuinely new external conflict is raised while this write is still
    // in flight (e.g. the watcher's own reconcile resolves first).
    tabsState.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.path === "/notes.md" ? { ...t, hasExternalConflict: true } : t)),
    }));
    resolveWrite();
    await pending;

    const tab = get(tabsState).tabs[0];
    expect(tab.hasExternalConflict).toBe(true);
    expect(tab.savedDoc).toBe("new contents");
    expect(tab.isDirty).toBe(false);
  });

  it("does not clear an isDeleted raised while its own write is still in flight", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { isDirty: true, isDeleted: false })],
      activeTabPath: "/notes.md",
    });
    let resolveWrite!: () => void;
    vi.mocked(commands.fsWriteFile).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    const pending = saveTab("/notes.md", "new contents");
    // The file is deleted out from under this write while it's still in
    // flight (a directory delete cascading, an external process racing it).
    tabsState.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.path === "/notes.md" ? { ...t, isDeleted: true } : t)),
    }));
    resolveWrite();
    await pending;

    const tab = get(tabsState).tabs[0];
    expect(tab.isDeleted).toBe(true);
  });

  // Test 1 (frontend half, issue #325) — the exact scenario the plan names:
  // "assert the workspaceId argument actually passed to fsWriteFile for the
  // surviving tab, not merely that a mocked save resolves."
  it("writes through the tab's own workspaceId, not a hardcoded local", async () => {
    tabsState.set({
      tabs: [codeTab("/tmp/standalone.md", { workspaceId: "standalone" })],
      activeTabPath: "/tmp/standalone.md",
    });

    await saveTab("/tmp/standalone.md", "new contents");

    expect(commands.fsWriteFile).toHaveBeenCalledWith("standalone", "/tmp/standalone.md", "new contents");
  });
});

describe("requestSave / notifySaveComplete", () => {
  it("resolves the returned promise only after the matching notifySaveComplete call", async () => {
    let resolved = false;
    const pending = requestSave("/a.md").then(() => {
      resolved = true;
    });

    // Give any spuriously-resolved microtask a chance to run.
    await Promise.resolve();
    expect(resolved).toBe(false);

    notifySaveComplete("/a.md");
    await pending;

    expect(resolved).toBe(true);
  });

  it("does not resolve for an unrelated path", async () => {
    let resolved = false;
    void requestSave("/a.md").then(() => {
      resolved = true;
    });

    notifySaveComplete("/b.md");
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(false);

    notifySaveComplete("/a.md");
    await Promise.resolve();

    expect(resolved).toBe(true);
  });

  it("resolves every concurrent requestSave call for the same path from a single notifySaveComplete", async () => {
    // Regresses a bug where a second requestSave(path) call, arriving while
    // the first is still in flight for that same path (e.g. the native
    // Cmd+S menu firing mid-"Save All"), overwrote the first call's
    // resolver and left it hanging forever once the underlying save
    // completed.
    let firstResolved = false;
    let secondResolved = false;
    const first = requestSave("/a.md").then(() => {
      firstResolved = true;
    });
    const second = requestSave("/a.md").then(() => {
      secondResolved = true;
    });

    notifySaveComplete("/a.md");
    await first;
    await second;

    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(true);
  });

  it("rejects every concurrent requestSave call for the same path from a single notifySaveFailed", async () => {
    const error = new Error("disk full");
    let firstError: unknown;
    let secondError: unknown;
    const first = requestSave("/a.md").catch((err: unknown) => {
      firstError = err;
    });
    const second = requestSave("/a.md").catch((err: unknown) => {
      secondError = err;
    });

    notifySaveFailed("/a.md", error);
    await first;
    await second;

    expect(firstError).toBe(error);
    expect(secondError).toBe(error);
  });
});

describe("reloadFromDiskReportingErrors", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
    errorToast.set(null);
    vi.mocked(commands.fsReadFile).mockReset();
  });

  it("shows an error toast naming the file's basename when the reload rejects, e.g. FILE_TOO_LARGE", async () => {
    tabsState.set({
      tabs: [codeTab("/notes/a.md", { isDirty: true, hasExternalConflict: true })],
      activeTabPath: "/notes/a.md",
    });
    vi.mocked(commands.fsReadFile).mockRejectedValue({
      code: "FILE_TOO_LARGE",
      message: "'/notes/a.md' is 12.3 MiB, which exceeds the 10.0 MiB open limit",
    });

    reloadFromDiskReportingErrors("/notes/a.md");
    await Promise.resolve();
    await Promise.resolve();

    expect(get(errorToast)).toBe(
      "Couldn't reload a.md: '/notes/a.md' is 12.3 MiB, which exceeds the 10.0 MiB open limit",
    );
  });

  it("leaves the error toast untouched when the reload succeeds", async () => {
    tabsState.set({
      tabs: [codeTab("/notes/a.md", { isDirty: true, hasExternalConflict: true })],
      activeTabPath: "/notes/a.md",
    });
    vi.mocked(commands.fsReadFile).mockResolvedValue("disk contents");

    reloadFromDiskReportingErrors("/notes/a.md");
    await Promise.resolve();
    await Promise.resolve();

    expect(get(errorToast)).toBeNull();
  });
});

describe("requestSaveReportingErrors", () => {
  beforeEach(() => {
    errorToast.set(null);
  });

  it("shows an error toast naming the file's basename when the save rejects", async () => {
    requestSaveReportingErrors("/notes/a.md");

    notifySaveFailed("/notes/a.md", new Error("disk full"));
    await Promise.resolve();
    await Promise.resolve();

    expect(get(errorToast)).toBe("Couldn't save a.md: disk full");
  });

  it("leaves the error toast untouched when the save succeeds", async () => {
    requestSaveReportingErrors("/notes/a.md");

    notifySaveComplete("/notes/a.md");
    await Promise.resolve();
    await Promise.resolve();

    expect(get(errorToast)).toBeNull();
  });
});
