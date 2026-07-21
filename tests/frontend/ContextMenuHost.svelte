<script lang="ts">
  import ContextMenu from "../../src/lib/ui/ContextMenu.svelte";

  let { x, y, itemCount = 1 }: { x: number; y: number; itemCount?: number } = $props();
  const items = $derived(Array.from({ length: itemCount }, (_, i) => i));
</script>

<ContextMenu {x} {y}>
  {#each items as i (i)}
    <button role="menuitem">Item {i}</button>
  {/each}
</ContextMenu>
