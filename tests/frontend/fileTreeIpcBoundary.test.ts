import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fileTree, loadRoot, loadChildren, refreshDirectoryContaining } from "../../src/lib/stores/fileTree";
import { onFsChanged, type FsChangeEvent } from "../../src/lib/ipc/events";

/**
 * Issue #463 part 2, at the real IPC boundary: `fileTree.test.ts` mocks
 * `commands.ts` wholesale, which is the right level for `fileTree.ts`'s own
 * tree mechanics but can't catch a boundary-normalization gap — the actual
 * bug was `fs_list_dir` and an `fs:changed` watcher event landing under
 * different spellings, with `findNode`/`patchNode`'s raw `===` unable to
 * reconcile them. This file mocks one level lower (`invoke`/`listen`) and
 * wires the same `onFsChanged` → `refreshDirectoryContaining` path
 * `App.svelte` uses, so it exercises the real `commands.ts`/`events.ts`
 * normalization, the way `markdownLinkClickIpcBoundary.test.ts` does for
 * the markdown-link half of this same defect class.
 */

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

/** Mirrors `App.svelte`'s own `onFsChanged` subscriber (the create/rename/remove branch that reaches `refreshDirectoryContaining`), so this test exercises the real reconciliation shape rather than inventing a simplified stand-in for it. */
async function wireFsChangedToFileTree(): Promise<(event: FsChangeEvent) => void> {
  let handler: ((event: FsChangeEvent) => void) | undefined;
  listenMock.mockImplementation((_id, h) => {
    handler = (raw: unknown) => (h as (e: unknown) => void)(raw);
    return Promise.resolve(() => {});
  });
  await onFsChanged((event) => {
    if (event.kind === "rename" && event.fromPath) {
      void refreshDirectoryContaining(event.fromPath);
    }
    void refreshDirectoryContaining(event.path);
  });
  return (event: FsChangeEvent) => handler!({ payload: event } as never);
}

describe("fileTree reconciliation through the real IPC boundary (issue #463 part 2)", () => {
  it("finds and patches a nested directory when an fs:changed create event arrives in native Windows form", async () => {
    // `root` is already canonical here — exactly the real app's invariant,
    // since it always originates from an already-normalized `commands.ts`
    // return value (`workspaceOpenFolderDialog`/`workspaceGetRecents`). The
    // divergence this test exercises is `fs_list_dir`'s and `fs:changed`'s
    // own native (spelling A) entries against that canonical tree.
    const root = "C:/ws";
    const winSub = "C:\\ws\\sub";

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "fs_list_dir") {
        const path = (args as { path: string }).path;
        if (path === root) {
          return [{ name: "sub", path: winSub, isDir: true, isSymlink: false }];
        }
        if (path === "C:/ws/sub") {
          return [{ name: "a.txt", path: "C:\\ws\\sub\\a.txt", isDir: false, isSymlink: false }];
        }
        throw new Error(`unexpected fs_list_dir path: ${path}`);
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await loadRoot(root);
    const subNode = get(fileTree).root?.children?.find((n) => n.entry.name === "sub");
    expect(subNode).toBeTruthy();
    // The IPC boundary already canonicalized this — no more backslashes.
    expect(subNode!.entry.path).toBe("C:/ws/sub");
    await loadChildren(subNode!.entry.path); // expand it, as the explorer would on click

    // A new file now exists in "sub"; the next listing reflects it.
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "fs_list_dir") {
        const path = (args as { path: string }).path;
        if (path === "C:/ws/sub") {
          return [
            { name: "a.txt", path: "C:\\ws\\sub\\a.txt", isDir: false, isSymlink: false },
            { name: "new.txt", path: "C:\\ws\\sub\\new.txt", isDir: false, isSymlink: false },
          ];
        }
        throw new Error(`unexpected fs_list_dir path: ${path}`);
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const emit = await wireFsChangedToFileTree();
    // Rust reports the watcher event in native, unnormalized form (spelling
    // A) — exactly as `fs_watch.rs` actually produces it.
    emit({ workspaceId: "local", path: "C:\\ws\\sub\\new.txt", kind: "create" });
    await vi.waitFor(() => {
      const sub = get(fileTree).root?.children?.find((n) => n.entry.name === "sub");
      expect(sub?.children?.map((c) => c.entry.name)).toEqual(["a.txt", "new.txt"]);
    });
  });

  it("finds and patches the workspace root itself when an fs:changed event lands directly under it", async () => {
    const root = "C:/ws"; // already canonical — see the previous test's comment

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "fs_list_dir") {
        const path = (args as { path: string }).path;
        if (path === root) return [{ name: "a.txt", path: "C:\\ws\\a.txt", isDir: false, isSymlink: false }];
        throw new Error(`unexpected fs_list_dir path: ${path}`);
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    await loadRoot(root);

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "fs_list_dir") {
        const path = (args as { path: string }).path;
        if (path === "C:/ws") {
          return [
            { name: "a.txt", path: "C:\\ws\\a.txt", isDir: false, isSymlink: false },
            { name: "b.txt", path: "C:\\ws\\b.txt", isDir: false, isSymlink: false },
          ];
        }
        throw new Error(`unexpected fs_list_dir path: ${path}`);
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const emit = await wireFsChangedToFileTree();
    emit({ workspaceId: "local", path: "C:\\ws\\b.txt", kind: "create" });

    await vi.waitFor(() => {
      expect(get(fileTree).root?.children?.map((n) => n.entry.name)).toEqual(["a.txt", "b.txt"]);
    });
  });
});
