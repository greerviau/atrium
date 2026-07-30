import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import { workspace, openWorkspacePath, confirmWorkspaceSwitch } from "../../src/lib/stores/workspace";
import { recents } from "../../src/lib/stores/recents";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { closePrompt } from "../../src/lib/stores/closePrompt";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  localWorkspaceId: () => "local",
  standaloneWorkspaceId: () => "standalone",
  workspaceSetRoot: vi.fn(),
  workspaceOpenFolderDialog: vi.fn(),
  workspaceGetRecents: vi.fn(),
}));

const project = { path: "/projects/demo", name: "demo", lastOpenedAt: 1, isFile: false };

function dirtyTab(path: string, workspaceId = "local"): Tab {
  return {
    path,
    workspaceId,
    mode: "code",
    savedDoc: "",
    isDirty: true,
    hasExternalConflict: false,
    isExternal: false,
    isDeleted: false,
  };
}

describe("openWorkspacePath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.set({ id: "local", root: null });
    recents.set([]);
    tabsState.set({ tabs: [], activeTabPath: null });
    closePrompt.set(null);
  });

  it("calls workspaceSetRoot and updates the workspace store", async () => {
    vi.mocked(commands.workspaceSetRoot).mockResolvedValue(undefined);
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([project]);

    await openWorkspacePath(project.path);

    expect(commands.workspaceSetRoot).toHaveBeenCalledWith("local", project.path);
    expect(get(workspace)).toEqual({ id: "local", root: project.path });
  });

  it("refreshes the recents store after a successful switch", async () => {
    vi.mocked(commands.workspaceSetRoot).mockResolvedValue(undefined);
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([project]);

    await openWorkspacePath(project.path);
    await Promise.resolve();

    expect(commands.workspaceGetRecents).toHaveBeenCalledOnce();
    expect(get(recents)).toEqual([project]);
  });

  it("still resolves, and does not throw, when the recents refresh rejects", async () => {
    vi.mocked(commands.workspaceSetRoot).mockResolvedValue(undefined);
    vi.mocked(commands.workspaceGetRecents).mockRejectedValue(new Error("disk full"));

    await expect(openWorkspacePath(project.path)).resolves.toBeUndefined();
    expect(get(workspace)).toEqual({ id: "local", root: project.path });
  });

  it("is a no-op when re-selecting the already-open root", async () => {
    workspace.set({ id: "local", root: project.path });

    await openWorkspacePath(project.path);

    expect(commands.workspaceSetRoot).not.toHaveBeenCalled();
    expect(commands.workspaceGetRecents).not.toHaveBeenCalled();
  });

  it("raises the workspace unsaved-changes prompt instead of switching when a tab is dirty", async () => {
    workspace.set({ id: "local", root: "/projects/old" });
    tabsState.set({ tabs: [dirtyTab("/a.md"), dirtyTab("/b.md")], activeTabPath: "/a.md" });

    await openWorkspacePath(project.path);

    expect(commands.workspaceSetRoot).not.toHaveBeenCalled();
    expect(get(workspace)).toEqual({ id: "local", root: "/projects/old" });
    expect(get(closePrompt)).toEqual({
      kind: "workspace",
      paths: ["/a.md", "/b.md"],
      targetPath: project.path,
    });
  });

  // Test 9 — the narrowed dirty check's both directions (issue #325): a
  // dirty local tab still blocks a switch; a dirty standalone tab does not,
  // since `StandaloneWorkspace` is never torn down by one and stays
  // authorized/watched across it.
  it("a dirty local tab still blocks a switch, but a dirty standalone tab does not", async () => {
    vi.mocked(commands.workspaceSetRoot).mockResolvedValue(undefined);
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([project]);
    workspace.set({ id: "local", root: "/projects/old" });
    tabsState.set({
      tabs: [dirtyTab("/standalone.md", "standalone")],
      activeTabPath: "/standalone.md",
    });

    await openWorkspacePath(project.path);

    expect(commands.workspaceSetRoot).toHaveBeenCalledWith("local", project.path);
    expect(get(workspace)).toEqual({ id: "local", root: project.path });
    expect(get(closePrompt)).toBeNull();
  });
});

describe("confirmWorkspaceSwitch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.set({ id: "local", root: "/projects/old" });
    recents.set([]);
    tabsState.set({ tabs: [dirtyTab("/a.md")], activeTabPath: "/a.md" });
    closePrompt.set({ kind: "workspace", paths: ["/a.md"], targetPath: project.path });
  });

  it("performs the switch unconditionally, ignoring any dirty tabs", async () => {
    vi.mocked(commands.workspaceSetRoot).mockResolvedValue(undefined);
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([project]);

    await confirmWorkspaceSwitch(project.path);

    expect(commands.workspaceSetRoot).toHaveBeenCalledWith("local", project.path);
    expect(get(workspace)).toEqual({ id: "local", root: project.path });
  });
});
