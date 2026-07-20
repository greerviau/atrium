import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import { tabsState, openFile, toggleMarkdownViewMode, type Tab } from "../../src/lib/stores/tabs";
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
