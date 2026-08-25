import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace } from "../../src/lib/stores/workspace";
import { explorerVisible, terminalVisible } from "../../src/lib/stores/layout";
import { tabsState } from "../../src/lib/stores/tabs";
import { fileTree } from "../../src/lib/stores/fileTree";
import { errorToast } from "../../src/lib/stores/errorToast";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import { onFsChanged, type FsChangeEvent } from "../../src/lib/ipc/events";
import * as commands from "../../src/lib/ipc/commands";
import type { DirEntry } from "../../src/lib/ipc/commands";

// Issue #470, end-to-end through the seam a user actually hits: a file
// deleted from Finder produces one `fs:changed` remove event, which must
// travel App.svelte's real handler -> the real fileTree store -> the real
// FileTree component and take the explorer row with it. FileTree is
// deliberately NOT stubbed here (unlike App.fsChangedRouting.test.ts, which
// only covers tab routing) — the reported symptom is the row surviving, so
// the assertion has to be on rendered DOM rows.
vi.mock("../../src/lib/terminal/TerminalPane.svelte", async () => {
  const mod = await import("./TerminalPaneStub.svelte");
  return { default: mod.default };
});

const ROOT = "/projects/demo";

/** Directory listings the stubbed `fsListDir` serves, mutated to model the external delete. */
let fakeFs = new Map<string, DirEntry[]>();

vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    workspaceTakePendingOpen: vi.fn().mockResolvedValue([]),
    appConfirmClose: vi.fn().mockResolvedValue(undefined),
    fsReadFile: vi.fn().mockResolvedValue("content\n"),
    // The welcome screen renders while no project is open, and it loads the
    // recents list on mount.
    workspaceGetRecents: vi.fn().mockResolvedValue([]),
    fsListDir: vi.fn(async (_workspaceId: string, path: string) => fakeFs.get(path) ?? []),
  };
});

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

function file(dir: string, name: string): DirEntry {
  return { name, path: `${dir}/${name}`, isDir: false, isSymlink: false };
}

function directory(dir: string, name: string): DirEntry {
  return { name, path: `${dir}/${name}`, isDir: true, isSymlink: false };
}

function fsChangedHandler(): (event: FsChangeEvent) => void {
  const handler = vi.mocked(onFsChanged).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error("expected onFsChanged to have been called by App.svelte's onMount");
  return handler;
}

function renderedPaths(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".row[data-path]")).map(
    (row) => row.dataset.path!,
  );
}

