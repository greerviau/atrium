<script lang="ts">
  import { activeTabDrag } from "./tabDrag";
</script>

{#if $activeTabDrag}
  <div
    class="tab-drag-preview"
    style={`left: ${$activeTabDrag.clientX + 12}px; top: ${$activeTabDrag.clientY + 12}px`}
    aria-hidden="true"
  >
    <span class="surface-mark">{$activeTabDrag.surface === "terminal" ? ">_" : ""}</span>
    <span class="tab-name">{$activeTabDrag.label}</span>
  </div>
{/if}

<style>
  .tab-drag-preview {
    position: fixed;
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 240px;
    padding: 6px 10px;
    border: 1px solid var(--atrium-accent);
    border-radius: 4px;
    background: var(--atrium-bg-active);
    color: inherit;
    box-shadow: 0 5px 16px rgb(0 0 0 / 28%);
    pointer-events: none;
    opacity: 0.95;
    white-space: nowrap;
  }

  .surface-mark {
    min-width: 14px;
    color: var(--atrium-accent);
    font-size: 0.85em;
  }

  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
