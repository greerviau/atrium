<script lang="ts">
  import { onMount } from "svelte";
  import { mountLog } from "./mountLog";

  // Models a shell that exits right after being spawned (e.g. $SHELL
  // pointing at a binary that exits immediately, or an rc file that hits
  // exit) — every mount logs itself, then fires onExit on its own, one
  // microtask later so a cascade of these unfolds one respawn per tick
  // rather than recursing synchronously.
  let {
    cwd,
    workspaceId,
    onExit,
  }: { cwd: string; workspaceId: string; onExit?: () => void; onTitleChange?: (title: string) => void } = $props();

  onMount(() => {
    mountLog.push(`spawn:${cwd}`);
    queueMicrotask(() => onExit?.());
  });
</script>

<div class="terminal-pane-stub" data-cwd={cwd} data-workspace-id={workspaceId}></div>
