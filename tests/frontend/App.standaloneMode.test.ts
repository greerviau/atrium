import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { render, cleanup, screen } from "@testing-library/svelte";
import App from "../../src/App.svelte";
import { workspace, openWorkspacePath } from "../../src/lib/stores/workspace";
import { terminalVisible } from "../../src/lib/stores/layout";
import { tabsState, openFile, markDirty } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import { closePrompt } from "../../src/lib/stores/closePrompt";
import { loadEditorSession } from "../../src/lib/stores/editorSession";
import { listLeaves, type EditorPaneNode } from "../../src/lib/editor/editorPaneTree";
import { localWorkspaceId, standaloneWorkspaceId } from "../../src/lib/ipc/commands";
import { onCloseRequested } from "../../src/lib/ipc/events";
import * as commands from "../../src/lib/ipc/commands";

// Standalone mode (issue #325): a file opened with no project workspace
// open lives in its own root-less workspace, never torn down by a project
// switch. These tests exercise the merge (§5 of the plan) against the real
// App.svelte wiring — only FileTree and TerminalPane are stubbed, matching
// App.workspaceSwitch.test.ts's and App.editorSessionRestore.test.ts's own
// scaffolding, since EditorPane (real CodeMirror) needs to actually mount
// for the DOM-identity assertion below.
vi.mock("../../src/lib/explorer/FileTree.svelte", async () => {
  const mod = await import("./FileTreeStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/terminal/TerminalPane.svelte", async () => {
  const mod = await import("./TerminalPaneStub.svelte");
  return { default: mod.default };
});

vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return {
    ...actual,
    workspaceTakePendingOpen: vi.fn().mockResolvedValue([]),
    appConfirmClose: vi.fn().mockResolvedValue(undefined),
    fsReadFile: vi.fn().mockResolvedValue("content\n"),
    fsWriteFile: vi.fn().mockResolvedValue(undefined),
    fsGrantExternalFile: vi.fn().mockResolvedValue(undefined),
    fsExternalPathsAreDirs: vi.fn().mockResolvedValue([false]),
    workspaceSetRoot: vi.fn().mockResolvedValue(undefined),
    workspaceGetRecents: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../src/lib/ipc/events", () => ({
  onFsChanged: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  onDockOpenPath: vi.fn().mockResolvedValue(() => {}),
  onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
}));

