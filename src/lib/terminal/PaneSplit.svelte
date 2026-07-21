<script lang="ts">
  import type { PaneNode, SplitDirection } from "./paneTree";
  import TerminalPane from "./TerminalPane.svelte";
  import PaneSplit from "./PaneSplit.svelte";

  let {
    tree,
    hasSplits,
    activePaneId,
    workspaceId,
    onFocus,
    onSplit,
    onClose,
    onTitleChange,
    onResizeSplit,
  }: {
    tree: PaneNode;
    hasSplits: boolean;
    activePaneId: string;
    workspaceId: string;
    onFocus: (paneId: string) => void;
    onSplit: (paneId: string, direction: SplitDirection) => void;
    onClose: (paneId: string) => void;
    onTitleChange: (paneId: string, title: string) => void;
    onResizeSplit: (splitId: string, index: number, delta: number, containerSizePx: number) => void;
  } = $props();

  let containerEl: HTMLDivElement | undefined = $state();

  // Pane sizes are stored as ratios (see paneTree.ts), so a divider drag
  // converts its pixel delta to a ratio against this split's own container
  // size at drag start — the same clamp-per-pixel-then-convert approach
  // App.svelte's dock-panel resizer already uses.
  function startDragResizer(event: PointerEvent, index: number, direction: SplitDirection, splitId: string): void {
    event.preventDefault();
    const containerSizePx = direction === "row" ? (containerEl?.clientWidth ?? 0) : (containerEl?.clientHeight ?? 0);
    const start = direction === "row" ? event.clientX : event.clientY;

    function onMove(e: PointerEvent): void {
      if (containerSizePx <= 0) return;
      const current = direction === "row" ? e.clientX : e.clientY;
      const delta = (current - start) / containerSizePx;
      onResizeSplit(splitId, index, delta, containerSizePx);
    }
    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
</script>

{#if tree.type === "leaf"}
  <div class="pane-leaf" class:active={tree.id === activePaneId} onfocusin={() => onFocus(tree.id)}>
    {#if hasSplits}
      <div class="pane-header">
        <span class="pane-title" title={tree.title}>{tree.title}</span>
        <div class="pane-actions">
          <button
            class="pane-action"
            onclick={() => onSplit(tree.id, "row")}
            aria-label="Split pane right"
            title="Split right"
          >
            ⬒
          </button>
          <button
            class="pane-action"
            onclick={() => onSplit(tree.id, "column")}
            aria-label="Split pane down"
            title="Split down"
          >
            ⬓
          </button>
          <button class="pane-action" onclick={() => onClose(tree.id)} aria-label="Close pane" title="Close pane">
            ×
          </button>
        </div>
      </div>
    {/if}
    <div class="pane-body">
      <TerminalPane
        cwd={tree.cwd}
        {workspaceId}
        onExit={() => onClose(tree.id)}
        onTitleChange={(title) => onTitleChange(tree.id, title)}
      />
    </div>
  </div>
{:else}
  <div class="pane-split" class:row={tree.direction === "row"} class:column={tree.direction === "column"} bind:this={containerEl}>
    {#each tree.children as child, i (child.id)}
      {#if i > 0}
        <div
          class="pane-resizer"
          class:vertical={tree.direction === "row"}
          class:horizontal={tree.direction === "column"}
          role="separator"
          aria-orientation={tree.direction === "row" ? "vertical" : "horizontal"}
          onpointerdown={(e) => startDragResizer(e, i - 1, tree.direction, tree.id)}
        ></div>
      {/if}
      <div class="pane-child" style={`flex: ${tree.sizes[i]} 1 0`}>
        <PaneSplit
          tree={child}
          {hasSplits}
          {activePaneId}
          {workspaceId}
          {onFocus}
          {onSplit}
          {onClose}
          {onTitleChange}
          {onResizeSplit}
        />
      </div>
    {/each}
  </div>
{/if}

<style>
  .pane-leaf {
    height: 100%;
    width: 100%;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 2px 6px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--atrium-border);
  }

  .pane-title {
    font-size: 11px;
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pane-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  .pane-action {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.6;
    padding: 2px 4px;
  }

  .pane-action:hover {
    opacity: 1;
  }

  .pane-body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .pane-split {
    height: 100%;
    width: 100%;
    min-height: 0;
    min-width: 0;
    display: flex;
  }

  .pane-split.row {
    flex-direction: row;
  }

  .pane-split.column {
    flex-direction: column;
  }

  .pane-child {
    min-height: 0;
    min-width: 0;
    display: flex;
  }

  .pane-resizer {
    background: transparent;
    flex-shrink: 0;
  }

  .pane-resizer.vertical {
    width: 4px;
    cursor: col-resize;
  }

  .pane-resizer.horizontal {
    height: 4px;
    cursor: row-resize;
  }
</style>