/** Settles the chain of awaited `fsListDir` calls a refresh starts. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  fileTree.set({ root: null });
  explorerVisible.set(true);
  terminalVisible.set(false);
  tabsState.set({ tabs: [], activeTabPath: null });
  focusedEditorPaneId.set(null);
  editorPaneTree.set(null);
  errorToast.set(null);
}

describe("App: an externally deleted file leaves the explorer (issue #470)", () => {
  beforeEach(() => {
    resetStores();
    fakeFs = new Map();
  });

  afterEach(() => {
    cleanup();
  });

  it("drops the row for a top-level file deleted outside the app", async () => {
    fakeFs.set(ROOT, [file(ROOT, "keep.md"), file(ROOT, "gone.md")]);
    workspace.set({ id: "local", root: ROOT });
    const { container } = render(App);
    await flush();

    expect(renderedPaths(container)).toContain(`${ROOT}/gone.md`);

    fakeFs.set(ROOT, [file(ROOT, "keep.md")]);
    fsChangedHandler()({ workspaceId: "local", path: `${ROOT}/gone.md`, kind: "remove" });
    await flush();

    expect(renderedPaths(container)).toContain(`${ROOT}/keep.md`);
    expect(renderedPaths(container)).not.toContain(`${ROOT}/gone.md`);
  });

  it("drops the row for a file deleted out of an expanded subdirectory", async () => {
    fakeFs.set(ROOT, [directory(ROOT, "src")]);
    fakeFs.set(`${ROOT}/src`, [file(`${ROOT}/src`, "a.ts"), file(`${ROOT}/src`, "b.ts")]);
    workspace.set({ id: "local", root: ROOT });
    const { container } = render(App);
    await flush();

    const srcRow = container.querySelector<HTMLElement>(`.row[data-path="${ROOT}/src"]`);
    if (!srcRow) throw new Error("no row for the src directory");
    srcRow.click();
    await flush();
    expect(renderedPaths(container)).toContain(`${ROOT}/src/b.ts`);

    fakeFs.set(`${ROOT}/src`, [file(`${ROOT}/src`, "a.ts")]);
    fsChangedHandler()({ workspaceId: "local", path: `${ROOT}/src/b.ts`, kind: "remove" });
    await flush();

    expect(renderedPaths(container)).toContain(`${ROOT}/src/a.ts`);
    expect(renderedPaths(container)).not.toContain(`${ROOT}/src/b.ts`);
  });

  // The two path spellings the backend genuinely produces for one workspace.
  // `fs_watch::reported_path` addresses every event against the raw root the
  // user picked (`RAW_ROOT`), which is also what `$workspace.root` and the
  // tree's root node hold; `fs_list_dir` builds its entries by joining onto a
  // `std::fs::canonicalize`d root (`REAL_ROOT`), so every child node below the
  // root is spelled the other way. macOS's `/tmp` -> `/private/tmp` is the
  // everyday case, and any project reached through a symlink behaves the same.
  it("drops the row inside an expanded subdirectory when the workspace root sits behind a symlinked ancestor", async () => {
    const RAW_ROOT = "/tmp/demo";
    const REAL_ROOT = "/private/tmp/demo";
    fakeFs.set(RAW_ROOT, [directory(REAL_ROOT, "src")]);
    fakeFs.set(`${REAL_ROOT}/src`, [
      file(`${REAL_ROOT}/src`, "a.ts"),
      file(`${REAL_ROOT}/src`, "b.ts"),
    ]);
    workspace.set({ id: "local", root: RAW_ROOT });
    const { container } = render(App);
    await flush();

    const srcRow = container.querySelector<HTMLElement>(`.row[data-path="${REAL_ROOT}/src"]`);
    if (!srcRow) throw new Error("no row for the src directory");
    srcRow.click();
    await flush();
    expect(renderedPaths(container)).toContain(`${REAL_ROOT}/src/b.ts`);

    fakeFs.set(`${REAL_ROOT}/src`, [file(`${REAL_ROOT}/src`, "a.ts")]);
    fsChangedHandler()({ workspaceId: "local", path: `${RAW_ROOT}/src/b.ts`, kind: "remove" });
    await flush();

    expect(renderedPaths(container)).toContain(`${REAL_ROOT}/src/a.ts`);
    expect(renderedPaths(container)).not.toContain(`${REAL_ROOT}/src/b.ts`);
  });

  // The production sequence: App mounts at the welcome screen with no root
  // and registers its `fs:changed` listener there, and the project is opened
  // afterwards. Every other case here sets the root before `render`, which
  // never exercises the listener closure reading a workspace that changed
  // after `onMount` ran.
  it("drops the row when the project was opened after the listener was registered", async () => {
    workspace.set({ id: "local", root: null });
    const { container } = render(App);
    await flush();

    fakeFs.set(ROOT, [file(ROOT, "keep.md"), file(ROOT, "gone.md")]);
    workspace.set({ id: "local", root: ROOT });
    await flush();
    expect(renderedPaths(container)).toContain(`${ROOT}/gone.md`);

    fakeFs.set(ROOT, [file(ROOT, "keep.md")]);
    fsChangedHandler()({ workspaceId: "local", path: `${ROOT}/gone.md`, kind: "remove" });
    await flush();

    expect(renderedPaths(container)).not.toContain(`${ROOT}/gone.md`);
  });

  // `fs_watch`'s own test helper documents that the debouncer can emit more
  // than one wire event per filesystem operation, and Tauri delivers a burst
  // back to back with no await between handler invocations. Every one of them
  // starts its own `loadChildren` against the same directory.
  it("drops the row when the delete arrives as a burst of events for the entry and its directory", async () => {
    fakeFs.set(ROOT, [directory(ROOT, "src")]);
    fakeFs.set(`${ROOT}/src`, [file(`${ROOT}/src`, "a.ts"), file(`${ROOT}/src`, "b.ts")]);
    workspace.set({ id: "local", root: ROOT });
    const { container } = render(App);
    await flush();

    const srcRow = container.querySelector<HTMLElement>(`.row[data-path="${ROOT}/src"]`);
    if (!srcRow) throw new Error("no row for the src directory");
    srcRow.click();
    await flush();
    expect(renderedPaths(container)).toContain(`${ROOT}/src/b.ts`);

    fakeFs.set(`${ROOT}/src`, [file(`${ROOT}/src`, "a.ts")]);
    const handler = fsChangedHandler();
    handler({ workspaceId: "local", path: `${ROOT}/src/b.ts`, kind: "remove" });
    handler({ workspaceId: "local", path: `${ROOT}/src`, kind: "modify" });
    handler({ workspaceId: "local", path: `${ROOT}/src/b.ts`, kind: "remove" });
    await flush();

    expect(renderedPaths(container)).not.toContain(`${ROOT}/src/b.ts`);
  });

  // A rejected relist leaves the explorer showing rows for files that are no
  // longer on disk — the same symptom as a missing event, reached from the
  // other direction. It used to be a bare `void`, so the rejection went
  // unhandled and nothing anywhere said the tree had gone stale.
  it("surfaces a failed relist instead of leaving the tree silently stale", async () => {
    fakeFs.set(ROOT, [file(ROOT, "keep.md"), file(ROOT, "gone.md")]);
    workspace.set({ id: "local", root: ROOT });
    render(App);
    await flush();

    vi.mocked(commands.fsListDir).mockRejectedValueOnce({
      code: "IO_ERROR",
      message: "permission denied",
    });
    fsChangedHandler()({ workspaceId: "local", path: `${ROOT}/gone.md`, kind: "remove" });
    await flush();

    expect(get(errorToast)).toBe("Couldn't refresh the file explorer: permission denied");
  });

  it("drops the row when the watcher reports the containing directory instead of the entry", async () => {
    fakeFs.set(ROOT, [file(ROOT, "keep.md"), file(ROOT, "gone.md")]);
    workspace.set({ id: "local", root: ROOT });
    const { container } = render(App);
    await flush();

    fakeFs.set(ROOT, [file(ROOT, "keep.md")]);
    fsChangedHandler()({ workspaceId: "local", path: ROOT, kind: "modify" });
    await flush();

    expect(renderedPaths(container)).not.toContain(`${ROOT}/gone.md`);
  });
});
