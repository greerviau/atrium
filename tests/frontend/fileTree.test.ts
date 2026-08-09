import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import {
  fileTree,
  loadRoot,
  loadChildren,
  collapse,
  toggleExpanded,
  refreshDirectoryContaining,
  expandToPath,
} from "../../src/lib/stores/fileTree";
import FileTree from "../../src/lib/explorer/FileTree.svelte";
import { pendingCreate } from "../../src/lib/explorer/inlineEdit";
import * as commands from "../../src/lib/ipc/commands";
import type { DirEntry } from "../../src/lib/ipc/commands";

vi.mock("../../src/lib/ipc/commands", () => ({
  fsListDir: vi.fn(),
  localWorkspaceId: () => "local",
}));

const ROOT = "/workspace";

function file(name: string): DirEntry {
  return { name, path: `${ROOT}/${name}`, isDir: false, isSymlink: false };
}

function dir(name: string): DirEntry {
  return { name, path: `${ROOT}/${name}`, isDir: true, isSymlink: false };
}

function childPaths(): string[] | undefined {
  return get(fileTree).root?.children?.map((n) => n.entry.path);
}

describe("fileTree: root-level refresh", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
  });

  it("wraps the fetched listing in a correctly-named, expanded root", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt")]);
    await loadRoot(ROOT);

    const state = get(fileTree);
    expect(state.root?.entry).toEqual({
      name: "workspace",
      path: ROOT,
      isDir: true,
      isSymlink: false,
    });
    expect(state.root?.expanded).toBe(true);
  });

  it("shows a UI-initiated top-level file creation without a page reload", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt")]);
    await loadRoot(ROOT);

    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt"), file("b.txt")]);
    await loadChildren(ROOT); // contextMenu.newFile calls loadChildren(dirPath) with dirPath === ROOT

    expect(childPaths()).toEqual([`${ROOT}/a.txt`, `${ROOT}/b.txt`]);
  });

  it("reflects a UI-initiated top-level delete", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt"), file("b.txt")]);
    await loadRoot(ROOT);

    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("b.txt")]);
    await loadChildren(ROOT); // contextMenu.deletePath calls loadChildren(dirOf(path)) === ROOT

    expect(childPaths()).toEqual([`${ROOT}/b.txt`]);
  });

  it("reflects a UI-initiated top-level rename", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("old.txt")]);
    await loadRoot(ROOT);

    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("new.txt")]);
    await loadChildren(ROOT); // contextMenu.rename calls loadChildren(dirOf(path)) === ROOT

    expect(childPaths()).toEqual([`${ROOT}/new.txt`]);
  });

  it("shows an externally-created top-level file once refreshDirectoryContaining fires from fs:changed", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt")]);
    await loadRoot(ROOT);

    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt"), file("external.txt")]);
    await refreshDirectoryContaining(`${ROOT}/external.txt`);

    expect(childPaths()).toContain(`${ROOT}/external.txt`);
  });

  it("reflects an externally-deleted top-level file once refreshDirectoryContaining fires from fs:changed", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt"), file("b.txt")]);
    await loadRoot(ROOT);

    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt")]);
    await refreshDirectoryContaining(`${ROOT}/b.txt`);

    expect(childPaths()).toEqual([`${ROOT}/a.txt`]);
  });

  it("reflects an externally-renamed top-level file once refreshDirectoryContaining fires from fs:changed", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("old.txt")]);
    await loadRoot(ROOT);

    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("new.txt")]);
    await refreshDirectoryContaining(`${ROOT}/new.txt`);

    expect(childPaths()).toEqual([`${ROOT}/new.txt`]);
  });

  it("resets to a fresh unexpanded node when an expanded root-level directory is renamed", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([dir("sub")]);
    await loadRoot(ROOT);

    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("nested.txt")]);
    await loadChildren(`${ROOT}/sub`);
    expect(get(fileTree).root?.children?.find((n) => n.entry.name === "sub")?.expanded).toBe(true);

    // "sub" renamed to "renamed" at the root: its path changes, so the fresh
    // listing can't match it to the old node and it comes back as a fresh, unexpanded node.
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([dir("renamed")]);
    await loadChildren(ROOT); // contextMenu.rename calls loadChildren(dirOf(path)) === ROOT

    const renamedNode = get(fileTree).root?.children?.find((n) => n.entry.name === "renamed");
    expect(renamedNode?.expanded).toBe(false);
    expect(renamedNode?.children).toBeUndefined();
  });

  it("preserves an expanded top-level sibling's state across an unrelated root-level change", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([dir("sub"), file("a.txt")]);
    await loadRoot(ROOT);

    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("nested.txt")]);
    const subNode = get(fileTree).root?.children?.find((n) => n.entry.name === "sub");
    expect(subNode).toBeTruthy();
    await loadChildren(subNode!.entry.path);

    const expandedBefore = get(fileTree).root?.children?.find((n) => n.entry.name === "sub");
    expect(expandedBefore?.expanded).toBe(true);
    expect(expandedBefore?.children?.map((c) => c.entry.name)).toEqual(["nested.txt"]);

    // Unrelated root-level change: a new sibling file appears alongside "sub".
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([
      dir("sub"),
      file("a.txt"),
      file("b.txt"),
    ]);
    await refreshDirectoryContaining(`${ROOT}/b.txt`);

    expect(childPaths()).toEqual([`${ROOT}/sub`, `${ROOT}/a.txt`, `${ROOT}/b.txt`]);

    const subAfter = get(fileTree).root?.children?.find((n) => n.entry.name === "sub");
    expect(subAfter?.expanded).toBe(true);
    expect(subAfter?.children?.map((c) => c.entry.name)).toEqual(["nested.txt"]);
  });

  it("does not refetch when the root is collapsed and re-expanded", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt")]);
    await loadRoot(ROOT);
    expect(commands.fsListDir).toHaveBeenCalledTimes(1);

    collapse(ROOT);
    expect(get(fileTree).root?.expanded).toBe(false);
    expect(commands.fsListDir).toHaveBeenCalledTimes(1);

    const root = get(fileTree).root!;
    await toggleExpanded(root);

    expect(get(fileTree).root?.expanded).toBe(true);
    expect(get(fileTree).root?.children?.map((n) => n.entry.name)).toEqual(["a.txt"]);
    expect(commands.fsListDir).toHaveBeenCalledTimes(1);
  });

  it("patches the right descendant when loading a nested path", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([dir("sub")]);
    await loadRoot(ROOT);

    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("nested.txt")]);
    await loadChildren(`${ROOT}/sub`);

    const state = get(fileTree);
    expect(state.root?.children).toHaveLength(1);
    const subNode = state.root?.children?.[0];
    expect(subNode?.entry.path).toBe(`${ROOT}/sub`);
    expect(subNode?.expanded).toBe(true);
    expect(subNode?.children?.map((n) => n.entry.name)).toEqual(["nested.txt"]);
  });

  it("no-ops refreshDirectoryContaining when the root has been explicitly collapsed", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt")]);
    await loadRoot(ROOT);
    expect(commands.fsListDir).toHaveBeenCalledTimes(1);

    collapse(ROOT);

    await refreshDirectoryContaining(`${ROOT}/b.txt`);
    expect(commands.fsListDir).toHaveBeenCalledTimes(1);
    expect(get(fileTree).root?.children?.map((n) => n.entry.name)).toEqual(["a.txt"]);
  });
});

