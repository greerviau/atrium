<script lang="ts">
  import type { PaneNode, SplitAxis, SplitDirection } from "./paneTree";
  import TerminalPanel from "./TerminalPanel.svelte";
  import PaneSplit from "./PaneSplit.svelte";

  let {
    tree,
    hasSplits,
    activePaneId,
    workspaceId,
    onFocus,
    onSplit,
    onClose,
    onNewTab,
    onCloseTab,
    onSetActiveTab,
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
    onNewTab: (paneId: string) => void;
    onCloseTab: (paneId: string, sessionId: string) => void;
    onSetActiveTab: (paneId: string, sessionId: string) => void;
    onTitleChange: (paneId: string, sessionId: string, title: string) => void;
    onResizeSplit: (splitId: string, index: number, delta: number, containerSizePx: number) => void;
  } = $props();

  let containerEl: HTMLDivElement | undefined = $state();

  // Pane sizes are stored as ratios (see paneTree.ts), so a divider drag
  // converts its pixel delta to a ratio against this split's own container
  // size at drag start — the same clamp-per-pixel-then-convert approach
  // App.svelte's dock-panel resizer already uses.
  function startDragResizer(event: PointerEvent, index: number, axis: SplitAxis, splitId: string): void {
    event.preventDefault();
    const containerSizePx = axis === "row" ? (containerEl?.clientWidth ?? 0) : (containerEl?.clientHeight ?? 0);
    let last = axis === "row" ? event.clientX : event.clientY;

    // `resizeSplit` adds `delta` onto whatever `sizes[index]` already is
    // (live-reactive via App.svelte's state), so this must send the
    // increment since the *last* pointermove, not the cumulative
    // displacement since the drag began — the latter would double-count
    // every prior event's movement on top of a size that already reflects
    // it, making the divider run away far faster than the pointer.
    function onMove(e: PointerEvent): void {
      if (containerSizePx <= 0) return;
      const current = axis === "row" ? e.clientX : e.clientY;
      const delta = (current - last) / containerSizePx;
      last = current;
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
    <div class="pane-body">
      <TerminalPanel
        {tree}
        {hasSplits}
        {workspaceId}
        onSplit={(direction) => onSplit(tree.id, direction)}
        onClosePanel={() => onClose(tree.id)}
        onNewTab={() => onNewTab(tree.id)}
        onCloseTab={(sessionId) => onCloseTab(tree.id, sessionId)}
        onSetActiveTab={(sessionId) => onSetActiveTab(tree.id, sessionId)}
        onTitleChange={(sessionId, title) => onTitleChange(tree.id, sessionId, title)}
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
          {onNewTab}
          {onCloseTab}
          {onSetActiveTab}
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
