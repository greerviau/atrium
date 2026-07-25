import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import { workspace, openWorkspacePath } from "../../src/lib/stores/workspace";
import { recents } from "../../src/lib/stores/recents";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  localWorkspaceId: () => "local",
  workspaceSetRoot: vi.fn(),
  workspaceOpenFolderDialog: vi.fn(),
  workspaceGetRecents: vi.fn(),
}));

const project = { path: "/projects/demo", name: "demo", lastOpenedAt: 1 };

describe("openWorkspacePath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.set({ id: "local", root: null });
    recents.set([]);
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
});
