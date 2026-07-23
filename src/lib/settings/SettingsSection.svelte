<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    expanded,
    onToggle,
    children,
  }: {
    title: string;
    expanded: boolean;
    onToggle: () => void;
    children: Snippet;
  } = $props();
</script>

<section class="settings-section">
  <button class="settings-section-header" onclick={onToggle} aria-expanded={expanded}>
    <span class="settings-section-chevron" class:expanded aria-hidden="true">▸</span>
    <h3 class="settings-section-title">{title}</h3>
  </button>
  {#if expanded}
    <div class="settings-section-body">
      {@render children()}
    </div>
  {/if}
</section>

<style>
  .settings-section {
    margin-bottom: 4px;
  }
  .settings-section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 8px 4px;
    text-align: left;
  }
  .settings-section-header:hover {
    background: var(--atrium-bg-hover);
    border-radius: 6px;
  }
  .settings-section-chevron {
    display: inline-flex;
    font-size: 0.75em;
    color: var(--atrium-text-muted);
    transition: transform 0.1s ease;
  }
  .settings-section-chevron.expanded {
    transform: rotate(90deg);
  }
  .settings-section-title {
    margin: 0;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--atrium-text-muted);
  }
  .settings-section-body {
    padding: 4px 4px 16px;
  }
</style>
