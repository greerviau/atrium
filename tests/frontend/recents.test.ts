import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import { recents, loadRecents, removeRecent } from "../../src/lib/stores/recents";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  workspaceGetRecents: vi.fn(),
  workspaceRemoveRecent: vi.fn(),
}));

const projectA = { path: "/projects/a", name: "a", lastOpenedAt: 1, isFile: false };
const projectB = { path: "/projects/b", name: "b", lastOpenedAt: 2, isFile: false };

describe("recents store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recents.set([]);
  });

  it("loadRecents populates the store from workspaceGetRecents", async () => {
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([projectA, projectB]);

    await loadRecents();

    expect(get(recents)).toEqual([projectA, projectB]);
  });

  it("removeRecent calls workspaceRemoveRecent and drops only the matching entry from the store", async () => {
    recents.set([projectA, projectB]);
    vi.mocked(commands.workspaceRemoveRecent).mockResolvedValue(undefined);

    await removeRecent("/projects/a");

    expect(commands.workspaceRemoveRecent).toHaveBeenCalledWith("/projects/a");
    expect(get(recents)).toEqual([projectB]);
  });
});
