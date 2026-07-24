<script lang="ts">
  import ContextMenu from "../../src/lib/ui/ContextMenu.svelte";

  let { onClick }: { onClick: () => void } = $props();
</script>

<ContextMenu x={100} y={100}>
  <button role="menuitem" onclick={onClick}>New File<kbd class="shortcut-hint">⌘N</kbd></button>
  <button role="menuitem">No Shortcut</button>
</ContextMenu>
