import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { loadRoot } from "../../src/lib/stores/fileTree";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsCreateDir: vi.fn(),
  fsRename: vi.fn(),
  fsDelete: vi.fn(),
  localWorkspaceId: () => "local",
}));

const ROOT = "/workspace";

describe("FileTree: root context menu", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("omits Rename and Delete on the root row's context menu", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "file.txt", path: `${ROOT}/file.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { findByText, queryByText } = render(FileTree);
    await fireEvent.contextMenu(await findByText("workspace"));

    expect(await findByText("New File")).toBeTruthy();
    expect(await findByText("New Folder")).toBeTruthy();
    expect(await findByText("Reveal in Finder")).toBeTruthy();
    expect(queryByText("Rename")).toBeNull();
    expect(queryByText("Delete")).toBeNull();
  });

  it("keeps all four actions on a non-root row's context menu", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "file.txt", path: `${ROOT}/file.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { findByText } = render(FileTree);
    await fireEvent.contextMenu(await findByText("file.txt"));

    expect(await findByText("New File")).toBeTruthy();
    expect(await findByText("New Folder")).toBeTruthy();
    expect(await findByText("Rename")).toBeTruthy();
    expect(await findByText("Delete")).toBeTruthy();
    expect(await findByText("Reveal in Finder")).toBeTruthy();
  });

  it("opens the root context menu when right-clicking empty space below the rows", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "file.txt", path: `${ROOT}/file.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { container, findByText, queryByText } = render(FileTree);
    await fireEvent.contextMenu(container.querySelector(".file-tree")!);

    expect(await findByText("New File")).toBeTruthy();
    expect(await findByText("New Folder")).toBeTruthy();
    expect(await findByText("Reveal in Finder")).toBeTruthy();
    expect(queryByText("Rename")).toBeNull();
    expect(queryByText("Delete")).toBeNull();
  });

  it("creates a new file at the workspace root when triggered from empty space", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "file.txt", path: `${ROOT}/file.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(container.querySelector(".file-tree")!);
    await fireEvent.click(await findByText("New File"));

    const input = container.querySelector("input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "new.txt" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(commands.fsCreateFile).toHaveBeenCalledWith("local", `${ROOT}/new.txt`);
  });
});
