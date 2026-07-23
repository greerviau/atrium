<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { EditorLeafPane, SplitDirection } from "../../src/lib/editor/editorPaneTree";
  import { mountLog } from "./mountLog";

  let {
    tree,
  }: {
    tree: EditorLeafPane;
    onSplit: (direction: SplitDirection) => void;
    onSetActiveTab: (path: string) => void;
    onCloseTab: (path: string) => void;
  } = $props();

  onMount(() => mountLog.push(`mount:${tree.id}`));
  onDestroy(() => mountLog.push(`destroy:${tree.id}`));
</script>

<div class="editor-panel-stub" data-pane-id={tree.id}></div>
