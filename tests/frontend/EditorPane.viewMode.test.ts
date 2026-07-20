import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { Compartment } from "@codemirror/state";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, toggleMarkdownViewMode, markDirty, type Tab } from "../../src/lib/stores/tabs";

const FILE_PATH = "/notes.md";
// Blank first line keeps the default cursor (position 0, on line 1) off the
// heading's line, so the heading decoration isn't suppressed by the
// "raw source under cursor" rule (plan section 2.3) — the same setup
// `decorations.test.ts` uses for its own heading assertions.
const FIXTURE_DOC = "\n\n# Heading\n\n- [ ] todo\n";

function seedMarkdownTab(): Tab {
  const tab: Tab = {
    path: FILE_PATH,
    mode: "markdown",
    savedDoc: FIXTURE_DOC,
    isDirty: false,
    hasExternalConflict: false,
    viewMode: "rendered",
  };
  tabsState.set({ tabs: [tab], activeTabPath: FILE_PATH });
  return tab;
}

describe("EditorPane: markdown view-mode toggle", () => {
  beforeEach(() => {
    seedMarkdownTab();
  });

  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    vi.restoreAllMocks();
  });

  it("renders live-preview decorations by default, with no line-number gutter", () => {
    const { container } = render(EditorPane, { filePath: FILE_PATH });

    expect(container.querySelector(".cm-heading-1")).not.toBeNull();
    expect(container.querySelector("input.cm-task-checkbox")).not.toBeNull();
    expect(container.querySelector(".cm-lineNumbers")).toBeNull();
  });

  it("toggling to source view swaps in the raw view without losing document content", async () => {
    const { container } = render(EditorPane, { filePath: FILE_PATH });

    toggleMarkdownViewMode(FILE_PATH);
    await tick();

    expect(container.querySelector(".cm-heading-1")).toBeNull();
    expect(container.querySelector("input.cm-task-checkbox")).toBeNull();
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(container.querySelector(".cm-content")?.textContent).toContain("# Heading");
    expect(container.querySelector(".cm-content")?.textContent).toContain("- [ ] todo");
  });

  it("toggling back to rendered view restores decorations and removes the gutter", async () => {
    const { container } = render(EditorPane, { filePath: FILE_PATH });

    toggleMarkdownViewMode(FILE_PATH);
    await tick();
    toggleMarkdownViewMode(FILE_PATH);
    await tick();

    expect(container.querySelector(".cm-heading-1")).not.toBeNull();
    expect(container.querySelector("input.cm-task-checkbox")).not.toBeNull();
    expect(container.querySelector(".cm-lineNumbers")).toBeNull();
  });

  it("reconfigures the view-mode compartment only when viewMode actually changes", async () => {
    const reconfigureSpy = vi.spyOn(Compartment.prototype, "reconfigure");
    render(EditorPane, { filePath: FILE_PATH });
    await tick();
    // One call on mount, from the (unguarded) theme-compartment effect.
    const callsAfterMount = reconfigureSpy.mock.calls.length;

    // An unrelated tab-store update (isDirty flipping) must not trigger a
    // view-mode reconfigure — this is the guard described in plan section
    // 3.3 step 4, protecting against a reconfigure on every keystroke.
    markDirty(FILE_PATH);
    await tick();
    expect(reconfigureSpy.mock.calls.length).toBe(callsAfterMount);

    toggleMarkdownViewMode(FILE_PATH);
    await tick();
    expect(reconfigureSpy.mock.calls.length).toBe(callsAfterMount + 1);
  });
});
