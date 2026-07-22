<script lang="ts">
  let {
    cwd,
    workspaceId,
    onExit,
  }: { cwd: string; workspaceId: string; onExit?: () => void; onTitleChange?: (title: string) => void } = $props();
</script>

<div class="terminal-pane-stub" data-cwd={cwd} data-workspace-id={workspaceId}>
  <button class="terminal-pane-stub-exit" onclick={() => onExit?.()}>simulate exit</button>
</div>
