import { describe, it, expect, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { get } from "svelte/store";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { editorPaneTree, focusedEditorPaneId } from "../../src/lib/stores/editorPanes";
import { errorToast } from "../../src/lib/stores/errorToast";
import * as commands from "../../src/lib/ipc/commands";

// Regresses issue #250: the in-editor Cmd+S keymap used to call the local
// `save()` unconditionally and swallow a failure outright. It now routes
// through `requestSaveReportingErrors`, the same reconciliation path (and
// error surfacing) the menu-bar Save and the context menu's Save item use.
vi.mock("../../src/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/ipc/commands")>();
  return { ...actual, fsWriteFile: vi.fn().mockResolvedValue(undefined) };
});

const PATH = "/main.ts";
const PANE_ID = "pane-1";

function seedTab(): Tab {
  const tab: Tab = {
    path: PATH, workspaceId: "local",
    mode: "code",
    savedDoc: "const x = 1;\n",
    isDirty: false,
    hasExternalConflict: false,
    isExternal: false,
    isDeleted: false,
  };
  tabsState.set({ tabs: [tab], activeTabPath: PATH });
  return tab;
}

function fireModS(view: EditorView): void {
  // jsdom reports no mac-like `navigator.platform`, so CodeMirror's "Mod"
  // resolves to Ctrl in this test environment rather than Meta — see
  // `@codemirror/view`'s `currentPlatform`/`normalizeKeyName`.
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

describe("EditorPane: Cmd+S keymap (issue #250)", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    editorPaneTree.set(null);
    focusedEditorPaneId.set(null);
    errorToast.set(null);
    vi.mocked(commands.fsWriteFile).mockClear();
  });

  it("saves the owning pane's buffer on Mod-s", async () => {
    seedTab();
    editorPaneTree.set({ type: "leaf", id: PANE_ID, tabs: [PATH], activeTabPath: PATH });
    focusedEditorPaneId.set(PANE_ID);
    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_ID });
    await tick();

    const dom = container.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(dom);
    if (!view) throw new Error("expected an EditorView to be mounted");

    fireModS(view);

    await vi.waitFor(() => {
      expect(commands.fsWriteFile).toHaveBeenCalledWith("local", PATH, "const x = 1;\n");
    });
  });

  it("shows an error toast naming the file when the save rejects, instead of swallowing it", async () => {
    seedTab();
    editorPaneTree.set({ type: "leaf", id: PANE_ID, tabs: [PATH], activeTabPath: PATH });
    focusedEditorPaneId.set(PANE_ID);
    vi.mocked(commands.fsWriteFile).mockRejectedValueOnce(new Error("permission denied"));
    const { container } = render(EditorPane, { filePath: PATH, paneId: PANE_ID });
    await tick();

    const dom = container.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(dom);
    if (!view) throw new Error("expected an EditorView to be mounted");

    fireModS(view);

    await vi.waitFor(() => {
      expect(get(errorToast)).toContain("main.ts");
    });
    expect(get(errorToast)).toContain("permission denied");
  });
});
