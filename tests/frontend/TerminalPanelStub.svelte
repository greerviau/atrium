<script lang="ts">
  import type { LeafPane, SplitDirection } from "../../src/lib/terminal/paneTree";

  let {
    tree,
  }: {
    tree: LeafPane;
    hasSplits: boolean;
    workspaceId: string;
    onSplit: (direction: SplitDirection) => void;
    onClosePanel: () => void;
    onNewTab: () => void;
    onCloseTab: (sessionId: string) => void;
    onSetActiveTab: (sessionId: string) => void;
    onTitleChange: (sessionId: string, title: string) => void;
  } = $props();
</script>

<div class="terminal-panel-stub" data-pane-id={tree.id}></div>
