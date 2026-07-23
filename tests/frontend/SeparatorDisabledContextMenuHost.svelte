<script lang="ts">
  import ContextMenu from "../../src/lib/ui/ContextMenu.svelte";

  let { onClick }: { onClick: () => void } = $props();
</script>

<ContextMenu x={100} y={100}>
  <button role="menuitem" onclick={onClick}>Item 1</button>
  <div class="menu-separator" role="separator"></div>
  <button role="menuitem" disabled onclick={onClick}>Item 2</button>
</ContextMenu>
