<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { mountLog } from "./mountLog";

  let { filePath, paneId }: { filePath: string; paneId: string } = $props();

  onMount(() => mountLog.push(`mount:${paneId}:${filePath}`));
  onDestroy(() => mountLog.push(`destroy:${paneId}:${filePath}`));
</script>

<div class="editor-pane-stub" data-file-path={filePath} data-pane-id={paneId}></div>
