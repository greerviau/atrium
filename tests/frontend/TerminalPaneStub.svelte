<script module lang="ts">
  // Mutable default for simulateElapsedMs below, for tests that mount this
  // stub indirectly through the full App/TerminalPanel tree (which has no
  // prop of its own to thread simulateElapsedMs through) rather than
  // passing the prop directly. A prop-destructuring default expression is
  // evaluated once per component instantiation, so setting this before a
  // render picks it up for that render's session.
  export const DEFAULT_SIMULATE_ELAPSED_MS = 60_000;
  let defaultSimulateElapsedMs = DEFAULT_SIMULATE_ELAPSED_MS;
  export function setDefaultSimulateElapsedMs(value: number): void {
    defaultSimulateElapsedMs = value;
  }
</script>

<script lang="ts">
  let {
    cwd,
    workspaceId,
    onExit,
    simulateElapsedMs = defaultSimulateElapsedMs,
  }: {
    cwd: string;
    workspaceId: string;
    onExit?: (elapsedMs: number) => void;
    onTitleChange?: (title: string) => void;
    simulateElapsedMs?: number;
  } = $props();
</script>

<div class="terminal-pane-stub" data-cwd={cwd} data-workspace-id={workspaceId}>
  <button class="terminal-pane-stub-exit" onclick={() => onExit?.(simulateElapsedMs)}>simulate exit</button>
</div>
