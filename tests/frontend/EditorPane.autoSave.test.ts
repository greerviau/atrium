import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, requestSave, type Tab } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import type { EditorPaneNode } from "../../src/lib/editor/editorPaneTree";
import { autoSaveEnabled } from "../../src/lib/stores/autoSave";
import { errorToast } from "../../src/lib/stores/errorToast";
import * as commands from "../../src/lib/ipc/commands";

// Regression coverage for the review finding (MF5) that a first pass at
// these assertions could pass without auto-save being implemented at all:
// `isSaveOwner` is `$derived($editorPaneTree !== null && ...)`, and
// `editorPaneTree` defaults to `null` — a test that never seeds it gets
// `isSaveOwner === false` unconditionally, making a negative assertion ("no
// write occurs") pass vacuously. Every case below seeds `editorPaneTree`
// explicitly, following `EditorPane.saveOwnership.test.ts`'s own setup, and
// every negative assertion is paired with a positive one under otherwise
// identical conditions so the negative is only meaningful because the
// positive fires.
vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return { ...actual, fsWriteFile: vi.fn().mockResolvedValue(undefined), fsReadFile: vi.fn() };
});

const PATH = "/shared.ts";
const PANE_A = "pane-a";
const PANE_B = "pane-b";
const AUTO_SAVE_DELAY_MS = 1000;

function seedTab(overrides: Partial<Tab> = {}): Tab {
  const tab: Tab = {
    path: PATH, workspaceId: "local",
    mode: "code",
    savedDoc: "original\n",
    isDirty: false,
    hasExternalConflict: false,
    isExternal: false,
    isDeleted: false,
    ...overrides,
  };
  tabsState.set({ tabs: [tab], activeTabPath: PATH });
  return tab;
}

function singlePaneShowingPath(): EditorPaneNode {
  return { type: "leaf", id: PANE_A, tabs: [PATH], activeTabPath: PATH };
}

function twoPaneSplitShowingPath(): EditorPaneNode {
  return {
    type: "split",
    id: "split-a-b",
    direction: "row",
    children: [
      { type: "leaf", id: PANE_A, tabs: [PATH], activeTabPath: PATH },
      { type: "leaf", id: PANE_B, tabs: [PATH], activeTabPath: PATH },
    ],
    sizes: [0.5, 0.5],
  };
}

function findView(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("expected an EditorView to be mounted");
  return view;
}

// The shared stimulus used across every case below: a real, non-sync doc
// change dispatched on the mounted pane's own view, the same technique
// `EditorPane.externalReload.test.ts` uses to drive the actual
// `updateListener` path rather than mutating `tabsState` directly.
function typeInto(view: EditorView): void {
  view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: "x" } });
}

