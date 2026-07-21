<script lang="ts">
  import ContextMenu from "../../src/lib/ui/ContextMenu.svelte";

  let { x, y }: { x: number; y: number } = $props();
</script>

<ContextMenu {x} {y}>
  <button role="menuitem">Item</button>
</ContextMenu>
