<script lang="ts">
  import { draggingEntry, dragPointerPosition } from "./explorerDrag";
  import ExplorerIcon from "./icons/ExplorerIcon.svelte";

  const OFFSET_X = 14;
  const OFFSET_Y = 12;
  const VIEWPORT_MARGIN = 8;

  let previewWidth = $state(0);
  let previewHeight = $state(0);

  // Clamps the offset-from-cursor position into [VIEWPORT_MARGIN, viewport
  // edge - measured size - VIEWPORT_MARGIN] on both axes, mirroring
  // tooltip.ts's positionTooltip. The inner Math.max on the upper bound
  // guards the degenerate case where the viewport is narrower/shorter than
  // the preview plus both margins, so the two clamps never cross and pin
  // the preview to VIEWPORT_MARGIN instead of producing a negative span.
  let clampedPosition = $derived.by(() => {
    const pos = $dragPointerPosition;
    if (!pos) return null;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - previewWidth - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - previewHeight - VIEWPORT_MARGIN);
    return {
      left: Math.min(Math.max(pos.x + OFFSET_X, VIEWPORT_MARGIN), maxLeft),
      top: Math.min(Math.max(pos.y + OFFSET_Y, VIEWPORT_MARGIN), maxTop),
    };
  });
</script>

{#if $draggingEntry && clampedPosition}
  <div
    class="drag-preview"
    aria-hidden="true"
    bind:clientWidth={previewWidth}
    bind:clientHeight={previewHeight}
    style={`transform: translate3d(${clampedPosition.left}px, ${clampedPosition.top}px, 0)`}
  >
    <ExplorerIcon entry={$draggingEntry} expanded={false} />
    <span class="name" class:symlink={$draggingEntry.isSymlink}>{$draggingEntry.name}</span>
  </div>
{/if}

<style>
  .drag-preview {
    position: fixed;
    left: 0;
    top: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    max-width: 260px;
    background: var(--atrium-bg-elevated);
    border: 1px solid var(--atrium-border);
    border-radius: 5px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    /* Same computed size as the row the item was picked up from: .file-tree
       sets font-size: 0.9em against the body default, and this element
       mounts at App.svelte's root against that same body default, so both
       resolve to the same pixel size. Not enforced by any shared token —
       if either side ever gets its own font-size, this drifts. */
    font-size: 0.9em;
    opacity: 0.92;
    pointer-events: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-user-drag: none;
    z-index: 1500;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.symlink {
    font-style: italic;
    opacity: 0.8;
  }
</style>
