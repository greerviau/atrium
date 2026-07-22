<script lang="ts">
  import type { PaneNode, SplitDirection } from "./paneTree";
  import { listLeaves } from "./paneTree";
  import { computeRects, computeResizers, type ResizerRect } from "./paneLayout";
  import TerminalPanel from "./TerminalPanel.svelte";

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

  let rootEl: HTMLDivElement | undefined = $state();

  // Every leaf and split node's rectangle, as a percentage of `rootEl`'s own
  // box — recomputed (cheaply; this is pure arithmetic) whenever the tree
  // shape or any split's sizes change. Leaves are rendered from this flat,
  // keyed list rather than recursing over the tree, so a shape change that
  // leaves an existing leaf's id in place never destroys or remounts that
  // leaf's `TerminalPanel` (and the PTY it owns) — see issue #112.
  let rects = $derived(computeRects(tree, { top: 0, left: 0, width: 100, height: 100 }));
  let leaves = $derived(listLeaves(tree));
  let resizers = $derived(computeResizers(tree, rects));

  // Pane sizes are stored as ratios (see paneTree.ts), so a divider drag
  // converts its pixel delta to a ratio against its own split's container
  // size at drag start — the same clamp-per-pixel-then-convert approach
  // App.svelte's dock-panel resizer already uses. There's only one real
  // container element now (`rootEl`); a given split's own local pixel size
  // is derived by scaling `rootEl`'s size down by that split's rectangle
  // fraction, matching what the split's own `clientWidth`/`clientHeight`
  // would have been under the old nested-flexbox layout.
  function startDragResizer(event: PointerEvent, rz: ResizerRect): void {
    event.preventDefault();
    const splitRect = rects.get(rz.splitId);
    const rootSizePx = rz.orientation === "row" ? (rootEl?.clientWidth ?? 0) : (rootEl?.clientHeight ?? 0);
    const fraction = rz.orientation === "row" ? (splitRect?.width ?? 100) : (splitRect?.height ?? 100);
    const containerSizePx = rootSizePx * (fraction / 100);
    let last = rz.orientation === "row" ? event.clientX : event.clientY;

    // `resizeSplit` adds `delta` onto whatever `sizes[index]` already is
    // (live-reactive via App.svelte's state), so this must send the
    // increment since the *last* pointermove, not the cumulative
    // displacement since the drag began — the latter would double-count
    // every prior event's movement on top of a size that already reflects
    // it, making the divider run away far faster than the pointer.
    function onMove(e: PointerEvent): void {
      if (containerSizePx <= 0) return;
      const current = rz.orientation === "row" ? e.clientX : e.clientY;
      const delta = (current - last) / containerSizePx;
      last = current;
      onResizeSplit(rz.splitId, rz.index, delta, containerSizePx);
    }
    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
</script>

<div class="pane-split-root" bind:this={rootEl}>
  {#each leaves as leaf (leaf.id)}
    {@const r = rects.get(leaf.id)!}
    <div
      class="pane-leaf"
      class:active={leaf.id === activePaneId}
      style={`top: ${r.top}%; left: ${r.left}%; width: ${r.width}%; height: ${r.height}%`}
      onfocusin={() => onFocus(leaf.id)}
    >
      <div class="pane-body">
        <TerminalPanel
          tree={leaf}
          {hasSplits}
          {workspaceId}
          onSplit={(direction) => onSplit(leaf.id, direction)}
          onClosePanel={() => onClose(leaf.id)}
          onNewTab={() => onNewTab(leaf.id)}
          onCloseTab={(sessionId) => onCloseTab(leaf.id, sessionId)}
          onSetActiveTab={(sessionId) => onSetActiveTab(leaf.id, sessionId)}
          onTitleChange={(sessionId, title) => onTitleChange(leaf.id, sessionId, title)}
        />
      </div>
    </div>
  {/each}

  {#each resizers as rz (rz.key)}
    <div
      class="pane-resizer"
      class:vertical={rz.orientation === "row"}
      class:horizontal={rz.orientation === "column"}
      role="separator"
      aria-orientation={rz.orientation === "row" ? "vertical" : "horizontal"}
      style={rz.orientation === "row"
        ? `left: calc(${rz.offsetPercent}% - 2px); top: ${rz.crossRect.start}%; height: ${rz.crossRect.length}%`
        : `top: calc(${rz.offsetPercent}% - 2px); left: ${rz.crossRect.start}%; width: ${rz.crossRect.length}%`}
      onpointerdown={(e) => startDragResizer(e, rz)}
    ></div>
  {/each}
</div>

<style>
  .pane-split-root {
    position: relative;
    height: 100%;
    width: 100%;
    min-height: 0;
    min-width: 0;
  }

  .pane-leaf {
    position: absolute;
    display: flex;
    flex-direction: column;
  }

  .pane-body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .pane-resizer {
    position: absolute;
    background: transparent;
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
