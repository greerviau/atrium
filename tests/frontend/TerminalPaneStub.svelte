<script lang="ts">
  let {
    cwd,
    workspaceId,
  }: { cwd: string; workspaceId: string; onExit?: () => void; onTitleChange?: (title: string) => void } = $props();
</script>

<div class="terminal-pane-stub" data-cwd={cwd} data-workspace-id={workspaceId}></div>
