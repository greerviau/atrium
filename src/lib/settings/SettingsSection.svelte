<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    id,
    children,
  }: {
    title: string;
    id: string;
    children: Snippet;
  } = $props();
</script>

<section class="settings-section" {id}>
  <h3 class="settings-section-title">{title}</h3>
  <div class="settings-section-body">
    {@render children()}
  </div>
</section>

<style>
  .settings-section {
    margin-bottom: 4px;
  }
  .settings-section-title {
    margin: 0;
    padding: 8px 4px 0;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--atrium-text-muted);
  }
  .settings-section-body {
    padding: 4px 4px 16px;
  }
</style>
