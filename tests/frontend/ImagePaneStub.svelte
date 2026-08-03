<script lang="ts">
  let { filePath, workspaceId }: { filePath: string; workspaceId: string } = $props();
</script>

<div class="image-pane-stub" data-file-path={filePath} data-workspace-id={workspaceId}></div>
