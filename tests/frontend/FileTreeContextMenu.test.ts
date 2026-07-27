import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { loadRoot } from "../../src/lib/stores/fileTree";
import { editingPath, pendingCreate } from "../../src/lib/explorer/inlineEdit";
import * as commands from "../../src/lib/ipc/commands";
import * as reveal from "../../src/lib/ipc/reveal";

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

vi.mock("../../src/lib/ipc/reveal", () => ({
  revealInFinder: vi.fn(),
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

// Cross-platform matrix for issue #267: every chord below must fire on its
// own platform's modifier (Cmd on Mac, Ctrl elsewhere) and must NOT fire on
// the other platform's modifier alone, pinning `isMacPlatform`'s branch in
// both `FileTreeNode.svelte` and `FileTree.svelte`.
const PLATFORM_CASES = [
  {
    label: "macOS (Cmd)",
    stubMac: true,
    // `metaKey` alone is the Mac chord.
    mod: { metaKey: true },
    // Ctrl alone (no Meta) must not fire on Mac.
    wrongMod: { ctrlKey: true },
  },
  {
    label: "non-Mac (Ctrl)",
    stubMac: false,
    // `ctrlKey` alone is the non-Mac chord.
    mod: { ctrlKey: true },
    // Meta alone (no Ctrl) must not fire off Mac.
    wrongMod: { metaKey: true },
  },
];

describe.each(PLATFORM_CASES)(
  "FileTree: keyboard shortcuts (issues #156, #267) - $label",
  ({ stubMac, mod, wrongMod }) => {
    // jsdom's default `navigator.platform` is already non-Mac-like, so the
    // "non-Mac" case needs no stub; only "macOS" overrides it, and only that
    // case needs to restore it afterward.
    const originalPlatform = navigator.platform;

    beforeEach(() => {
      vi.mocked(commands.fsListDir).mockReset();
      vi.mocked(commands.fsCreateFile).mockReset();
      vi.mocked(commands.fsCreateDir).mockReset();
      vi.mocked(commands.fsDelete).mockReset();
      vi.mocked(reveal.revealInFinder).mockReset().mockResolvedValue(undefined);
      editingPath.set(null);
      pendingCreate.set(null);
      if (stubMac) {
        Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
      }
    });

    afterEach(() => {
      cleanup();
      if (stubMac) {
        Object.defineProperty(navigator, "platform", {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    async function renderWithOneFile() {
      vi.mocked(commands.fsListDir).mockResolvedValue([
        { name: "notes.txt", path: `${ROOT}/notes.txt`, isDir: false, isSymlink: false },
      ]);
      await loadRoot(ROOT);
      return render(FileTree);
    }

    it("the platform modifier on a focused row creates a new file alongside it", async () => {
      const { container, findByText } = await renderWithOneFile();
      const row = (await findByText("notes.txt")).closest(".row") as HTMLElement;
      row.focus();

      await fireEvent.keyDown(row, { key: "n", ...mod });

      const input = await vi.waitFor(() => {
        const el = container.querySelector("input");
        if (!el) throw new Error("pending input not rendered yet");
        return el;
      });
      await fireEvent.input(input, { target: { value: "new.txt" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(commands.fsCreateFile).toHaveBeenCalledWith("local", `${ROOT}/new.txt`);
    });

    it("the platform modifier+Shift on a focused row creates a new folder alongside it", async () => {
      const { container, findByText } = await renderWithOneFile();
      const row = (await findByText("notes.txt")).closest(".row") as HTMLElement;
      row.focus();

      await fireEvent.keyDown(row, { key: "n", ...mod, shiftKey: true });

      const input = await vi.waitFor(() => {
        const el = container.querySelector("input");
        if (!el) throw new Error("pending input not rendered yet");
        return el;
      });
      await fireEvent.input(input, { target: { value: "newdir" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(commands.fsCreateDir).toHaveBeenCalledWith("local", `${ROOT}/newdir`);
    });

    it("does not dispatch New File on the other platform's modifier alone (regression guard)", async () => {
      const { container, findByText } = await renderWithOneFile();
      const row = (await findByText("notes.txt")).closest(".row") as HTMLElement;
      row.focus();

      await fireEvent.keyDown(row, { key: "n", ...wrongMod });

      expect(container.querySelector("input")).toBeNull();
      expect(commands.fsCreateFile).not.toHaveBeenCalled();
      expect(commands.fsCreateDir).not.toHaveBeenCalled();
    });

    it("F2 on a focused row opens an inline rename prefilled with its name", async () => {
      const { container, findByText } = await renderWithOneFile();
      const row = (await findByText("notes.txt")).closest(".row") as HTMLElement;
      row.focus();

      await fireEvent.keyDown(row, { key: "F2" });

      const input = container.querySelector("input") as HTMLInputElement;
      expect(input.value).toBe("notes.txt");
    });

    it("the platform modifier+Backspace on a focused row opens the confirm-delete modal without calling fsDelete directly", async () => {
      const { container, findByText } = await renderWithOneFile();
      const row = (await findByText("notes.txt")).closest(".row") as HTMLElement;
      row.focus();

      await fireEvent.keyDown(row, { key: "Backspace", ...mod });

      expect(container.querySelector(".modal-backdrop")).not.toBeNull();
      expect(commands.fsDelete).not.toHaveBeenCalled();

      await fireEvent.click(container.querySelector(".modal .danger")!);
      expect(commands.fsDelete).toHaveBeenCalledWith("local", `${ROOT}/notes.txt`, false);
    });

    it("the platform modifier+Alt+R on a focused row reveals it in Finder", async () => {
      const { findByText } = await renderWithOneFile();
      const row = (await findByText("notes.txt")).closest(".row") as HTMLElement;
      row.focus();

      await fireEvent.keyDown(row, { key: "r", ...mod, altKey: true });

      expect(reveal.revealInFinder).toHaveBeenCalledWith(`${ROOT}/notes.txt`);
    });

    it("F2 and the platform modifier+Backspace are no-ops on a focused root row, mirroring the right-click menu's own root exclusion", async () => {
      const { container, findByText } = await renderWithOneFile();
      const rootRow = (await findByText("workspace")).closest(".row") as HTMLElement;
      rootRow.focus();

      await fireEvent.keyDown(rootRow, { key: "F2" });
      expect(container.querySelector("input")).toBeNull();

      await fireEvent.keyDown(rootRow, { key: "Backspace", ...mod });
      expect(container.querySelector(".modal-backdrop")).toBeNull();
    });

    it("the platform modifier+N on the tree container (nothing focused) creates a new file at the workspace root", async () => {
      const { container, findByText } = await renderWithOneFile();

      await fireEvent.keyDown(container.querySelector(".file-tree")!, { key: "n", ...mod });

      const input = await vi.waitFor(() => {
        const el = container.querySelector("input");
        if (!el) throw new Error("pending input not rendered yet");
        return el;
      });
      await fireEvent.input(input, { target: { value: "root-file.txt" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(commands.fsCreateFile).toHaveBeenCalledWith("local", `${ROOT}/root-file.txt`);
      await findByText("notes.txt"); // sanity: the tree is still the one we rendered
    });

    it("does not dispatch the container-level New File fallback on the other platform's modifier alone (regression guard)", async () => {
      const { container } = await renderWithOneFile();

      await fireEvent.keyDown(container.querySelector(".file-tree")!, { key: "n", ...wrongMod });

      expect(container.querySelector("input")).toBeNull();
      expect(commands.fsCreateFile).not.toHaveBeenCalled();
    });

    it("F2 / platform-modifier+Backspace / platform-modifier+Alt+R are no-ops on the tree container fallback (no row focused)", async () => {
      const { container } = await renderWithOneFile();
      const treeEl = container.querySelector(".file-tree")!;

      await fireEvent.keyDown(treeEl, { key: "F2" });
      expect(container.querySelector("input")).toBeNull();

      await fireEvent.keyDown(treeEl, { key: "Backspace", ...mod });
      expect(container.querySelector(".modal-backdrop")).toBeNull();

      await fireEvent.keyDown(treeEl, { key: "r", ...mod, altKey: true });
      expect(reveal.revealInFinder).not.toHaveBeenCalled();
    });

    it("does not double-handle a row's own chord at the container level (bubbling guard)", async () => {
      const { container, findByText } = await renderWithOneFile();
      const row = (await findByText("notes.txt")).closest(".row") as HTMLElement;
      row.focus();

      // A real keydown on the row bubbles up through `.file-tree` exactly like
      // this: `fireEvent.keyDown(row, ...)` dispatches a real, bubbling
      // KeyboardEvent, so the container's own `onkeydown` also receives it —
      // it must recognize `event.target` is still the row, not itself, and
      // decline to also dispatch a second, root-targeted action.
      await fireEvent.keyDown(row, { key: "n", ...mod });

      const inputs = await vi.waitFor(() => {
        const els = container.querySelectorAll("input");
        if (els.length === 0) throw new Error("pending input not rendered yet");
        return els;
      });
      expect(inputs).toHaveLength(1);
      // The row's own dispatch targets notes.txt's own directory (the
      // workspace root, since notes.txt is a root-level file) — asserting a
      // second dispatch didn't fire is really about there being only one
      // pending-create row, not two competing ones.
    });
  },
);
