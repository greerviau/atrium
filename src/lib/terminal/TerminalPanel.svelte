<script lang="ts">
  import type { LeafPane, SplitDirection } from "./paneTree";
  import TerminalPane from "./TerminalPane.svelte";
  import SplitMenu from "./SplitMenu.svelte";

  /**
   * One leaf's full top bar (tab strip + controls) and its stack of
   * `TerminalPane` instances, one per session — `hidden` toggled by
   * `tree.activeTabId` so switching tabs within this panel never kills a
   * PTY. Every callback here is scoped to this leaf: the caller (`PaneSplit`)
   * binds `tree.id` via closures, so this component never needs to know its
   * own pane id beyond `tree.id` itself.
   */
  let {
    tree,
    hasSplits,
    workspaceId,
    onSplit,
    onClosePanel,
    onNewTab,
    onCloseTab,
    onSetActiveTab,
    onTitleChange,
  }: {
    tree: LeafPane;
    hasSplits: boolean;
    workspaceId: string;
    onSplit: (direction: SplitDirection) => void;
    onClosePanel: () => void;
    onNewTab: () => void;
    onCloseTab: (sessionId: string) => void;
    onSetActiveTab: (sessionId: string) => void;
    onTitleChange: (sessionId: string, title: string) => void;
  } = $props();
</script>

<div class="terminal-panel">
  <div class="tab-strip">
    <div class="tab-list">
      {#each tree.tabs as session (session.id)}
        <div
          class="tab"
          class:active={session.id === tree.activeTabId}
          onclick={() => onSetActiveTab(session.id)}
          onkeydown={(e) => e.key === "Enter" && onSetActiveTab(session.id)}
          role="tab"
          tabindex="0"
          aria-selected={session.id === tree.activeTabId}
        >
          <span class="tab-name" title={session.title}>{session.title}</span>
          <button
            class="tab-close"
            onclick={(e) => {
              e.stopPropagation();
              onCloseTab(session.id);
            }}
            aria-label="Close terminal"
          >
            ×
          </button>
        </div>
      {/each}
      <button class="tab new-tab" onclick={onNewTab}>+</button>
    </div>
    <div class="tab-strip-controls">
      <SplitMenu {onSplit} />
      {#if hasSplits}
        <button class="tab-strip-btn" onclick={onClosePanel} aria-label="Close panel" title="Close panel">×</button>
      {/if}
    </div>
  </div>
  <div class="terminal-panes">
    {#each tree.tabs as session (session.id)}
      <div class="terminal-pane-slot" class:hidden={session.id !== tree.activeTabId}>
        <TerminalPane
          cwd={session.cwd}
          {workspaceId}
          onExit={() => onCloseTab(session.id)}
          onTitleChange={(title) => onTitleChange(session.id, title)}
        />
      </div>
    {/each}
  </div>
</div>

<style>
  .terminal-panel {
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

  .tab-close {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    opacity: 0.6;
    padding: 0 2px;
  }

  .tab-close:hover {
    opacity: 1;
  }

  .tab-strip-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: 3px;
    color: inherit;
    font: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.6;
    padding: 4px 6px;
  }

  .tab-strip-btn:hover {
    opacity: 1;
  }

  .terminal-panes {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .terminal-pane-slot {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }

  .terminal-pane-slot.hidden {
    display: none;
  }
</style>