describe("fileTree: expandToPath (issue #400)", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
  });

  it("expands a directory whose own node path uses backslashes while the target path uses forward slashes (a markdown link's normalized path, on Windows)", async () => {
    const winRoot = "C:\\ws";
    const winSrc = "C:\\ws\\src";
    const winIndex = "C:\\ws\\src\\index.ts";
    vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
      if (path === winRoot) return [{ name: "src", path: winSrc, isDir: true, isSymlink: false }];
      if (path === winSrc) return [{ name: "index.ts", path: winIndex, isDir: false, isSymlink: false }];
      return [];
    });
    await loadRoot(winRoot);
    vi.mocked(commands.fsListDir).mockClear();

    // The activeTabPath a markdown link's relative-path resolution would
    // produce for this same file: forward-slashed, unlike the node's own
    // native (backslash) `entry.path`.
    await expandToPath("C:/ws/src/index.ts", () => false);

    // Expanding by walking the tree (not slicing the target path into
    // ancestor strings) means the real, native-separator node path is what
    // gets passed to `loadChildren`/`fsListDir` — a string-slice approach
    // would instead produce a forward-slashed ancestor that matches no node
    // and silently expands nothing.
    expect(commands.fsListDir).toHaveBeenCalledWith("local", winSrc);
    const src = get(fileTree).root?.children?.find((n) => n.entry.path === winSrc);
    expect(src?.expanded).toBe(true);
    expect(src?.children?.map((n) => n.entry.path)).toEqual([winIndex]);
  });

  it("aborts a multi-level expansion partway through once isStale reports the target is no longer current", async () => {
    const a = `${ROOT}/a`;
    const b = `${ROOT}/a/b`;
    const target = `${ROOT}/a/b/file.txt`;
    vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
      if (path === ROOT) return [{ name: "a", path: a, isDir: true, isSymlink: false }];
      if (path === a) return [{ name: "b", path: b, isDir: true, isSymlink: false }];
      if (path === b) return [{ name: "file.txt", path: target, isDir: false, isSymlink: false }];
      return [];
    });
    await loadRoot(ROOT);
    vi.mocked(commands.fsListDir).mockClear();

    let callsSinceExpand = 0;
    vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
      callsSinceExpand++;
      if (path === a) return [{ name: "b", path: b, isDir: true, isSymlink: false }];
      if (path === b) return [{ name: "file.txt", path: target, isDir: false, isSymlink: false }];
      return [];
    });

    // Stale from the very next check onward — the loop expands "a" (the
    // first ancestor, already in flight before staleness could be checked
    // again) but must never go on to expand "b".
    await expandToPath(target, () => callsSinceExpand > 0);

    expect(commands.fsListDir).toHaveBeenCalledTimes(1);
    expect(commands.fsListDir).toHaveBeenCalledWith("local", a);
    const nodeA = get(fileTree).root?.children?.find((n) => n.entry.path === a);
    expect(nodeA?.expanded).toBe(true);
    const nodeB = nodeA?.children?.find((n) => n.entry.path === b);
    expect(nodeB?.expanded ?? false).toBe(false);
  });

  it("is a no-op for a path outside the workspace root", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt")]);
    await loadRoot(ROOT);
    vi.mocked(commands.fsListDir).mockClear();

    await expandToPath("/elsewhere/file.txt", () => false);

    expect(commands.fsListDir).not.toHaveBeenCalled();
  });

  it("expands a nested directory when the workspace root itself is \"/\"", async () => {
    vi.mocked(commands.fsListDir).mockImplementation(async (_workspaceId, path) => {
      if (path === "/") return [{ name: "a", path: "/a", isDir: true, isSymlink: false }];
      if (path === "/a") return [{ name: "b.txt", path: "/a/b.txt", isDir: false, isSymlink: false }];
      return [];
    });
    await loadRoot("/");
    vi.mocked(commands.fsListDir).mockClear();

    await expandToPath("/a/b.txt", () => false);

    expect(commands.fsListDir).toHaveBeenCalledWith("local", "/a");
    const nodeA = get(fileTree).root?.children?.find((n) => n.entry.path === "/a");
    expect(nodeA?.expanded).toBe(true);
  });
});

