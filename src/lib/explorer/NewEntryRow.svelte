<script lang="ts">
  import ExplorerIcon from "./icons/ExplorerIcon.svelte";
  import InlineNameInput from "./InlineNameInput.svelte";

  let {
    depth,
    isDir,
    onCommit,
    onCancel,
  }: {
    depth: number;
    isDir: boolean;
    onCommit: (value: string) => Promise<void>;
    onCancel: () => void;
  } = $props();
</script>

<div class="row" style={`padding-left: ${depth * 14 + 6}px`}>
  <ExplorerIcon entry={{ name: "", path: "", isDir, isSymlink: false }} expanded={false} />
  <InlineNameInput initialValue="" selectExtension={false} {onCommit} {onCancel} />
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-top: 2px;
    padding-bottom: 2px;
    white-space: nowrap;
  }
</style>
