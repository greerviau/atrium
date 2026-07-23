import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { loadRoot } from "../../src/lib/stores/fileTree";
import { importPathsInto } from "../../src/lib/explorer/importExternalPaths";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsCreateDir: vi.fn(),
  fsRename: vi.fn(),
  fsDelete: vi.fn(),
  fsImportExternalPaths: vi.fn(),
  localWorkspaceId: () => "local",
  isAppError: (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value && "message" in value,
}));

const ROOT = "/workspace";

describe("FileTree: reflects an explorer import", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
    vi.mocked(commands.fsImportExternalPaths).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the newly copied entry once importPathsInto's mutate-then-reload completes", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([
      { name: "notes.txt", path: `${ROOT}/notes.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    vi.mocked(commands.fsImportExternalPaths).mockResolvedValue(undefined);
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([
      { name: "notes.txt", path: `${ROOT}/notes.txt`, isDir: false, isSymlink: false },
      { name: "photo.png", path: `${ROOT}/photo.png`, isDir: false, isSymlink: false },
    ]);

    const { findByText } = render(FileTree);
    expect(await findByText("notes.txt")).toBeTruthy();

    await importPathsInto(ROOT, ["/Users/dev/Desktop/photo.png"]);

    expect(commands.fsImportExternalPaths).toHaveBeenCalledWith("local", ROOT, [
      "/Users/dev/Desktop/photo.png",
    ]);
    expect(await findByText("photo.png")).toBeTruthy();
  });
});
