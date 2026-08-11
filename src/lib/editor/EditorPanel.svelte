<script lang="ts">
  import { tick } from "svelte";
  import { flip } from "svelte/animate";
  import type { EditorLeafPane, SplitDirection } from "./editorPaneTree";
  import {
    tabsState,
    reloadFromDiskReportingErrors,
    dismissConflict,
    toggleMarkdownViewMode,
    requestSaveReportingErrors,
    closeTab,
  } from "../stores/tabs";
  import EditorPane from "./EditorPane.svelte";
  import DataPane from "./DataPane.svelte";
  import ImagePane from "./ImagePane.svelte";
  import EditorSplitMenu from "./EditorSplitMenu.svelte";
  import { tooltip } from "../ui/tooltip";
  import { beginTabDrag, draggingTabKey, type TabDropTarget } from "./tabDrag";
  import { basename } from "../util/path";

  /**
   * One leaf's full top bar (tab strip + controls) and its stack of editor,
   * data, or image panes, one per open path in this leaf; `hidden`
   * toggled by `tree.activeTabPath` so switching tabs within this panel
   * never destroys/recreates an `EditorView`. Modeled on the terminal's own
   * `TerminalPanel.svelte`; every callback here is scoped to this leaf, the
   * same way. Unlike the terminal, there's no "+" new-tab button — opening a
   * file is always driven by the explorer/search/links, never from inside a
   * pane's own tab strip.
   */
  let {
    tree,
    onSplit,
    onSetActiveTab,
    onCloseTab,
    onReorderTab,
    onDropTab = () => {},
  }: {
    tree: EditorLeafPane;
    onSplit: (direction: SplitDirection) => void;
    onSetActiveTab: (path: string) => void;
    // The tab's × button — a deliberate close of this leaf's own view of the path.
    onCloseTab: (path: string) => void;
    onReorderTab: (path: string, toIndex: number) => void;
    onDropTab?: (path: string, target: TabDropTarget) => void;
  } = $props();

  let tabListEl: HTMLDivElement | undefined = $state();
  let suppressClickPath = $state<string | null>(null);

  /**
   * The pane stack's own iteration order — deliberately NOT `tree.tabs` (the
   * tab strip's own, user-reorderable order). Both arrays hold the same
   * membership (`tree.tabs` is always a subset of `tabsState.tabs`'s open
   * paths), but this each-block must not share the strip's iteration order:
   * `.editor-pane-slot` is `position: absolute; inset: 0`, so its DOM order
   * has zero visual meaning — but a Svelte keyed `{#each}` reorder is still a
   * physical DOM detach-and-reinsert even when the reused node's own
   * *identity* survives, and that would silently drop the one visible slot's
   * live CodeMirror `scrollTop` and blur its focus on every drag commit.
   * `tabsState.tabs`'s own order is never touched by `moveTabInLeaf`, so
   * keying off it here means this each-block simply never reorders in
   * response to a tab-strip drag at all.
   */
  let stablePaneOrder = $derived($tabsState.tabs.map((t) => t.path).filter((path) => tree.tabs.includes(path)));

  function onTabListWheel(event: WheelEvent): void {
    if (event.deltaY === 0) return;
    const tabList = event.currentTarget as HTMLDivElement;
    tabList.scrollLeft += event.deltaY;
    event.preventDefault();
  }

  function onTabPointerDown(event: PointerEvent, path: string): void {
    const target = event.target as HTMLElement;
    if (target.closest(".tab-close, .tab-view-mode")) return; // let those buttons' own onclick handle it
    if (event.button !== 0) return;
    if (!tabListEl) return;
    beginTabDrag(
      event.currentTarget as HTMLElement,
      event,
      `${tree.id}:${path}`,
      path,
      () =>
        Array.from(tabListEl!.querySelectorAll<HTMLElement>(".tab")).map((el) => ({
          path: el.dataset.tabPath!,
          rect: el.getBoundingClientRect(),
        })),
      (draggedPath, toIndex) => onReorderTab(draggedPath, toIndex),
      {
        surface: "editor",
        paneId: tree.id,
        label: basename(path),
        onDrop: (target) => onDropTab(path, target),
        onDragEnd: (didDrag) => {
          suppressClickPath = didDrag ? path : null;
        },
      },
    );
  }

  function onTabClick(path: string): void {
    if (suppressClickPath === path) {
      suppressClickPath = null;
      return;
    }
    onSetActiveTab(path);
  }

  async function onTabKeyDown(event: KeyboardEvent, path: string): Promise<void> {
    if (event.key === "Enter") {
      onSetActiveTab(path);
      return;
    }
    if (!event.metaKey || !event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // Captured before the `await` below, not read after it: per the DOM spec,
    // `event.currentTarget` is reset to `null` once the event's synchronous
    // dispatch finishes, which happens before `tick()` resolves.
    const tabEl = event.currentTarget as HTMLElement;
    const currentIndex = tree.tabs.indexOf(path);
    const toIndex = event.key === "ArrowLeft" ? currentIndex - 1 : currentIndex + 1;
    onReorderTab(path, toIndex);
    // Moving a tab RIGHT physically relocates the *focused* node itself in
    // Svelte's keyed reconciliation (moving LEFT happens to relocate a
    // neighbour instead, which is why this was easy to miss by hand-testing
    // only one direction) — either way the move blurs focus to <body> unless
    // it's explicitly restored. `tabEl` itself is still the correct element
    // to refocus after the move: Svelte's keyed `{#each}` preserves this
    // node's own identity across a reorder, it's only DOM *focus* that
    // doesn't survive the relocation. `tick()` waits for the reorder to
    // actually flush to the DOM before refocusing — calling `.focus()`
    // before that would act on the element's pre-move state and could be a
    // no-op depending on timing.
    await tick();
    tabEl.focus();
  }
</script>

<div class="editor-panel">
  <div class="tab-strip">
    <div class="tab-list" role="tablist" bind:this={tabListEl} onwheel={onTabListWheel}>
      {#each tree.tabs as path (path)}
        {@const tab = $tabsState.tabs.find((t) => t.path === path)}
        <div
          class="tab"
          class:active={path === tree.activeTabPath}
          class:dragging={$draggingTabKey === `${tree.id}:${path}`}
          data-tab-path={path}
          onpointerdown={(e) => onTabPointerDown(e, path)}
          onclick={() => onTabClick(path)}
          onkeydown={(e) => onTabKeyDown(e, path)}
          role="tab"
          tabindex="0"
          aria-selected={path === tree.activeTabPath}
          title={tab?.isExternal ? path : undefined}
          animate:flip={{ duration: $draggingTabKey === `${tree.id}:${path}` ? 0 : 150 }}
        >
          {#if tab?.isExternal}
            <span class="tab-external-badge" aria-label="Opened from outside the workspace">⌁</span>
          {/if}
          <span class="tab-name">
            {basename(path)}{tab?.isDirty ? " •" : ""}
          </span>
          {#if tab?.mode === "markdown"}
            <button
              class="tab-view-mode"
              onclick={(e) => {
                e.stopPropagation();
                toggleMarkdownViewMode(path);
              }}
              aria-label={tab.viewMode === "source" ? "Switch to rendered view" : "Switch to source view"}
              use:tooltip={{ label: tab.viewMode === "source" ? "Switch to rendered view" : "Switch to source view" }}
            >
              {tab.viewMode === "source" ? "{}" : "¶"}
            </button>
          {/if}
          <button
            class="tab-close"
            onclick={(e) => {
              e.stopPropagation();
              onCloseTab(path);
            }}
            aria-label={`Close ${path}`}
          >
            ×
          </button>
        </div>
      {/each}
    </div>
    <div class="tab-strip-controls">
      <EditorSplitMenu {onSplit} />
    </div>
  </div>
  <div class="editor-panes">
    {#each stablePaneOrder as path (path)}
      {@const tab = $tabsState.tabs.find((t) => t.path === path)}
      <div class="editor-pane-slot" class:hidden={path !== tree.activeTabPath}>
        {#if tab?.hasExternalConflict}
          <div class="conflict-banner">
            File changed on disk.
            <button onclick={() => reloadFromDiskReportingErrors(path)}>Reload</button>
            <button onclick={() => dismissConflict(path)}>Keep mine</button>
          </div>
        {:else if tab?.isDeleted}
          <div class="conflict-banner deleted-banner">
            File was deleted.
            <button onclick={() => requestSaveReportingErrors(path)}>Save</button>
            <button onclick={() => closeTab(path)}>Close</button>
          </div>
        {/if}
        {#if tab?.mode === "data"}
          <DataPane filePath={path} workspaceId={tab.workspaceId} />
        {:else if tab?.mode === "image"}
          <ImagePane filePath={path} workspaceId={tab.workspaceId} />
        {:else}
          <EditorPane filePath={path} paneId={tree.id} />
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .editor-panel {
    height: 100%;
    width: 100%;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .tab-strip {
    display: flex;
    border-bottom: 1px solid var(--atrium-border);
    flex-shrink: 0;
  }

  .tab-list {
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none; /* Firefox; inert on Atrium's WKWebView, harmless elsewhere */
  }
  .tab-list::-webkit-scrollbar {
    display: none; /* removes the bar entirely — unlike width/height: 0, this reserves no track space */
  }

  .tab-strip-controls {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
    flex-shrink: 0;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: none;
    border: none;
    border-right: 1px solid var(--atrium-border);
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
    -webkit-user-select: none;
    user-select: none;
    -webkit-user-drag: none;
    touch-action: none; /* pointer events drive the gesture, not the browser's own touch-scroll — a decision, harmless on macOS today */
  }

  .tab.active {
    background: var(--atrium-bg-active);
  }

  .tab.dragging {
    opacity: 0.2;
    cursor: grabbing;
    z-index: 1;
    position: relative;
  }

  .tab-name {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-external-badge {
    opacity: 0.6;
    font-size: 0.85em;
  }

  .tab-view-mode,
  .tab-close {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    opacity: 0.6;
    padding: 0 2px;
  }

  .tab-view-mode:hover,
  .tab-close:hover {
    opacity: 1;
  }

  .editor-panes {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .editor-pane-slot {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }

  .editor-pane-slot.hidden {
    display: none;
  }

  .conflict-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: var(--atrium-warning-bg);
    color: var(--atrium-text-primary);
    flex-shrink: 0;
  }

  .deleted-banner {
    background: var(--atrium-danger);
    color: var(--atrium-danger-text);
  }
</style>
