import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { loadRoot } from "../../src/lib/stores/fileTree";
import { editingPath, pendingCreate } from "../../src/lib/explorer/inlineEdit";
import * as commands from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsCreateDir: vi.fn(),
  fsRename: vi.fn(),
  fsDelete: vi.fn(),
  localWorkspaceId: () => "local",
  isAppError: (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value && "message" in value,
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

describe("FileTree: inline create/rename", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
    vi.mocked(commands.fsCreateFile).mockReset();
    vi.mocked(commands.fsCreateDir).mockReset();
    vi.mocked(commands.fsRename).mockReset();
    // editingPath/pendingCreate are module-level singleton stores, so a test that
    // deliberately leaves an edit open (e.g. a rejected rename) would otherwise leak
    // into the next test's fresh render.
    editingPath.set(null);
    pendingCreate.set(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows an empty, focused input at the top of the files group in an already-expanded directory", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "src", path: `${ROOT}/src`, isDir: true, isSymlink: false },
      { name: "a.txt", path: `${ROOT}/a.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(container.querySelector(".file-tree")!);
    await fireEvent.click(await findByText("New File"));

    const input = await vi.waitFor(() => {
      const el = container.querySelector("input");
      if (!el) throw new Error("pending input not rendered yet");
      return el;
    });
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");

    const rowLabels = Array.from(container.querySelectorAll(".row")).map((el) =>
      el.textContent?.trim(),
    );
    expect(rowLabels).toEqual(["workspace", "src", "", "a.txt"]);
  });

  it("expands a collapsed directory and shows the pending row when New File is triggered on it", async () => {
    vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
      if (path === ROOT) {
        return [{ name: "src", path: `${ROOT}/src`, isDir: true, isSymlink: false }];
      }
      return [];
    });
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(await findByText("src"));
    await fireEvent.click(await findByText("New File"));

    await vi.waitFor(() => {
      if (!container.querySelector("input")) throw new Error("pending input not rendered yet");
    });
    expect(commands.fsListDir).toHaveBeenCalledWith("local", `${ROOT}/src`);
  });

  it("pre-fills and selects only the base name when renaming a file with an extension", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "notes.txt", path: `${ROOT}/notes.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(await findByText("notes.txt"));
    await fireEvent.click(await findByText("Rename"));

    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("notes.txt");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("notes".length);
  });

  it("selects the whole name when renaming a folder", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "src", path: `${ROOT}/src`, isDir: true, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(await findByText("src"));
    await fireEvent.click(await findByText("Rename"));

    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("src");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("src".length);
  });

  it("Escape cancels a rename without calling fsRename and reverts to static text", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "notes.txt", path: `${ROOT}/notes.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(await findByText("notes.txt"));
    await fireEvent.click(await findByText("Rename"));

    const input = container.querySelector("input") as HTMLInputElement;
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(commands.fsRename).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
    expect(await findByText("notes.txt")).toBeTruthy();
  });

  it("Escape cancels a pending create without calling fsCreateFile, removing the pending row", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "a.txt", path: `${ROOT}/a.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(container.querySelector(".file-tree")!);
    await fireEvent.click(await findByText("New File"));

    const input = await vi.waitFor(() => {
      const el = container.querySelector("input");
      if (!el) throw new Error("pending input not rendered yet");
      return el;
    });
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(commands.fsCreateFile).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
  });

  it("commits a rename on blur when the value is non-empty and changed", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "notes.txt", path: `${ROOT}/notes.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(await findByText("notes.txt"));
    await fireEvent.click(await findByText("Rename"));

    const input = container.querySelector("input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "renamed.txt" } });
    await fireEvent.blur(input);

    expect(commands.fsRename).toHaveBeenCalledWith(
      "local",
      `${ROOT}/notes.txt`,
      `${ROOT}/renamed.txt`,
    );
  });

  it("cancels on blur when the value is empty or unchanged", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "notes.txt", path: `${ROOT}/notes.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(await findByText("notes.txt"));
    await fireEvent.click(await findByText("Rename"));

    const input = container.querySelector("input") as HTMLInputElement;
    await fireEvent.blur(input);

    expect(commands.fsRename).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
  });

  it("leaves the input open and shows a friendly error when a rename collides with an existing name", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "notes.txt", path: `${ROOT}/notes.txt`, isDir: false, isSymlink: false },
    ]);
    // Mirrors the real backend contract: `AppError::AlreadyExists` serializes to
    // `{ code: "ALREADY_EXISTS", message: <the raw path> }` (`src-tauri/src/error.rs`) — the
    // message itself is not a sentence fit for display, so the UI must map on `code`, not echo it.
    vi.mocked(commands.fsRename).mockRejectedValue({
      code: "ALREADY_EXISTS",
      message: `${ROOT}/dup.txt`,
    });
    await loadRoot(ROOT);

    const { container, findByText, queryByText } = render(FileTree);
    await fireEvent.contextMenu(await findByText("notes.txt"));
    await fireEvent.click(await findByText("Rename"));

    const input = container.querySelector("input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "dup.txt" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(await findByText('A file or folder named "dup.txt" already exists')).toBeTruthy();
    expect(queryByText(`${ROOT}/dup.txt`)).toBeNull();
    expect(container.querySelector("input")).toBeTruthy();
    expect(document.activeElement).toBe(container.querySelector("input"));
  });

  it("resolves an in-progress rename before starting a new create (settleActiveEdit backstop)", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([
      { name: "notes.txt", path: `${ROOT}/notes.txt`, isDir: false, isSymlink: false },
    ]);
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(await findByText("notes.txt"));
    await fireEvent.click(await findByText("Rename"));
    expect(container.querySelector("input")).toBeTruthy();

    // Firing a second contextmenu event in jsdom doesn't blur the still-focused rename
    // input the way a real mousedown would, so this exercises settleActiveEdit's explicit
    // backstop rather than the usual focus-shift-triggered resolution.
    await fireEvent.contextMenu(container.querySelector(".file-tree")!);
    await fireEvent.click(await findByText("New File"));

    const input = await vi.waitFor(() => {
      const el = container.querySelector("input") as HTMLInputElement | null;
      if (!el) throw new Error("pending input not rendered yet");
      return el;
    });
    expect(input.value).toBe("");
    expect(commands.fsRename).not.toHaveBeenCalled();
  });
});
