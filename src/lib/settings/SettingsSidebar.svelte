<script lang="ts">
  import type { SettingsCategory, SettingsCategoryId } from "./settingsRegistry";

  let {
    categories,
    selected,
    onSelect,
  }: {
    categories: SettingsCategory[];
    selected: SettingsCategoryId;
    onSelect: (id: SettingsCategoryId) => void;
  } = $props();
</script>

<div class="settings-sidebar" role="tablist" aria-label="Settings categories">
  {#each categories as category (category.id)}
    <button
      class="settings-sidebar-item"
      class:active={category.id === selected}
      role="tab"
      aria-selected={category.id === selected}
      onclick={() => onSelect(category.id)}
    >
      {category.label}
    </button>
  {/each}
</div>

<style>
  .settings-sidebar {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 160px;
    flex-shrink: 0;
    padding: 12px 8px;
    border-right: 1px solid var(--atrium-border);
    overflow-y: auto;
  }
  .settings-sidebar-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 6px;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 7px 10px;
  }
  .settings-sidebar-item:hover {
    background: var(--atrium-bg-hover);
  }
  .settings-sidebar-item.active {
    background: var(--atrium-bg-active);
    color: var(--atrium-accent);
  }
</style>
