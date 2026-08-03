<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import { onFsChanged } from "../ipc/events";
  import { basename } from "../util/path";

  let { filePath, workspaceId }: { filePath: string; workspaceId: string } = $props();

  let revision = $state(0);
  let loadFailed = $state(false);
  const source = $derived(`${convertFileSrc(filePath, "atriumasset")}?revision=${revision}`);

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onFsChanged((event) => {
      if (event.workspaceId === workspaceId && event.path === filePath && event.kind !== "remove") {
        loadFailed = false;
        revision += 1;
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  });
</script>

<div class="image-pane">
  <img
    class:hidden={loadFailed}
    src={source}
    alt={basename(filePath)}
    onload={() => loadFailed = false}
    onerror={() => loadFailed = true}
  />
  {#if loadFailed}
    <div class="image-error" role="alert">Couldn’t display {basename(filePath)}.</div>
  {/if}
</div>

<style>
  .image-pane {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 24px;
    background: var(--atrium-bg-base);
  }

  img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  img.hidden {
    display: none;
  }

  .image-error {
    color: var(--atrium-text-muted);
  }
</style>
