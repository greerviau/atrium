<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { LeafPane, SplitDirection } from "../../src/lib/terminal/paneTree";
  import { mountLog } from "./mountLog";

  let {
    tree,
  }: {
    tree: LeafPane;
    workspaceId: string;
    onSplit: (direction: SplitDirection) => void;
    onNewTab: () => void;
    onCloseTab: (sessionId: string) => void;
    onSetActiveTab: (sessionId: string) => void;
    onTitleChange: (sessionId: string, title: string) => void;
  } = $props();

  onMount(() => mountLog.push(`mount:${tree.id}`));
  onDestroy(() => mountLog.push(`destroy:${tree.id}`));
</script>

<div class="terminal-panel-stub" data-pane-id={tree.id}></div>
