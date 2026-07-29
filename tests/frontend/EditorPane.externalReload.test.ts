import { describe, it, expect, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import { undo, undoDepth } from "@codemirror/commands";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, reconcileExternalChange, type Tab } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId } from "../../src/lib/stores/editorPanes";
import * as commands from "../../src/lib/ipc/commands";

// Regression coverage for issue #278: the reconciliation effect's own
// programmatic doc replacement (below) used to re-enter `updateListener` and
// call `markDirty`, poisoning the tab's dirty flag so every external change
// *after the first* wrongly took the dirty/conflict branch. These tests
// drive a real mounted `EditorView` — the layer the bug actually lives in —
// rather than just `tabs.ts`'s store, which already passed before the fix.
vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return { ...actual, fsReadFile: vi.fn(), fsWriteFile: vi.fn() };
});

const PATH = "/reload.md";
const PANE_ID = "pane-1";
const V1 = "v1\n";

function seedTab(overrides: Partial<Tab> = {}): void {
  const tab: Tab = {
    path: PATH,
    mode: "markdown",
    savedDoc: V1,
    isDirty: false,
    hasExternalConflict: false,
    isExternal: false,
    isDeleted: false,
    viewMode: "source",
    ...overrides,
  };
  tabsState.set({ tabs: [tab], activeTabPath: PATH });
  focusedEditorPaneId.set(PANE_ID);
}

function findView(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("expected an EditorView to be mounted");
  return view;
}

function currentTab(): Tab {
  const tab = get(tabsState).tabs.find((t) => t.path === PATH);
  if (!tab) throw new Error("expected the tab to still exist");
  return tab;
}

describe("EditorPane: external reload no longer poisons the dirty flag (issue #278)", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    focusedEditorPaneId.set(null);
    vi.restoreAllMocks();
  });

  it("keeps auto-reloading silently across repeated external changes instead of prompting after the first", async () => {
    seedTab();
    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_ID });
    await tick();

    vi.mocked(commands.fsReadFile).mockResolvedValueOnce("v2\n");
    await reconcileExternalChange(PATH);
    await tick();
    await tick();

    // The bug: this used to be `true` even though the user never typed —
    // the reload's own dispatch re-entered `updateListener` and re-marked
    // the tab dirty.
    expect(currentTab().isDirty).toBe(false);

    vi.mocked(commands.fsReadFile).mockResolvedValueOnce("v3\n");
    await reconcileExternalChange(PATH);
    await tick();
    await tick();

    // With the flag poisoned, this second change used to wrongly take the
    // dirty branch and raise the conflict banner instead of reloading again.
    expect(currentTab().hasExternalConflict).toBe(false);
    expect(currentTab().savedDoc).toBe("v3\n");
    expect(findView(container).state.doc.toString()).toBe("v3\n");
  });

  it("still marks dirty and preserves the buffer on a real keystroke, even with an external change pending (standing safety guard, not itself coverage of this bug)", async () => {
    seedTab();
    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_ID });
    await tick();

    const view = findView(container);
    view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: "edited" } });
    await tick();
    expect(currentTab().isDirty).toBe(true);
    const typedDoc = view.state.doc.toString();

    vi.mocked(commands.fsReadFile).mockResolvedValueOnce("disk changed\n");
    await reconcileExternalChange(PATH);
    await tick();
    await tick();

    expect(currentTab().hasExternalConflict).toBe(true);
    expect(currentTab().isDirty).toBe(true);
    expect(view.state.doc.toString()).toBe(typedDoc);
  });

  it("applies the same fix in markdown rendered view mode", async () => {
    seedTab({ viewMode: "rendered" });
    render(EditorPane, { filePath: PATH, paneId: PANE_ID });
    await tick();

    vi.mocked(commands.fsReadFile).mockResolvedValueOnce("v2\n");
    await reconcileExternalChange(PATH);
    await tick();
    await tick();

    expect(currentTab().isDirty).toBe(false);

    vi.mocked(commands.fsReadFile).mockResolvedValueOnce("v3\n");
    await reconcileExternalChange(PATH);
    await tick();
    await tick();

    expect(currentTab().hasExternalConflict).toBe(false);
    expect(currentTab().savedDoc).toBe("v3\n");
  });

  it("does not let undo resurrect the pre-reload content right after an auto-reload", async () => {
    seedTab();
    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_ID });
    await tick();
    const view = findView(container);

    vi.mocked(commands.fsReadFile).mockResolvedValueOnce("v2\n");
    await reconcileExternalChange(PATH);
    await tick();
    await tick();

    expect(view.state.doc.toString()).toBe("v2\n");
    expect(undoDepth(view.state)).toBe(0);

    const didUndo = undo(view);

    expect(didUndo).toBe(false);
    expect(view.state.doc.toString()).toBe("v2\n");
  });
});
