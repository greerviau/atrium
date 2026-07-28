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
  fsReadFile: vi.fn(),
  fsWriteFile: vi.fn(),
  localWorkspaceId: () => "local",
  isAppError: (value: unknown): value is { code: string; message: string } =>
    typeof value === "object" && value !== null && "code" in value && "message" in value,
}));

function markdownTab(path: string, overrides: Partial<Tab> = {}): Tab {
  return {
    path,
    mode: "markdown",
    savedDoc: "",
    isDirty: false,
    hasExternalConflict: false,
    isDeleted: false,
    viewMode: "rendered",
    ...overrides,
  };
}

function codeTab(path: string, overrides: Partial<Tab> = {}): Tab {
  return {
    path,
    mode: "code",
    savedDoc: "",
    isDirty: false,
    hasExternalConflict: false,
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
    vi.mocked(commands.fsReadFile).mockResolvedValue("# Hello");
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
});

describe("openFileReportingErrors", () => {
  beforeEach(() => {
    tabsState.set({ tabs: [], activeTabPath: null });
    errorToast.set(null);
  });

  it("shows an error toast when the underlying open rejects", async () => {
    vi.mocked(commands.fsReadFile).mockRejectedValueOnce(new Error("file is not valid UTF-8: /img.png"));

    openFileReportingErrors("/img.png");
    await Promise.resolve();
    await Promise.resolve();

    expect(get(errorToast)).toBe("Couldn't open file: file is not valid UTF-8: /img.png");
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

  it("reconcileExternalChange on a dirty tab sets hasExternalConflict and leaves savedDoc/isDirty untouched", async () => {
    tabsState.set({
      tabs: [codeTab("/notes.md", { savedDoc: "original", isDirty: true })],
      activeTabPath: "/notes.md",
    });

    await reconcileExternalChange("/notes.md");

    const tab = get(tabsState).tabs[0];
    expect(tab.hasExternalConflict).toBe(true);
    expect(tab.savedDoc).toBe("original");
    expect(tab.isDirty).toBe(true);
    expect(commands.fsReadFile).not.toHaveBeenCalled();
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
