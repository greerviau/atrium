<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * Shared floating menu surface. The anchor is either an explicit `(x, y)`
   * point (typically a right-click's coordinates) or, when `anchorEl` is
   * given instead, the bottom-left corner of that element's own bounding
   * rect (for a menu opened from a button rather than a click). Either way
   * the menu clamps itself to the viewport so it never renders past the
   * bottom or right edge, flipping upward/leftward off the anchor point
   * instead when there isn't room below/right of it.
   */
  type Props = { children: Snippet } & (
    | { x: number; y: number; anchorEl?: undefined }
    | { anchorEl: HTMLElement; x?: undefined; y?: undefined }
  );

  let { x, y, anchorEl, children }: Props = $props();

  let menuEl: HTMLDivElement | undefined = $state();
  let style = $state("");
  let positioned = $state(false);

  $effect(() => {
    if (!menuEl) return;
    const margin = 4;
    const rect = menuEl.getBoundingClientRect();

    let anchorX = x ?? 0;
    let anchorY = y ?? 0;
    if (anchorEl) {
      const anchorRect = anchorEl.getBoundingClientRect();
      anchorX = anchorRect.left;
      anchorY = anchorRect.bottom;
    }

    let left = anchorX;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, anchorX - rect.width);
    }

    let top = anchorY;
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, anchorY - rect.height);
    }

    style = `left: ${left}px; top: ${top}px`;
    positioned = true;
  });
</script>

<div bind:this={menuEl} class="context-menu" class:positioned style={style} role="menu">
  {@render children()}
</div>

<style>
  .context-menu {
    position: fixed;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    background: var(--atrium-bg-elevated);
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    padding: 4px;
    font-size: 13px;
    z-index: 1000;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    /* Hidden until the first position measurement lands, so the menu never
       flashes at the unclamped anchor point before snapping into place. */
    visibility: hidden;
  }
  .context-menu.positioned {
    visibility: visible;
  }
  .context-menu :global(button) {
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    padding: 6px 14px;
    cursor: pointer;
    border-radius: 4px;
    font: inherit;
    white-space: nowrap;
  }
  .context-menu :global(button:hover) {
    background: var(--atrium-bg-hover);
  }
  .context-menu :global(button:disabled) {
    opacity: 0.4;
    cursor: default;
  }
  .context-menu :global(button:disabled:hover) {
    background: none;
  }
  .context-menu :global(.menu-separator) {
    border-top: 1px solid var(--atrium-border);
    margin: 4px 0;
  }
</style>
