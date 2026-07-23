<script lang="ts">
  import type { EditorPaneNode, SplitDirection } from "./editorPaneTree";
  import { listLeaves } from "./editorPaneTree";
  import { computeRects, computeResizers, type ResizerRect } from "../terminal/paneLayout";
  import { zoom } from "../stores/textSize";
  import EditorPanel from "./EditorPanel.svelte";

  /**
   * Renders `listLeaves(tree)` in a flat, `leaf.id`-keyed `{#each}`,
   * positioned absolutely by rectangles computed once per render from the
   * (shared, generic) `paneLayout.ts` helpers — the same flat-render
   * strategy the terminal's own `PaneSplit.svelte` uses, and for the same
   * reason (issue #112): a split/close changes tree *shape*, but as long as
   * a leaf's `id` survives the change, this never unmounts/remounts that
   * leaf's `EditorPanel`, so its `EditorView`s survive.
   */
  let {
    tree,
    activePaneId,
    onFocus,
    onSplit,
    onSetActiveTab,
    onCloseTab,
    onResizeSplit,
  }: {
    tree: EditorPaneNode;
    activePaneId: string;
    onFocus: (paneId: string) => void;
    onSplit: (paneId: string, direction: SplitDirection) => void;
    onSetActiveTab: (paneId: string, path: string) => void;
    onCloseTab: (paneId: string, path: string) => void;
    onResizeSplit: (splitId: string, index: number, delta: number, containerSizePx: number) => void;
  } = $props();

  let rootEl: HTMLDivElement | undefined = $state();

  let rects = $derived(computeRects(tree, { top: 0, left: 0, width: 100, height: 100 }));
  let leaves = $derived(listLeaves(tree));
  let resizers = $derived(computeResizers(tree, rects));

  // Pane sizes are stored as ratios (see paneTree.ts), so a divider drag
  // converts its pixel delta to a ratio against its own split's container
  // size at drag start — the same approach the terminal's PaneSplit.svelte
  // already uses. There's only one real container element (`rootEl`); a
  // given split's own local pixel size is derived by scaling `rootEl`'s size
  // down by that split's rectangle fraction.
  function startDragResizer(event: PointerEvent, rz: ResizerRect): void {
    event.preventDefault();
    const splitRect = rects.get(rz.splitId);
    const rootSizePx = rz.orientation === "row" ? (rootEl?.clientWidth ?? 0) : (rootEl?.clientHeight ?? 0);
    const fraction = rz.orientation === "row" ? (splitRect?.width ?? 100) : (splitRect?.height ?? 100);
    const containerSizePx = rootSizePx * (fraction / 100);
    let last = rz.orientation === "row" ? event.clientX : event.clientY;

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

<div class="pane-split-root" bind:this={rootEl} style={`font-size: ${$zoom * 100}%`}>
  {#each leaves as leaf (leaf.id)}
    {@const r = rects.get(leaf.id)!}
    <div
      class="pane-leaf"
      class:active={leaf.id === activePaneId}
      style={`top: ${r.top}%; left: ${r.left}%; width: ${r.width}%; height: ${r.height}%`}
      onfocusin={() => onFocus(leaf.id)}
    >
      <div class="pane-body">
        <EditorPanel
          tree={leaf}
          onSplit={(direction) => onSplit(leaf.id, direction)}
          onSetActiveTab={(path) => onSetActiveTab(leaf.id, path)}
          onCloseTab={(path) => onCloseTab(leaf.id, path)}
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
    >
      <div class="pane-resizer-line"></div>
    </div>
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

  .pane-resizer-line {
    position: absolute;
    background: var(--atrium-border);
  }

  .pane-resizer.vertical .pane-resizer-line {
    left: 50%;
    top: 0;
    bottom: 0;
    width: 1px;
    transform: translateX(-50%);
  }

  .pane-resizer.horizontal .pane-resizer-line {
    top: 50%;
    left: 0;
    right: 0;
    height: 1px;
    transform: translateY(-50%);
  }

  .pane-resizer:hover .pane-resizer-line,
  .pane-resizer:active .pane-resizer-line {
    background: var(--atrium-accent);
  }
</style>
