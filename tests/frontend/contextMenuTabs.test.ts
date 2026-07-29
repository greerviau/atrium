import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import { rename, movePath, deletePath } from "../../src/lib/explorer/contextMenu";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { workspace } from "../../src/lib/stores/workspace";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
  fsRename: vi.fn(),
  fsDelete: vi.fn(),
  localWorkspaceId: () => "local",
}));

const ROOT = "/proj";

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

describe("contextMenu: reconciling open tabs on rename/move/delete (issue #249)", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset().mockResolvedValue([]);
    vi.mocked(commands.fsRename).mockReset().mockResolvedValue(undefined);
    vi.mocked(commands.fsDelete).mockReset().mockResolvedValue(undefined);
    workspace.set({ id: "local", root: ROOT });
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  it("rename re-keys an open file's tab to the new path", async () => {
    tabsState.set({ tabs: [codeTab(`${ROOT}/old.txt`)], activeTabPath: `${ROOT}/old.txt` });

    await rename(`${ROOT}/old.txt`, "new.txt");

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual([`${ROOT}/new.txt`]);
    expect(get(tabsState).activeTabPath).toBe(`${ROOT}/new.txt`);
  });

  it("rename of a directory cascades to every open descendant tab", async () => {
    tabsState.set({
      tabs: [codeTab(`${ROOT}/src/a.txt`), codeTab(`${ROOT}/other.txt`)],
      activeTabPath: `${ROOT}/src/a.txt`,
    });

    await rename(`${ROOT}/src`, "renamed");

    const paths = get(tabsState).tabs.map((t) => t.path);
    expect(paths).toEqual([`${ROOT}/renamed/a.txt`, `${ROOT}/other.txt`]);
  });

  it("movePath re-keys an open file's tab to its new parent directory", async () => {
    tabsState.set({ tabs: [codeTab(`${ROOT}/src/a.txt`)], activeTabPath: `${ROOT}/src/a.txt` });

    await movePath(`${ROOT}/src/a.txt`, `${ROOT}/dest`);

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual([`${ROOT}/dest/a.txt`]);
  });

  it("deletePath closes a clean open file's tab", async () => {
    tabsState.set({ tabs: [codeTab(`${ROOT}/gone.txt`)], activeTabPath: `${ROOT}/gone.txt` });

    await deletePath(`${ROOT}/gone.txt`, false);

    expect(get(tabsState).tabs).toHaveLength(0);
  });

  it("deletePath flags a dirty open file's tab isDeleted instead of closing it", async () => {
    tabsState.set({
      tabs: [codeTab(`${ROOT}/gone.txt`, { isDirty: true })],
      activeTabPath: `${ROOT}/gone.txt`,
    });

    await deletePath(`${ROOT}/gone.txt`, false);

    const tabs = get(tabsState).tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].isDeleted).toBe(true);
  });

  it("deletePath of a directory cascades to every open descendant tab", async () => {
    tabsState.set({
      tabs: [codeTab(`${ROOT}/src/a.txt`), codeTab(`${ROOT}/other.txt`)],
      activeTabPath: `${ROOT}/src/a.txt`,
    });

    await deletePath(`${ROOT}/src`, true);

    expect(get(tabsState).tabs.map((t) => t.path)).toEqual([`${ROOT}/other.txt`]);
  });

  it("is a no-op on tabsState when the renamed/deleted path has no open tab", async () => {
    tabsState.set({ tabs: [codeTab(`${ROOT}/other.txt`)], activeTabPath: `${ROOT}/other.txt` });

    await rename(`${ROOT}/untouched.txt`, "renamed.txt");
    await deletePath(`${ROOT}/also-untouched.txt`, false);

    expect(get(tabsState).tabs).toEqual([codeTab(`${ROOT}/other.txt`)]);
  });
});
