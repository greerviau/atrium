<script lang="ts">
  import ContextMenu from "../ui/ContextMenu.svelte";
  import type { SplitDirection } from "./paneTree";

  /**
   * A single split button whose dropdown offers all four split directions.
   * Manages its own open/closed state and its own outside-click listener
   * (scoped to this instance's own root element) rather than a shared store,
   * since there can be many of these mounted at once — one per panel.
   */
  let { onSplit }: { onSplit: (direction: SplitDirection) => void } = $props();

  let open = $state(false);
  let rootEl: HTMLDivElement | undefined = $state();
  let buttonEl: HTMLButtonElement | undefined = $state();

  function choose(direction: SplitDirection): void {
    onSplit(direction);
    open = false;
  }

  function onWindowClick(event: MouseEvent): void {
    if (!open) return;
    if (rootEl && event.target instanceof Node && rootEl.contains(event.target)) return;
    open = false;
  }
</script>

{#snippet splitIcon()}
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
    <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
    <line x1="8" y1="1.5" x2="8" y2="14.5" />
    <line x1="1.5" y1="8" x2="14.5" y2="8" />
  </svg>
{/snippet}

<svelte:window onclick={onWindowClick} />

<div class="split-menu" bind:this={rootEl}>
  <button
    class="tab-strip-btn"
    bind:this={buttonEl}
    onclick={() => (open = !open)}
    aria-label="Split terminal"
    aria-haspopup="true"
    aria-expanded={open}
    title="Split terminal"
  >
    {@render splitIcon()}
  </button>
  {#if open}
    <ContextMenu anchorEl={buttonEl}>
      <button role="menuitem" onclick={() => choose("up")}>Split Up</button>
      <button role="menuitem" onclick={() => choose("down")}>Split Down</button>
      <button role="menuitem" onclick={() => choose("left")}>Split Left</button>
      <button role="menuitem" onclick={() => choose("right")}>Split Right</button>
    </ContextMenu>
  {/if}
</div>

<style>
  .split-menu {
    display: flex;
    align-items: center;
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
</style>
