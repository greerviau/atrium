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
  // mechanism directly and deterministically. Two things must both hold:
  //
  // 1. The compartment reconfigure and a scroll-anchoring effect
  //    (`EditorView.scrollIntoView`, anchored on the selection head) are
  //    dispatched in the *same* transaction — the thing that forces
  //    `ViewState.update()` to recompute the viewport instead of carrying
  //    over a stale one. `view.scrollSnapshot()`'s anchor is constructed to
  //    already sit inside the current viewport, so it doesn't reliably force
  //    this recompute on its own — the head does, since it's off-screen in
  //    the case that matters (scrolled away from the cursor without moving
  //    it, which defaults to position 0 on open).
  // 2. A further dispatch with a scroll-anchoring effect and no reconfigure
  //    follows — a `scrollSnapshot()` captured before the toggle, which
  //    supersedes the head-anchored target before it's ever applied to the
  //    real DOM, so the visible scroll position lands where the user
  //    actually was, not at the cursor.
  //
  // Confirming the actual decoration outcome, and that the real DOM scroll
  // position doesn't visibly jump, still requires a real browser (see
  // `tests/e2e`) — `EditorView`'s scroll application is itself gated behind
  // a real, nonzero `editorHeight` that jsdom never provides.
  it("forces the viewport recompute via an off-screen scroll target, then supersedes it with the actual scroll position (issue #87)", async () => {
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
    // `StateEffect` of the same internal type, so this matches either.
    const scrollAnchorType = effectTypeOf(EditorView.scrollIntoView(0, {}));
    const reconfigureType = effectTypeOf(Compartment.prototype.reconfigure.call(new Compartment(), []));

    const toggleCalls = dispatchSpy.mock.calls.slice(callsAfterMount).map(([spec]) => {
      const effects = Array.isArray(spec?.effects) ? spec.effects : spec?.effects ? [spec.effects] : [];
      return {
        hasReconfigure: effects.some((effect) => effectTypeOf(effect as StateEffect<unknown> | undefined) === reconfigureType),
        hasScrollAnchor: effects.some((effect) => effectTypeOf(effect as StateEffect<unknown> | undefined) === scrollAnchorType),
      };
    });

    const forcingDispatch = toggleCalls.find((call) => call.hasReconfigure && call.hasScrollAnchor);
    expect(forcingDispatch).toBeDefined();

    const supersedingDispatch = toggleCalls.find((call) => !call.hasReconfigure && call.hasScrollAnchor);
    expect(supersedingDispatch).toBeDefined();
  });
});
