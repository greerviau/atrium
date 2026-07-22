<script lang="ts">
  import ContextMenu from "../../src/lib/ui/ContextMenu.svelte";

  let { open = true }: { open?: boolean } = $props();
  let buttonEl: HTMLButtonElement | undefined = $state();
</script>

<button bind:this={buttonEl}>anchor</button>
{#if open}
  <ContextMenu anchorEl={buttonEl}>
    <button role="menuitem">Item</button>
  </ContextMenu>
{/if}
