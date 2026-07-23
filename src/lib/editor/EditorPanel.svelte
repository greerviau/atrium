<script lang="ts">
  import type { EditorLeafPane, SplitDirection } from "./editorPaneTree";
  import { tabsState, reloadFromDisk, dismissConflict, toggleMarkdownViewMode } from "../stores/tabs";
  import EditorPane from "./EditorPane.svelte";
  import EditorSplitMenu from "./EditorSplitMenu.svelte";
  import { tooltip } from "../ui/tooltip";

  /**
   * One leaf's full top bar (tab strip + controls) and its stack of
   * `EditorPane` instances, one per open path in this leaf — `hidden`
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
  }: {
    tree: EditorLeafPane;
    onSplit: (direction: SplitDirection) => void;
    onSetActiveTab: (path: string) => void;
    // The tab's × button — a deliberate close of this leaf's own view of the path.
    onCloseTab: (path: string) => void;
  } = $props();

  function basename(path: string): string {
    return path.split("/").pop() ?? path;
  }
</script>

<div class="editor-panel">
  <div class="tab-strip">
    <div class="tab-list">
      {#each tree.tabs as path (path)}
        {@const tab = $tabsState.tabs.find((t) => t.path === path)}
        <div
          class="tab"
          class:active={path === tree.activeTabPath}
          onclick={() => onSetActiveTab(path)}
          onkeydown={(e) => e.key === "Enter" && onSetActiveTab(path)}
          role="tab"
          tabindex="0"
          aria-selected={path === tree.activeTabPath}
        >
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
    {#each tree.tabs as path (path)}
      {@const tab = $tabsState.tabs.find((t) => t.path === path)}
      <div class="editor-pane-slot" class:hidden={path !== tree.activeTabPath}>
        {#if tab?.hasExternalConflict}
          <div class="conflict-banner">
            File changed on disk.
            <button onclick={() => reloadFromDisk(path)}>Reload</button>
            <button onclick={() => dismissConflict(path)}>Keep mine</button>
          </div>
        {/if}
        <EditorPane filePath={path} paneId={tree.id} />
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
  }

  .tab.active {
    background: var(--atrium-bg-active);
  }

  .tab-name {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
</style>
