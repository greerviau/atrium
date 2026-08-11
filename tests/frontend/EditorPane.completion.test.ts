import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { language } from "@codemirror/language";
import { startCompletion, completionStatus } from "@codemirror/autocomplete";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";

const DOC = "def mmap_read():\n    pass\n\nmm";

function seedTab(tab: Tab): void {
  tabsState.set({ tabs: [tab], activeTabPath: tab.path });
}

function findView(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("expected an EditorView to be mounted");
  return view;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLanguage(view: EditorView, name: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (view.state.facet(language)?.name === name) return;
    await sleep(10);
  }
  throw new Error(`expected language "${name}" to load within the timeout`);
}

/**
 * Opens the tooltip and waits until it is genuinely acceptable: past both
 * the time it takes the language's own completion source to resolve *and*
 * `interactionDelay` (75ms), CodeMirror's own misclick guard on `Tab`/Enter
 * accepting a tooltip that only just opened. Measured under vitest's real
 * (non-fake-timer) jsdom clock: the tooltip can take ~250-300ms to reach
 * `completionStatus === "active"` in the first place, so a single fixed
 * sleep risks landing inside the interactionDelay window right after it
 * opens — hence polling for "active" first, then waiting the delay margin
 * on top of that, rather than one bare `setTimeout`.
 */
async function openCompletionAndWaitPastInteractionDelay(view: EditorView): Promise<void> {
  startCompletion(view);
  for (let i = 0; i < 100; i++) {
    if (completionStatus(view.state) === "active") break;
    await sleep(20);
  }
  if (completionStatus(view.state) !== "active") {
    throw new Error("expected the completion tooltip to become active within the timeout");
  }
  await sleep(300);
}

function pressKey(view: EditorView, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  return runScopeHandlers(view, event, "editor");
}

describe("EditorPane: Tab-accept completion (issue #435)", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
  });

  it("accepts the selected completion on Tab, inserting no leading indentation", async () => {
    seedTab({
      path: "/example.py",
      workspaceId: "local",
      mode: "code",
      savedDoc: DOC,
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });
    const view = findView(container);
    await waitForLanguage(view, "python");
    view.dispatch({ selection: { anchor: DOC.length } });

    await openCompletionAndWaitPastInteractionDelay(view);

    const handled = pressKey(view, "Tab");

    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe("def mmap_read():\n    pass\n\nmmap_read");
  });

  it("does not accept a completion on Enter, and inserts a newline instead", async () => {
    seedTab({
      path: "/example.py",
      workspaceId: "local",
      mode: "code",
      savedDoc: DOC,
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });
    const view = findView(container);
    await waitForLanguage(view, "python");
    view.dispatch({ selection: { anchor: DOC.length } });

    await openCompletionAndWaitPastInteractionDelay(view);

    pressKey(view, "Enter");

    expect(view.state.doc.toString()).toBe("def mmap_read():\n    pass\n\nmm\n");
  });

  it("moves the selection with ArrowDown and closes the tooltip with Escape", async () => {
    seedTab({
      path: "/example.py",
      workspaceId: "local",
      mode: "code",
      savedDoc: DOC,
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });
    const view = findView(container);
    await waitForLanguage(view, "python");
    view.dispatch({ selection: { anchor: DOC.length } });

    await openCompletionAndWaitPastInteractionDelay(view);

    const arrowHandled = pressKey(view, "ArrowDown");
    expect(arrowHandled).toBe(true);
    expect(completionStatus(view.state)).toBe("active");

    const escapeHandled = pressKey(view, "Escape");
    expect(escapeHandled).toBe(true);
    expect(completionStatus(view.state)).toBeNull();
  });

  it("still indents when Tab is pressed with no completion open", async () => {
    seedTab({
      path: "/example.py",
      workspaceId: "local",
      mode: "code",
      savedDoc: "\n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });
    const view = findView(container);

    expect(completionStatus(view.state)).toBeNull();
    pressKey(view, "Tab");

    expect(view.state.doc.toString()).toBe("  \n");
  });

  it("still dedents on Shift-Tab", async () => {
    seedTab({
      path: "/example.py",
      workspaceId: "local",
      mode: "code",
      savedDoc: "    \n",
      isDirty: false,
      hasExternalConflict: false,
      isExternal: false,
      isDeleted: false,
    });
    const { container } = render(EditorPane, { filePath: "/example.py", paneId: "pane-1" });
    const view = findView(container);
    view.dispatch({ selection: { anchor: 4 } });

    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    runScopeHandlers(view, event, "editor");

    expect(view.state.doc.toString()).toBe("  \n");
  });
});