const PROJECT_A = "/projects/a";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function resetStores(): void {
  localStorage.clear();
  workspace.set({ id: "local", root: null });
  terminalVisible.set(false);
  tabsState.set({ tabs: [], activeTabPath: null });
  focusedEditorPaneId.set(null);
  editorPaneTree.set(null);
  closePrompt.set(null);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("App standalone mode (issue #325)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.workspaceSetRoot).mockResolvedValue(undefined);
    vi.mocked(commands.workspaceGetRecents).mockResolvedValue([]);
    vi.mocked(commands.fsReadFile).mockResolvedValue("content\n");
    vi.mocked(commands.fsWriteFile).mockResolvedValue(undefined);
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  // Test 3 — a live edit made to a standalone tab while a restore is still
  // in flight is not reverted once the merge applies, and the re-homed
  // tab's own pane is not pruned out of the tree by the ordering bug this
  // plan's own merge code exists to avoid (computing the surviving-path set
  // from POST-update state would exclude a just-re-homed path and collapse
  // its leaf out of `editorPaneTree`).
  it("a standalone edit made during an in-flight restore survives the merge, pane included", async () => {
    const sharedPath = PROJECT_A + "/shared.ts";
    const otherPath = PROJECT_A + "/other.ts";
    localStorage.setItem(
      "atrium.editorSession." + PROJECT_A,
      JSON.stringify({
        paneTree: { type: "leaf", id: "LA", tabs: [otherPath], activeTabPath: otherPath },
        focusedPaneId: "LA",
      }),
    );

    const gatedOther = deferred<string>();
    vi.mocked(commands.fsReadFile).mockImplementation((_ws: string, path: string) => {
      if (path === otherPath) return gatedOther.promise;
      return Promise.resolve("content\n");
    });

    render(App);
    await flush();

    await openFile(sharedPath, undefined, standaloneWorkspaceId());
    await flush();
    expect(get(tabsState).tabs).toHaveLength(1);
    expect(get(tabsState).tabs[0].workspaceId).toBe(standaloneWorkspaceId());

    // Start the switch: the restore's sole fsReadFile call is gated, so
    // nothing has been merged yet.
    void openWorkspacePath(PROJECT_A);
    await flush();
    expect(get(workspace).root).toBe(PROJECT_A);
    expect(get(tabsState).tabs.map((t) => t.path)).toEqual([sharedPath]);

    // A live edit lands while the restore is still awaiting its gated read.
    tabsState.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.path === sharedPath ? { ...t, savedDoc: "live-edited", isDirty: true } : t)),
    }));

    gatedOther.resolve("content from disk\n");
    await flush();
    await flush();

    const merged = get(tabsState).tabs;
    const sharedTab = merged.find((t) => t.path === sharedPath);
    expect(sharedTab).toMatchObject({ workspaceId: localWorkspaceId(), isDirty: true, savedDoc: "live-edited" });
    expect(merged.find((t) => t.path === otherPath)).toMatchObject({ workspaceId: localWorkspaceId() });

    // Neither tab's own pane was pruned out of the tree by the merge.
    const tree = get(editorPaneTree);
    expect(tree).not.toBeNull();
    const openPathsInTree = listLeaves(tree as EditorPaneNode).flatMap((l) => l.tabs);
    expect(openPathsInTree).toContain(sharedPath);
    expect(openPathsInTree).toContain(otherPath);
  });

  // Test 4 — a standalone path also present in the restored project's
  // session dedupes to exactly one Tab, and the dirty live one wins over
  // whatever the restore freshly re-read off disk.
  it("dedupes a standalone path also present in the restored session, keeping the dirty live tab", async () => {
    const sharedPath = PROJECT_A + "/shared.ts";
    localStorage.setItem(
      "atrium.editorSession." + PROJECT_A,
      JSON.stringify({
        paneTree: { type: "leaf", id: "LA", tabs: [sharedPath], activeTabPath: sharedPath },
        focusedPaneId: "LA",
      }),
    );
    vi.mocked(commands.fsReadFile).mockResolvedValue("fresh disk content\n");

    render(App);
    await flush();

    await openFile(sharedPath, undefined, standaloneWorkspaceId());
    await flush();
    tabsState.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.path === sharedPath ? { ...t, savedDoc: "live-edited", isDirty: true } : t)),
    }));

    await openWorkspacePath(PROJECT_A);
    await flush();
    await flush();

    const matching = get(tabsState).tabs.filter((t) => t.path === sharedPath);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      workspaceId: localWorkspaceId(),
      isDirty: true,
      savedDoc: "live-edited",
      isExternal: false,
    });
  });

  // Test 5 — merging into a restored row split produces one flat row, in
  // both directions (localTree already a row split, and standalone already
  // a row split), never a nested split-of-splits.
  it("merges two already-row-split trees into one flat row, not a nested split", async () => {
    const standalonePathA = "/tmp/s-a.ts";
    const standalonePathB = "/tmp/s-b.ts";
    const localPathA = PROJECT_A + "/a.ts";
    const localPathB = PROJECT_A + "/b.ts";

    localStorage.setItem(
      "atrium.editorSession." + PROJECT_A,
      JSON.stringify({
        paneTree: {
          type: "split",
          id: "local-row",
          direction: "row",
          children: [
            { type: "leaf", id: "LA1", tabs: [localPathA], activeTabPath: localPathA },
            { type: "leaf", id: "LA2", tabs: [localPathB], activeTabPath: localPathB },
          ],
          sizes: [0.5, 0.5],
        },
        focusedPaneId: "LA1",
      }),
    );

    render(App);
    await flush();

    tabsState.set({
      tabs: [
        { path: standalonePathA, workspaceId: standaloneWorkspaceId(), mode: "code", savedDoc: "", isDirty: false, hasExternalConflict: false, isExternal: true, isDeleted: false },
        { path: standalonePathB, workspaceId: standaloneWorkspaceId(), mode: "code", savedDoc: "", isDirty: false, hasExternalConflict: false, isExternal: true, isDeleted: false },
      ],
      activeTabPath: standalonePathA,
    });
    editorPaneTree.set({
      type: "split",
      id: "standalone-row",
      direction: "row",
      children: [
        { type: "leaf", id: "SL1", tabs: [standalonePathA], activeTabPath: standalonePathA },
        { type: "leaf", id: "SL2", tabs: [standalonePathB], activeTabPath: standalonePathB },
      ],
      sizes: [0.5, 0.5],
    });
    focusedEditorPaneId.set("SL1");
    await flush();

    await openWorkspacePath(PROJECT_A);
    await flush();
    await flush();

    const tree = get(editorPaneTree);
    expect(tree).not.toBeNull();
    expect(tree?.type).toBe("split");
    if (tree?.type !== "split") throw new Error("expected a split");
    expect(tree.direction).toBe("row");
    // Flat: four leaves directly under one split, none of them themselves a
    // split — a nested merge would instead produce two children that are
    // each splits.
    expect(tree.children).toHaveLength(4);
    expect(tree.children.every((c) => c.type === "leaf")).toBe(true);
    const allPaths = listLeaves(tree).flatMap((l) => l.tabs);
    expect(new Set(allPaths)).toEqual(new Set([localPathA, localPathB, standalonePathA, standalonePathB]));
  });

  // Test 5, the other direction — localTree a single (non-split) leaf,
  // standalone already a row split. Reachable by the ordinary gesture of
  // splitting the standalone pane left/right before ever opening a project.
  // A merge that only checked `localIsRow` (missing the `standaloneIsRow`
  // branch) would fall through to the always-nest default here, producing a
  // 2-child split whose second child is itself a 2-child row split — this
  // asserts the flat 3-leaf result instead.
  it("merges a single local leaf into an already-row-split standalone tree, flat, not nested", async () => {
    const standalonePathA = "/tmp/s-a.ts";
    const standalonePathB = "/tmp/s-b.ts";
    const localPathA = PROJECT_A + "/a.ts";

    localStorage.setItem(
      "atrium.editorSession." + PROJECT_A,
      JSON.stringify({
        paneTree: { type: "leaf", id: "LA", tabs: [localPathA], activeTabPath: localPathA },
        focusedPaneId: "LA",
      }),
    );

    render(App);
    await flush();

    tabsState.set({
      tabs: [
        { path: standalonePathA, workspaceId: standaloneWorkspaceId(), mode: "code", savedDoc: "", isDirty: false, hasExternalConflict: false, isExternal: true, isDeleted: false },
        { path: standalonePathB, workspaceId: standaloneWorkspaceId(), mode: "code", savedDoc: "", isDirty: false, hasExternalConflict: false, isExternal: true, isDeleted: false },
      ],
      activeTabPath: standalonePathA,
    });
    editorPaneTree.set({
      type: "split",
      id: "standalone-row",
      direction: "row",
      children: [
        { type: "leaf", id: "SL1", tabs: [standalonePathA], activeTabPath: standalonePathA },
        { type: "leaf", id: "SL2", tabs: [standalonePathB], activeTabPath: standalonePathB },
      ],
      sizes: [0.5, 0.5],
    });
    focusedEditorPaneId.set("SL1");
    await flush();

    await openWorkspacePath(PROJECT_A);
    await flush();
    await flush();

    const tree = get(editorPaneTree);
    expect(tree).not.toBeNull();
    expect(tree?.type).toBe("split");
    if (tree?.type !== "split") throw new Error("expected a split");
    expect(tree.direction).toBe("row");
    // Flat: three leaves directly under one split, none of them themselves a
    // split — the missing-branch bug instead nests the standalone row two
    // levels deep as the second child of a 2-child outer split.
    expect(tree.children).toHaveLength(3);
    expect(tree.children.every((c) => c.type === "leaf")).toBe(true);
    const allPaths = listLeaves(tree).flatMap((l) => l.tabs);
    expect(new Set(allPaths)).toEqual(new Set([localPathA, standalonePathA, standalonePathB]));
  });

  // Test 6 — the project's persisted session never contains an out-of-root
  // (standalone) path after a merge, including on the project's first-ever
  // open (no persisted session at all, `restored === null`).
  it("never persists a standalone path into the project's own session, even on first-ever open", async () => {
    const standalonePath = "/tmp/note.txt";
    render(App);
    await flush();

    await openFile(standalonePath, undefined, standaloneWorkspaceId());
    await flush();

    await openWorkspacePath(PROJECT_A);
    await flush();
    await flush();

    // Flush the ~400ms debounce before asserting — an unflushed assertion
    // would pass trivially regardless of whether the filter works.
    await new Promise((resolve) => setTimeout(resolve, 450));

    const persisted = loadEditorSession(PROJECT_A);
    if (persisted?.paneTree) {
      const persistedPaths = listLeaves(persisted.paneTree).flatMap((l) => l.tabs);
      expect(persistedPaths).not.toContain(standalonePath);
    } else {
      expect(persisted?.paneTree ?? null).toBeNull();
    }
  });

  // Test 7 — quitting with a dirty standalone tab and no project open
  // actually renders the unsaved-changes dialog. Regression coverage for
  // the dialog having previously sat inside the root-gated template branch,
  // where `onCloseRequested` would set the prompt and nothing would render
  // it — silently preventing the window from closing.
  it("renders the unsaved-changes dialog when quitting with a dirty standalone tab and no project open", async () => {
    const standalonePath = "/tmp/dirty-note.txt";
    render(App);
    await flush();

    await openFile(standalonePath, undefined, standaloneWorkspaceId());
    await flush();
    markDirty(standalonePath);

    const handler = vi.mocked(onCloseRequested).mock.calls.at(-1)?.[0];
    if (!handler) throw new Error("expected onCloseRequested to have been registered by App.svelte's onMount");
    handler();
    await flush();

    expect(get(closePrompt)).toEqual({ kind: "window", paths: [standalonePath] });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
  });

  // Test 8 — a surviving standalone leaf's live EditorView is never
  // remounted across a merge: its DOM node identity is unchanged, not just
  // its content.
  it("never remounts a surviving standalone leaf's EditorView across a merge", async () => {
    const standalonePath = "/tmp/survives.ts";
    const localPath = PROJECT_A + "/a.ts";
    localStorage.setItem(
      "atrium.editorSession." + PROJECT_A,
      JSON.stringify({
        paneTree: { type: "leaf", id: "LA", tabs: [localPath], activeTabPath: localPath },
        focusedPaneId: "LA",
      }),
    );

    const { container } = render(App);
    await flush();

    await openFile(standalonePath, undefined, standaloneWorkspaceId());
    await flush();

    const leafId = get(editorPaneTree)?.id;
    if (!leafId) throw new Error("expected a single-leaf editorPaneTree after opening the standalone tab");
    const before = container.querySelector(`[data-pane-id="${leafId}"] .cm-content`);
    expect(before).not.toBeNull();

    await openWorkspacePath(PROJECT_A);
    await flush();
    await flush();

    // The standalone leaf is still present in the (now merged) tree, under
    // the same id.
    const tree = get(editorPaneTree) as EditorPaneNode;
    expect(listLeaves(tree).some((l) => l.id === leafId)).toBe(true);

    const after = container.querySelector(`[data-pane-id="${leafId}"] .cm-content`);
    expect(after).not.toBeNull();
    expect(after).toBe(before);
  });
});