describe("EditorPane: auto save", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    autoSaveEnabled.set(false);
    errorToast.set(null);
  });

  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    focusedEditorPaneId.set(null);
    editorPaneTree.set(null);
    autoSaveEnabled.set(false);
    errorToast.set(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes to disk exactly once after the debounce delay when enabled and this pane is the save owner", async () => {
    seedTab();
    editorPaneTree.set(singlePaneShowingPath());
    focusedEditorPaneId.set(PANE_A);
    autoSaveEnabled.set(true);

    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const fsWriteFile = vi.mocked(commands.fsWriteFile);
    fsWriteFile.mockClear();

    typeInto(findView(container));
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);

    expect(fsWriteFile).toHaveBeenCalledTimes(1);
  });

  it("never writes to disk when disabled, under the otherwise-identical conditions that fire above", async () => {
    seedTab();
    editorPaneTree.set(singlePaneShowingPath());
    focusedEditorPaneId.set(PANE_A);
    autoSaveEnabled.set(false);

    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const fsWriteFile = vi.mocked(commands.fsWriteFile);
    fsWriteFile.mockClear();

    typeInto(findView(container));
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);

    expect(fsWriteFile).toHaveBeenCalledTimes(0);
  });

  it("writes exactly once, from the save owner's own buffer, for a path open in two split panes", async () => {
    seedTab();
    editorPaneTree.set(twoPaneSplitShowingPath());
    focusedEditorPaneId.set(PANE_A);
    autoSaveEnabled.set(true);

    const { container: containerA } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    render(EditorPane, { filePath: PATH, paneId: PANE_B });
    const fsWriteFile = vi.mocked(commands.fsWriteFile);
    fsWriteFile.mockClear();

    typeInto(findView(containerA));
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);

    expect(fsWriteFile).toHaveBeenCalledTimes(1);
  });

  // MF2 regression: auto-save must not overwrite a real external change
  // while the conflict banner is showing — the fire-time gate checks live
  // state, not a snapshot taken when the timer was armed.
  it("does not write to disk while hasExternalConflict is set (MF2)", async () => {
    seedTab({ isDirty: true, hasExternalConflict: true });
    editorPaneTree.set(singlePaneShowingPath());
    focusedEditorPaneId.set(PANE_A);
    autoSaveEnabled.set(true);

    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const fsWriteFile = vi.mocked(commands.fsWriteFile);
    fsWriteFile.mockClear();

    typeInto(findView(container));
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);

    expect(fsWriteFile).toHaveBeenCalledTimes(0);
  });

  // Deleted-file guard (MF3): a tab flagged isDeleted must never be
  // resurrected by a background timer.
  it("does not write to disk while isDeleted is set", async () => {
    seedTab({ isDirty: true, isDeleted: true });
    editorPaneTree.set(singlePaneShowingPath());
    focusedEditorPaneId.set(PANE_A);
    autoSaveEnabled.set(true);

    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const fsWriteFile = vi.mocked(commands.fsWriteFile);
    fsWriteFile.mockClear();

    typeInto(findView(container));
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);

    expect(fsWriteFile).toHaveBeenCalledTimes(0);
  });

  // Failure policy (MF3): no re-arm and no duplicate toast after a failed
  // auto-save, until an explicit save for the same path succeeds.
  it("blocks further attempts and toasts exactly once after a failure, re-arming only once an explicit save succeeds", async () => {
    seedTab();
    editorPaneTree.set(singlePaneShowingPath());
    focusedEditorPaneId.set(PANE_A);
    autoSaveEnabled.set(true);

    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const fsWriteFile = vi.mocked(commands.fsWriteFile);
    fsWriteFile.mockClear();
    fsWriteFile.mockRejectedValueOnce(new Error("disk full"));

    const view = findView(container);
    typeInto(view);
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);

    expect(fsWriteFile).toHaveBeenCalledTimes(1);
    expect(get(errorToast)).toContain("Auto-save paused for shared.ts");
    errorToast.set(null);

    // A second doc change re-arms the timer, but the block from the prior
    // failure must suppress the attempt entirely — no second write, no
    // second toast.
    typeInto(view);
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);

    expect(fsWriteFile).toHaveBeenCalledTimes(1);
    expect(get(errorToast)).toBeNull();

    // An explicit save (the shared save-request effect every save funnels
    // through) succeeds and clears the block.
    await requestSave(PATH);

    expect(fsWriteFile).toHaveBeenCalledTimes(2);

    // Auto-save can fire again after the explicit save cleared the block.
    typeInto(view);
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);

    expect(fsWriteFile).toHaveBeenCalledTimes(3);
  });

  // Regression: saveTab used to flip the tab to clean based solely on what
  // was written at the moment the save started, with no way to notice the
  // live buffer moving on during fsWriteFile's own round trip. The clean-tab
  // external-change reconciliation effect (EditorPane.svelte, guarded on
  // !isDirty) would then silently replace the buffer with the now-stale
  // savedDoc, erasing whatever was typed during the write — not undoable,
  // since that replacement never enters undo history. Auto-save is what
  // turns this from "needs a keystroke landing inside a Cmd+S round trip"
  // into "fires by itself on a timer, unattended."
  it("does not erase a keystroke typed while auto-save's own write is still in flight", async () => {
    seedTab();
    editorPaneTree.set(singlePaneShowingPath());
    focusedEditorPaneId.set(PANE_A);
    autoSaveEnabled.set(true);

    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const view = findView(container);

    let resolveWrite!: () => void;
    vi.mocked(commands.fsWriteFile).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    typeInto(view);
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    // The write is now issued and in flight, blocked on our deferred promise.

    // A further keystroke lands while the write is still pending.
    typeInto(view);
    const docWhileWritePending = view.state.doc.toString();

    resolveWrite();
    await tick();
    await tick();
    await tick();

    expect(view.state.doc.toString()).toBe(docWhileWritePending);
    const tab = get(tabsState).tabs.find((t) => t.path === PATH);
    expect(tab?.isDirty).toBe(true);
  });
});
