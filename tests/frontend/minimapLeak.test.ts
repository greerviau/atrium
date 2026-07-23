import { describe, it, expect, vi, afterEach } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import EditorPane from "../../src/lib/editor/EditorPane.svelte";
import { tabsState, type Tab } from "../../src/lib/stores/tabs";
import { focusedEditorPaneId } from "../../src/lib/stores/editorPanes";
import { setMinimapEnabled, DEFAULT_MINIMAP_ENABLED } from "../../src/lib/stores/minimapEnabled";

const PANE_ID = "pane-1";
const PATH = "/main.ts";

function seedTab(): Tab {
  const tab: Tab = {
    path: PATH,
    mode: "code",
    savedDoc: "line one\nline two\n",
    isDirty: false,
    hasExternalConflict: false,
    viewMode: "rendered",
  };
  tabsState.set({ tabs: [tab], activeTabPath: PATH });
  focusedEditorPaneId.set(PANE_ID);
  return tab;
}

// Regression test for the `@replit/codemirror-minimap` `Overlay.ts`
// window-listener leak (plan issue #155): `OverlayView.remove()` used to
// call `window.removeEventListener` with unbound method references that
// never matched what `create()` actually registered (freshly-bound
// closures), so every tab close permanently retained one more `OverlayView`
// and everything it closes over. Fixed via the `patch-package` patch at
// `patches/@replit+codemirror-minimap+0.5.2.patch`.
describe("minimap Overlay window-listener leak fix", () => {
  afterEach(() => {
    cleanup();
    tabsState.set({ tabs: [], activeTabPath: null });
    focusedEditorPaneId.set(null);
    setMinimapEnabled(DEFAULT_MINIMAP_ENABLED);
    vi.restoreAllMocks();
  });

  it("does not accumulate window mouseup/mousemove listeners across repeated tab close/reopen", async () => {
    const registered: Record<string, EventListenerOrEventListenerObject[]> = {
      mouseup: [],
      mousemove: [],
    };
    const originalAdd = window.addEventListener.bind(window);
    const originalRemove = window.removeEventListener.bind(window);

    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, opts) => {
      if (type === "mouseup" || type === "mousemove") {
        registered[type].push(listener as EventListenerOrEventListenerObject);
      }
      return originalAdd(type, listener as EventListenerOrEventListenerObject, opts);
    });
    vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, opts) => {
      if (type === "mouseup" || type === "mousemove") {
        const idx = registered[type].indexOf(listener as EventListenerOrEventListenerObject);
        if (idx !== -1) registered[type].splice(idx, 1);
      }
      return originalRemove(type, listener as EventListenerOrEventListenerObject, opts);
    });

    const TAB_CLOSE_REOPEN_CYCLES = 15;
    for (let i = 0; i < TAB_CLOSE_REOPEN_CYCLES; i++) {
      seedTab();
      const { unmount } = render(EditorPane, { filePath: PATH, paneId: PANE_ID });
      await tick();
      // Mirrors App.svelte's `{#each}`-driven teardown: the tab closes and
      // its pane unmounts, which runs EditorPane's `onDestroy` ->
      // `view.destroy()` -> the minimap's `OverlayView.destroy()`.
      tabsState.set({ tabs: [], activeTabPath: null });
      unmount();
      await tick();
    }

    expect(registered.mouseup.length).toBe(0);
    expect(registered.mousemove.length).toBe(0);
  });
});
