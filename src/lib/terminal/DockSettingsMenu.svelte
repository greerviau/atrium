<script lang="ts">
  import ContextMenu from "../ui/ContextMenu.svelte";
  import { terminalPosition, setTerminalPosition, type TerminalPosition } from "../stores/layout";

  /**
   * The terminal dock's settings gear: the only control for dock position
   * (bottom/left/right) that lives inside the terminal panel itself, since
   * that's dock-wide state rather than something that belongs on every
   * individual panel. Reads/writes the shared `terminalPosition` store
   * directly (same store the settings dialog uses), so the two controls can
   * never drift. Manages its own open/closed state and its own
   * outside-click listener, the same self-contained pattern `SplitMenu`
   * uses.
   */
  let open = $state(false);
  let rootEl: HTMLDivElement | undefined = $state();
  let buttonEl: HTMLButtonElement | undefined = $state();

  function choose(next: TerminalPosition): void {
    setTerminalPosition(next);
    open = false;
  }

  function onWindowClick(event: MouseEvent): void {
    if (!open) return;
    if (rootEl && event.target instanceof Node && rootEl.contains(event.target)) return;
    open = false;
  }
</script>

{#snippet gearIcon()}
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
    <circle cx="8" cy="8" r="2.3" />
    <path
      d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"
      stroke-linecap="round"
    />
  </svg>
{/snippet}

<svelte:window onclick={onWindowClick} />

<div class="dock-settings-menu" bind:this={rootEl}>
  <button
    class="dock-btn"
    bind:this={buttonEl}
    onclick={() => (open = !open)}
    aria-label="Terminal settings"
    aria-haspopup="true"
    aria-expanded={open}
    title="Terminal settings"
  >
    {@render gearIcon()}
  </button>
  {#if open}
    <ContextMenu anchorEl={buttonEl}>
      <button role="menuitemradio" aria-checked={$terminalPosition === "bottom"} onclick={() => choose("bottom")}>
        Dock Bottom
      </button>
      <button role="menuitemradio" aria-checked={$terminalPosition === "left"} onclick={() => choose("left")}>Dock Left</button>
      <button role="menuitemradio" aria-checked={$terminalPosition === "right"} onclick={() => choose("right")}>
        Dock Right
      </button>
    </ContextMenu>
  {/if}
</div>

<style>
  .dock-settings-menu {
    display: flex;
    align-items: center;
  }

  .dock-btn {
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

  .dock-btn:hover {
    opacity: 1;
  }
</style>
