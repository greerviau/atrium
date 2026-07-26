import { describe, it, expect, vi, beforeEach } from "vitest";
import { rename, movePath, deletePath } from "../../src/lib/explorer/contextMenu";
import { workspace } from "../../src/lib/stores/workspace";
import { recordFileOpened, getRecentFiles } from "../../src/lib/stores/recentFiles";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
  fsRename: vi.fn(),
  fsDelete: vi.fn(),
  localWorkspaceId: () => "local",
}));

const ROOT = "/proj";

describe("contextMenu: pruning recentFiles on rename/move/delete", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset().mockResolvedValue([]);
    vi.mocked(commands.fsRename).mockReset().mockResolvedValue(undefined);
    vi.mocked(commands.fsDelete).mockReset().mockResolvedValue(undefined);
    localStorage.clear();
    workspace.set({ id: "local", root: ROOT });
  });

  it("prunes the old path's recent-files entry on rename", async () => {
    recordFileOpened(ROOT, `${ROOT}/old.txt`);

    await rename(`${ROOT}/old.txt`, "new.txt");

    expect(getRecentFiles(ROOT)).toEqual([]);
  });

  it("prunes every recorded path under a renamed directory", async () => {
    recordFileOpened(ROOT, `${ROOT}/src/a.txt`);
    recordFileOpened(ROOT, `${ROOT}/other.txt`);

    await rename(`${ROOT}/src`, "renamed");

    expect(getRecentFiles(ROOT)).toEqual([`${ROOT}/other.txt`]);
  });

  it("prunes the source path's recent-files entry on move", async () => {
    recordFileOpened(ROOT, `${ROOT}/src/a.txt`);

    await movePath(`${ROOT}/src/a.txt`, `${ROOT}/dest`);

    expect(getRecentFiles(ROOT)).toEqual([]);
  });

  it("prunes the deleted path's recent-files entry on delete", async () => {
    recordFileOpened(ROOT, `${ROOT}/gone.txt`);

    await deletePath(`${ROOT}/gone.txt`, false);

    expect(getRecentFiles(ROOT)).toEqual([]);
  });

  it("prunes every recorded path under a deleted directory", async () => {
    recordFileOpened(ROOT, `${ROOT}/src/a.txt`);
    recordFileOpened(ROOT, `${ROOT}/src/b.txt`);
    recordFileOpened(ROOT, `${ROOT}/other.txt`);

    await deletePath(`${ROOT}/src`, true);

    expect(getRecentFiles(ROOT)).toEqual([`${ROOT}/other.txt`]);
  });
});
