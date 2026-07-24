import { describe, it, expect, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId, editorPaneTree } from "../../src/lib/stores/editorPanes";
import type { EditorPaneNode } from "../../src/lib/editor/editorPaneTree";

const PATH = "/shared.ts";
const PANE_A = "pane-a";
const PANE_B = "pane-b";
const PANE_C = "pane-c";

function seedTab(savedDoc = "original\n"): void {
  const tab: Tab = { path: PATH, mode: "code", savedDoc, isDirty: false, hasExternalConflict: false };
  tabsState.set({ tabs: [tab], activeTabPath: PATH });
}

function twoPaneSplit(): EditorPaneNode {
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

describe("editorViewRegistry: content sync between split panes showing the same path", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    focusedEditorPaneId.set(null);
    editorPaneTree.set(null);
    vi.restoreAllMocks();
  });

  it("typing in pane A is reflected in pane B", async () => {
    seedTab();
    editorPaneTree.set(twoPaneSplit());
    focusedEditorPaneId.set(PANE_A);

    const { container: containerA } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const { container: containerB } = render(EditorPane, { filePath: PATH, paneId: PANE_B });
    await tick();

    const viewA = findView(containerA);
    const viewB = findView(containerB);

    viewA.dispatch({ changes: { from: 0, to: 0, insert: "hello " } });

    expect(viewB.state.doc.toString()).toBe("hello original\n");
  });

  it("typing in pane B is reflected in pane A (both directions)", async () => {
    seedTab();
    editorPaneTree.set(twoPaneSplit());
    focusedEditorPaneId.set(PANE_A);

    const { container: containerA } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const { container: containerB } = render(EditorPane, { filePath: PATH, paneId: PANE_B });
    await tick();

    const viewA = findView(containerA);
    const viewB = findView(containerB);

    viewB.dispatch({ changes: { from: viewB.state.doc.length, to: viewB.state.doc.length, insert: "!" } });

    expect(viewA.state.doc.toString()).toBe("original\n!");
  });

  it("a change in one pane does not move the other pane's own selection", async () => {
    seedTab();
    editorPaneTree.set(twoPaneSplit());
    focusedEditorPaneId.set(PANE_A);

    const { container: containerA } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const { container: containerB } = render(EditorPane, { filePath: PATH, paneId: PANE_B });
    await tick();

    const viewA = findView(containerA);
    const viewB = findView(containerB);

    // Put B's cursor on "original" (offset 3), then insert text in A well
    // after B's cursor position — B's own selection should be left alone.
    viewB.dispatch({ selection: { anchor: 3 } });
    viewA.dispatch({ changes: { from: viewA.state.doc.length, to: viewA.state.doc.length, insert: "x" } });

    expect(viewB.state.selection.main.head).toBe(3);
  });

  it("interleaved edits in both panes converge to the same final content", async () => {
    seedTab("");
    editorPaneTree.set(twoPaneSplit());
    focusedEditorPaneId.set(PANE_A);

    const { container: containerA } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const { container: containerB } = render(EditorPane, { filePath: PATH, paneId: PANE_B });
    await tick();

    const viewA = findView(containerA);
    const viewB = findView(containerB);

    viewA.dispatch({ changes: { from: 0, to: 0, insert: "a" } });
    viewB.dispatch({ changes: { from: viewB.state.doc.length, to: viewB.state.doc.length, insert: "b" } });
    viewA.dispatch({ changes: { from: viewA.state.doc.length, to: viewA.state.doc.length, insert: "c" } });

    expect(viewA.state.doc.toString()).toBe("abc");
    expect(viewB.state.doc.toString()).toBe("abc");
  });

  it("destroying one pane's view leaves the other working, with no dangling registry reference", async () => {
    seedTab("");
    editorPaneTree.set(twoPaneSplit());
    focusedEditorPaneId.set(PANE_A);

    const { container: containerA, unmount: unmountA } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const { container: containerB } = render(EditorPane, { filePath: PATH, paneId: PANE_B });
    await tick();

    const viewB = findView(containerB);

    unmountA();
    await tick();

    // No dispatch-to-destroyed-view error on a subsequent edit in the survivor.
    expect(() => {
      viewB.dispatch({ changes: { from: 0, to: 0, insert: "still alive" } });
    }).not.toThrow();
    expect(viewB.state.doc.toString()).toBe("still alive");
  });

  it("a third view of the same path stays in sync alongside the other two", async () => {
    seedTab("");
    const threePaneSplit: EditorPaneNode = {
      type: "split",
      id: "split-a-b-c",
      direction: "row",
      children: [
        { type: "leaf", id: PANE_A, tabs: [PATH], activeTabPath: PATH },
        { type: "leaf", id: PANE_B, tabs: [PATH], activeTabPath: PATH },
        { type: "leaf", id: PANE_C, tabs: [PATH], activeTabPath: PATH },
      ],
      sizes: [0.34, 0.33, 0.33],
    };
    editorPaneTree.set(threePaneSplit);
    focusedEditorPaneId.set(PANE_A);

    const { container: containerA } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const { container: containerB } = render(EditorPane, { filePath: PATH, paneId: PANE_B });
    const { container: containerC } = render(EditorPane, { filePath: PATH, paneId: PANE_C });
    await tick();

    const viewA = findView(containerA);
    const viewB = findView(containerB);
    const viewC = findView(containerC);

    viewA.dispatch({ changes: { from: 0, to: 0, insert: "fan-out" } });

    expect(viewB.state.doc.toString()).toBe("fan-out");
    expect(viewC.state.doc.toString()).toBe("fan-out");
  });

  it("split-while-dirty: a pane opened after a sibling has unsaved edits seeds from the live buffer, not savedDoc", async () => {
    seedTab("original\n");
    editorPaneTree.set({ type: "leaf", id: PANE_A, tabs: [PATH], activeTabPath: PATH });
    focusedEditorPaneId.set(PANE_A);

    const { container: containerA } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    await tick();

    const viewA = findView(containerA);
    // Simulate an unsaved edit: `tabsState`'s `savedDoc` is left unchanged.
    viewA.dispatch({ changes: { from: 0, to: 0, insert: "unsaved edit\n" } });
    expect(viewA.state.doc.toString()).toBe("unsaved edit\noriginal\n");

    // Now split again from that dirty state — pane B mounts over the same path.
    editorPaneTree.set(twoPaneSplit());
    const { container: containerB } = render(EditorPane, { filePath: PATH, paneId: PANE_B });
    await tick();

    const viewB = findView(containerB);
    expect(viewB.state.doc.toString()).toBe(viewA.state.doc.toString());

    // A subsequent edit in A still mirrors into B without throwing.
    expect(() => {
      viewA.dispatch({ changes: { from: 0, to: 0, insert: "more " } });
    }).not.toThrow();
    expect(viewB.state.doc.toString()).toBe(viewA.state.doc.toString());
  });

  it("undo does not cross panes: undoing in the receiving pane is a no-op with respect to a remote edit", async () => {
    seedTab("original\n");
    editorPaneTree.set(twoPaneSplit());
    focusedEditorPaneId.set(PANE_A);

    const { container: containerA } = render(EditorPane, { filePath: PATH, paneId: PANE_A });
    const { container: containerB } = render(EditorPane, { filePath: PATH, paneId: PANE_B });
    await tick();

    const viewA = findView(containerA);
    const viewB = findView(containerB);

    viewA.dispatch({
      changes: { from: 0, to: 0, insert: "typed in A\n" },
      userEvent: "input.type",
    });
    const bAfterMirror = viewB.state.doc.toString();
    expect(bAfterMirror).toBe("typed in A\noriginal\n");

    // Undo in B: nothing to undo there (the mirrored change was excluded
    // from B's own history), so B's document is unchanged, and nothing is
    // broadcast back to A as a result of this no-op.
    const undoHandledInB = undo(viewB);
    expect(undoHandledInB).toBe(false);
    expect(viewB.state.doc.toString()).toBe(bAfterMirror);
    expect(viewA.state.doc.toString()).toBe("typed in A\noriginal\n");

    // A's own undo still reverts its own typing normally.
    const undoHandledInA = undo(viewA);
    expect(undoHandledInA).toBe(true);
    expect(viewA.state.doc.toString()).toBe("original\n");
  });
});
