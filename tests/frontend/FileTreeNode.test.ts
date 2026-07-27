import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { getRecentFiles } from "../../src/lib/stores/recentFiles";
import { errorToast } from "../../src/lib/stores/errorToast";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
  fsReadFile: vi.fn(),
  localWorkspaceId: () => "local",
  isAppError: (value: unknown): value is { code: string; message: string } =>
    typeof value === "object" && value !== null && "code" in value && "message" in value,
}));

const ROOT = "/workspace";

describe("FileTreeNode: recent-files write path", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
    vi.mocked(commands.fsReadFile).mockResolvedValue("file contents");
    localStorage.clear();
    workspace.set({ id: "local", root: ROOT });
  });

  afterEach(() => {
    cleanup();
    workspace.set({ id: "local", root: null });
    errorToast.set(null);
  });

  it("records a file row click in the workspace's recent-files list", async () => {
    // `workspace.root` is already set (beforeEach), so `FileTree.svelte`'s
    // own mount effect calls `loadRoot` — calling it a second time here
    // ourselves would double up on the single queued `fsListDir` response.
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([
      { name: "a.txt", path: `${ROOT}/a.txt`, isDir: false, isSymlink: false },
    ]);

    const { findByText } = render(FileTree);
    await fireEvent.click(await findByText("a.txt"));

    expect(getRecentFiles(ROOT)).toEqual([`${ROOT}/a.txt`]);
  });

  it("shows an error toast when clicking a file that fails to open (e.g. a binary file), instead of failing silently", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([
      { name: "image.png", path: `${ROOT}/image.png`, isDir: false, isSymlink: false },
    ]);
    vi.mocked(commands.fsReadFile).mockRejectedValueOnce({
      code: "NOT_UTF8",
      message: `file is not valid UTF-8: ${ROOT}/image.png`,
    });

    const { findByText } = render(FileTree);
    await fireEvent.click(await findByText("image.png"));
    await vi.waitFor(() => expect(get(errorToast)).not.toBeNull());

    expect(get(errorToast)).toContain(`file is not valid UTF-8: ${ROOT}/image.png`);
  });
});
