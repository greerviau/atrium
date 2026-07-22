import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  tabsState,
  openFile,
  toggleMarkdownViewMode,
  markDirty,
  reconcileExternalChange,
  reloadFromDisk,
  dismissConflict,
  requestCloseTab,
  requestSave,
  notifySaveComplete,
  notifySaveFailed,
  type Tab,
} from "../../src/lib/stores/tabs";
import { closePrompt } from "../../src/lib/stores/closePrompt";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsReadFile: vi.fn(),
  fsWriteFile: vi.fn(),
  localWorkspaceId: () => "local",
}));

function markdownTab(path: string, overrides: Partial<Tab> = {}): Tab {
  return {
    path,
    mode: "markdown",
    savedDoc: "",
    isDirty: false,
    hasExternalConflict: false,
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
  });

  it("opens a fresh markdown tab starting at viewMode 'rendered'", async () => {
    await openFile("/notes.md");

    const tab = get(tabsState).tabs.find((t) => t.path === "/notes.md");
    expect(tab?.mode).toBe("markdown");
    expect(tab?.viewMode).toBe("rendered");
  });

  it("leaves viewMode unset for a fresh code tab", async () => {
    await openFile("/main.rs");

    const tab = get(tabsState).tabs.find((t) => t.path === "/main.rs");
    expect(tab?.mode).toBe("code");
    expect(tab?.viewMode).toBeUndefined();
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