describe("FileTree: scrollbar auto-hide", () => {
  beforeEach(() => {
    vi.mocked(commands.fsListDir).mockReset();
  });

  afterEach(() => {
    cleanup();
    // pendingCreate is a module-level singleton store; the new-entry-input test below
    // deliberately leaves it set (no commit is fired), which would otherwise leak into
    // whichever test runs next.
    pendingCreate.set(null);
  });

  it("renders the root element with the scrollbar-autohide class", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt")]);
    await loadRoot(ROOT);

    const { container } = render(FileTree);

    expect(container.querySelector(".file-tree")?.classList.contains("scrollbar-autohide")).toBe(true);
  });

  it("marks the root element as scrolling on a scroll event", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt")]);
    await loadRoot(ROOT);

    const { container } = render(FileTree);
    const treeEl = container.querySelector(".file-tree")!;

    await fireEvent.scroll(treeEl);

    expect(treeEl.getAttribute("data-scrolling")).toBe("true");
  });

  it("guards the tree container against accidental text selection (its empty trailing space no longer paints a selection highlight)", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValueOnce([file("a.txt")]);
    await loadRoot(ROOT);

    const { container } = render(FileTree);
    const treeEl = container.querySelector(".file-tree");

    expect(treeEl).toBeTruthy();
    expect(window.getComputedStyle(treeEl!).userSelect).toBe("none");
  });

  it("re-enables selection on the New File/New Folder inline input despite the tree container's user-select: none", async () => {
    vi.mocked(commands.fsListDir).mockResolvedValue([file("a.txt")]);
    await loadRoot(ROOT);

    const { container, findByText } = render(FileTree);
    await fireEvent.contextMenu(container.querySelector(".file-tree")!);
    await fireEvent.click(await findByText("New File"));

    const input = await vi.waitFor(() => {
      const el = container.querySelector("input");
      if (!el) throw new Error("inline-create input not yet rendered");
      return el;
    });

    expect(window.getComputedStyle(input).userSelect).toBe("text");
  });
});
