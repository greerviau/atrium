<script lang="ts">
  import { tick } from "svelte";
  import { SETTINGS_TABPANEL_ID, settingsTabId, type SettingsCategory, type SettingsCategoryId } from "./settingsRegistry";

  let {
    categories,
    selected,
    onSelect,
  }: {
    categories: SettingsCategory[];
    selected: SettingsCategoryId;
    onSelect: (id: SettingsCategoryId) => void;
  } = $props();

  let tablistEl: HTMLDivElement | undefined = $state();

  // WAI-ARIA APG Tabs pattern, automatic activation: arrow keys both move
  // focus and switch the active category immediately, matching how a click
  // already switches category in one action.
  async function onTablistKeydown(event: KeyboardEvent): Promise<void> {
    const currentIndex = categories.findIndex((category) => category.id === selected);
    // Transient: e.g. a search narrowing `categories` before `SettingsDialog`
    // reassigns `selectedCategory` to one still in the list.
    if (currentIndex === -1) return;

    let nextIndex: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % categories.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + categories.length) % categories.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = categories.length - 1;
    } else {
      return;
    }

    // Both `.settings-sidebar` and `.settings-content` scroll, so these keys
    // would otherwise scroll the panel in addition to moving the active tab.
    event.preventDefault();
    const next = categories[nextIndex];
    onSelect(next.id);
    await tick();
    tablistEl?.querySelector<HTMLButtonElement>(`#${settingsTabId(next.id)}`)?.focus();
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  class="settings-sidebar"
  bind:this={tablistEl}
  role="tablist"
  aria-label="Settings categories"
  onkeydown={onTablistKeydown}
>
  {#each categories as category (category.id)}
    <button
      class="settings-sidebar-item"
      class:active={category.id === selected}
      id={settingsTabId(category.id)}
      role="tab"
      aria-selected={category.id === selected}
      aria-controls={SETTINGS_TABPANEL_ID}
      tabindex={category.id === selected ? 0 : -1}
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
