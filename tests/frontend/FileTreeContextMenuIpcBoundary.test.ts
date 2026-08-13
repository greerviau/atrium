import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { invoke } from "@tauri-apps/api/core";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { loadRoot } from "../../src/lib/stores/fileTree";
import { editingPath, pendingCreate } from "../../src/lib/explorer/inlineEdit";

/**
 * Issue #463 part 1, at the real IPC boundary: `FileTreeContextMenu.test.ts`
 * mocks `commands.ts` wholesale, which can't catch a boundary-normalization
 * gap — `FileTree.svelte`'s `startNewFile` computes `dirOf(path)` for a
 * file row, and that has to land on the *exact same string* the tree's own
 * node is keyed by (`beginCreate`'s `loadChildren`/`patchNode`, and
 * `FileTreeNode.svelte`'s `pendingCreate.parentPath === node.entry.path`
 * check, are both raw `===`). `dirOf` has always emitted a forward-slash
 * result for Windows-shaped input; what was missing was the tree's own
 * `entry.path` being in that same form, which only the real `fs_list_dir`
 * boundary normalization guarantees. This file mocks one level lower
 * (`invoke`) and renders the real `FileTree.svelte`, so it exercises that
 * normalization instead of assuming it.
 */

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

vi.mock("../../src/lib/ipc/reveal", () => ({
  revealInFinder: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const ROOT = "C:/ws"; // already canonical, as every real workspace root is

beforeEach(() => {
  invokeMock.mockReset();
  editingPath.set(null);
  pendingCreate.set(null);
});

afterEach(() => {
  cleanup();
});

describe("New File from a selected file row, under a Windows root (issue #463 part 1)", () => {
  it("targets the file's own directory, expands it, and renders the inline input there", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "fs_list_dir") {
        const path = (args as { path: string }).path;
        // Rust hands back native, unnormalized (spelling A) paths.
        if (path === ROOT) {
          return [{ name: "sub", path: "C:\\ws\\sub", isDir: true, isSymlink: false }];
        }
        if (path === "C:/ws/sub") {
          return [{ name: "note.txt", path: "C:\\ws\\sub\\note.txt", isDir: false, isSymlink: false }];
        }
        throw new Error(`unexpected fs_list_dir path: ${path}`);
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    // Expand "sub" so "note.txt" has a row to right-click.
    await fireEvent.click(await findByText("sub"));
    const noteRow = await findByText("note.txt");

    await fireEvent.contextMenu(noteRow);
    await fireEvent.click(await findByText("New File"));

    const input = await vi.waitFor(() => {
      const el = container.querySelector("input");
      if (!el) throw new Error("pending input not rendered yet");
      return el;
    });

    // The inline input renders as a row inside "sub" — the file's own
    // parent directory, not the workspace root and not "sub" itself
    // missing its expansion. Before the fix, `pendingCreate.parentPath`
    // (forward-slash, from `dirOf`) never matched "sub"'s own raw,
    // still-native-backslash `entry.path`, so no row for the input ever
    // rendered under it at all.
    expect(input).toBeTruthy();
    const rowLabels = Array.from(container.querySelectorAll(".row")).map((el) => el.textContent?.trim());
    const subIndex = rowLabels.indexOf("sub");
    expect(subIndex).toBeGreaterThanOrEqual(0);
    expect(rowLabels[subIndex + 1]).toBe(""); // the empty pending-create row, immediately under "sub"
    expect(rowLabels[subIndex + 2]).toBe("note.txt");
  });
});
