import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { Compartment, type StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, toggleMarkdownViewMode, markDirty, type Tab } from "../../src/lib/stores/tabs";

// `StateEffect.type` is a real runtime field (used internally by `.is()`)
// but isn't part of `@codemirror/state`'s public `.d.ts`, hence the cast.
function effectTypeOf(effect: StateEffect<unknown> | undefined): unknown {
  return (effect as unknown as { type: unknown } | undefined)?.type;
}

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

  // Regression guard for issue #87 (stale/incomplete decorations after
  // toggling back to rendered view). The actual bug is a CodeMirror viewport
  // staleness that only manifests through real DOM layout: without real,
  // mode-dependent line-height measurements, jsdom's viewport sizing ends up
  // mode-independent regardless of whether the fix is present, so a
  // decoration-coverage comparison here can't reliably distinguish fixed
  // from unfixed code (confirmed empirically — see PR discussion). Reliably
  // mocking CodeMirror's real measurement path (`getBoundingClientRect` plus
  // the `Range` APIs it also depends on) to recreate the divergence isn't
  // practical under jsdom either. This test instead verifies the fix's
  // mechanism directly and deterministically: that toggling view mode
  // dispatches a scroll-anchoring effect (`EditorView.scrollIntoView` or the
  // equivalent `view.scrollSnapshot()`) in the *same* transaction as the compartment
  // reconfigure — the specific thing the root-cause analysis identifies as
  // forcing CodeMirror's `ViewState.update()` to recompute the viewport
  // instead of carrying over a stale one. Confirming the actual decoration
  // outcome still requires a real browser (see `tests/e2e`).
  it("dispatches a scroll-anchoring effect in the same transaction as the view-mode reconfigure (issue #87)", async () => {
    // Installed before `render`, like the `Compartment.prototype.reconfigure`
    // spy above — installing it after `render` misses calls the component's
    // own `@codemirror/view` module instance makes (a Vite module-resolution
    // quirk this file already works around for the reconfigure spy).
    const dispatchSpy = vi.spyOn(EditorView.prototype, "dispatch");
    render(EditorPane, { filePath: FILE_PATH });
    await tick();
    const callsAfterMount = dispatchSpy.mock.calls.length;

    toggleMarkdownViewMode(FILE_PATH);
    await tick();

    // `EditorView.scrollIntoView` and `view.scrollSnapshot()` both produce a
    // `StateEffect` of the same internal type, so this matches either
    // implementation of the fix.
    const scrollAnchorType = effectTypeOf(EditorView.scrollIntoView(0, {}));
    const toggleDispatch = dispatchSpy.mock.calls.slice(callsAfterMount).find(([spec]) => {
      const effects = Array.isArray(spec?.effects) ? spec.effects : spec?.effects ? [spec.effects] : [];
      return effects.some((effect) => effectTypeOf(effect as StateEffect<unknown> | undefined) === scrollAnchorType);
    });

    expect(toggleDispatch).toBeDefined();
  });
});
