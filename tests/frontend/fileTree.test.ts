import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  fileTree,
  loadRoot,
  loadChildren,
  collapse,
  toggleExpanded,
  refreshDirectoryContaining,
} from "../../src/lib/stores/fileTree";
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
