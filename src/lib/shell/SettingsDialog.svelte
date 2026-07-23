<script lang="ts">
  import { onDestroy } from "svelte";
  import { settingsOverlay, closeSettings } from "../stores/settingsOverlay";
  import { themes } from "../theme/tokens";
  import { themeSelection, setTheme } from "../stores/theme";
  import { terminalPosition, setTerminalPosition, type TerminalPosition } from "../stores/layout";
  import { zoom, zoomIn, zoomOut, resetZoom, MIN_ZOOM, MAX_ZOOM } from "../stores/textSize";
  import { clearRecents } from "../stores/recents";
  import { isAppError } from "../ipc/commands";
  import SettingsSidebar from "../settings/SettingsSidebar.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import {
    SETTINGS_CATEGORIES,
    SETTINGS_SECTIONS,
    sectionMatchesQuery,
    type SettingsCategoryId,
  } from "../settings/settingsRegistry";

  const DOCK_POSITIONS: { id: TerminalPosition; label: string }[] = [
    { id: "bottom", label: "Bottom" },
    { id: "left", label: "Left" },
    { id: "right", label: "Right" },
  ];

  const CLEARED_BADGE_MS = 3000;
  const DEFAULT_CATEGORY: SettingsCategoryId = "general";

  let panelEl: HTMLDivElement | undefined = $state();
  let clearingRecents = $state(false);
  let clearRecentsError = $state<string | null>(null);
  let recentsCleared = $state(false);
  let recentsClearedTimer: ReturnType<typeof setTimeout> | undefined;

  // Sidebar selection, search query, and each section's collapsed/expanded
  // state are all transient UI state that resets to defaults every time the
  // dialog opens rather than persisting — see `resetState` below, mirrored
  // by every other Atrium overlay (e.g. `SearchOverlay`) resetting its own
  // transient state the same way.
  let selectedCategory = $state<SettingsCategoryId>(DEFAULT_CATEGORY);
  let searchQuery = $state("");
  let expandedSections = $state<Record<string, boolean>>({});

  function describeError(err: unknown): string {
    if (isAppError(err)) return err.message;
    if (err instanceof Error) return err.message;
    return "an unknown error";
  }

  function resetState(): void {
    clearRecentsError = null;
    recentsCleared = false;
    clearTimeout(recentsClearedTimer);
    selectedCategory = DEFAULT_CATEGORY;
    searchQuery = "";
    expandedSections = Object.fromEntries(SETTINGS_SECTIONS.map((section) => [section.id, true]));
  }

  // Same focus-move technique as UnsavedChangesDialog: without moving real
  // keyboard focus into the panel, a genuine Escape keypress stays on
  // whatever was focused before the dialog opened and never reaches the
  // backdrop's keydown handler below.
  $effect(() => {
    if ($settingsOverlay.open) {
      resetState();
      panelEl?.focus();
    }
  });

  let normalizedQuery = $derived(searchQuery.trim().toLowerCase());
  let searching = $derived(normalizedQuery !== "");
  let matchingSectionIds = $derived(
    new Set(SETTINGS_SECTIONS.filter((section) => sectionMatchesQuery(section, normalizedQuery)).map((s) => s.id)),
  );
  let visibleCategories = $derived(
    searching
      ? SETTINGS_CATEGORIES.filter((category) =>
          SETTINGS_SECTIONS.some((section) => section.categoryId === category.id && matchingSectionIds.has(section.id)),
        )
      : SETTINGS_CATEGORIES,
  );
  let currentCategoryLabel = $derived(
    SETTINGS_CATEGORIES.find((category) => category.id === selectedCategory)?.label ?? "",
  );

  // While searching, if the currently-selected category no longer has a
  // matching section, jump to the first category that does — mirroring how
  // the sidebar itself hides non-matching categories, so the content pane
  // never sits on an empty, hidden-from-the-sidebar category.
  $effect(() => {
    if (!searching) return;
    const currentHasMatch = SETTINGS_SECTIONS.some(
      (section) => section.categoryId === selectedCategory && matchingSectionIds.has(section.id),
    );
    if (currentHasMatch) return;
    const firstMatch = SETTINGS_CATEGORIES.find((category) =>
      SETTINGS_SECTIONS.some((section) => section.categoryId === category.id && matchingSectionIds.has(section.id)),
    );
    if (firstMatch) selectedCategory = firstMatch.id;
  });

  function isSectionVisible(id: string): boolean {
    return !searching || matchingSectionIds.has(id);
  }

  // A matched section that's collapsed auto-expands while a query is
  // active, so the match is actually visible rather than hidden behind its
  // own disclosure. This only affects the *displayed* state, not the
  // stored `expandedSections` value, so clearing the query restores
  // whatever the user had explicitly set.
  function isSectionExpanded(id: string): boolean {
    return (expandedSections[id] ?? true) || (searching && matchingSectionIds.has(id));
  }

  function toggleSection(id: string): void {
    expandedSections[id] = !(expandedSections[id] ?? true);
  }

  async function clearRecentProjects(): Promise<void> {
    clearingRecents = true;
    clearRecentsError = null;
    try {
      await clearRecents();
      recentsCleared = true;
      clearTimeout(recentsClearedTimer);
      // Auto-hides the confirmation rather than leaving it up for the rest
      // of the dialog's session, where it could be mistaken as describing
      // the current state rather than a one-off event that already happened.
      recentsClearedTimer = setTimeout(() => {
        recentsCleared = false;
      }, CLEARED_BADGE_MS);
    } catch (err) {
      clearRecentsError = `Couldn't clear recent projects: ${describeError(err)}`;
    } finally {
      clearingRecents = false;
    }
  }

  onDestroy(() => clearTimeout(recentsClearedTimer));

  function onBackdropKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      closeSettings();
    }
  }

  const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

  // Standard `role="radiogroup"` keyboard behavior: arrow keys (and
  // Home/End) move focus among the `role="radio"` children and select
  // whichever one focus lands on, matching the roving `tabindex` below (only
  // the checked option is in the Tab order; arrow keys are how you reach the
  // rest). Reuses each button's own `onclick` — via a synthetic `.click()` —
  // rather than duplicating the theme/dock-position selection logic here.
  function onRadioGroupKeydown(event: KeyboardEvent): void {
    if (!ARROW_KEYS.has(event.key)) return;
    const container = event.currentTarget as HTMLElement;
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    if (options.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
    let nextIndex: number;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = options.length - 1;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % options.length;
    } else {
      nextIndex = (currentIndex - 1 + options.length) % options.length;
    }
    const next = options[nextIndex];
    next.focus();
    next.click();
  }
</script>

{#if $settingsOverlay.open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="settings-backdrop" onclick={closeSettings} onkeydown={onBackdropKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      bind:this={panelEl}
      class="settings-panel"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1"
    >
      <div class="settings-header">
        <h2 class="settings-title">Settings</h2>
        <input
          class="settings-search-input"
          type="text"
          bind:value={searchQuery}
          placeholder="Search settings…"
          aria-label="Search settings"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
        />
      </div>

      <div class="settings-body">
        <SettingsSidebar
          categories={visibleCategories}
          selected={selectedCategory}
          onSelect={(id) => (selectedCategory = id)}
        />

        <div class="settings-content" role="tabpanel" aria-label={currentCategoryLabel}>
          {#if selectedCategory === "general" && isSectionVisible("recent-projects")}
            <SettingsSection
              title="Recent Projects"
              expanded={isSectionExpanded("recent-projects")}
              onToggle={() => toggleSection("recent-projects")}
            >
              <div class="settings-row">
                <span class="settings-label">Recent projects</span>
                <div class="settings-clear-recents">
                  <button class="settings-btn" onclick={clearRecentProjects} disabled={clearingRecents}>
                    Clear Recent Projects
                  </button>
                  {#if recentsCleared}
                    <span class="settings-status">Cleared</span>
                  {/if}
                </div>
              </div>
              {#if clearRecentsError}
                <p class="settings-error">{clearRecentsError}</p>
              {/if}
            </SettingsSection>
          {/if}

          {#if selectedCategory === "appearance" && isSectionVisible("theme")}
            <SettingsSection title="Theme" expanded={isSectionExpanded("theme")} onToggle={() => toggleSection("theme")}>
              <div class="settings-row">
                <span class="settings-label">Theme</span>
                <!-- svelte-ignore a11y_interactive_supports_focus -->
                <div class="settings-options" role="radiogroup" aria-label="Theme" onkeydown={onRadioGroupKeydown}>
                  <button
                    class="settings-option"
                    role="radio"
                    aria-checked={$themeSelection === "auto"}
                    tabindex={$themeSelection === "auto" ? 0 : -1}
                    onclick={() => setTheme("auto")}
                  >
                    Auto
                  </button>
                  {#each themes as t (t.id)}
                    <button
                      class="settings-option"
                      role="radio"
                      aria-checked={$themeSelection === t.id}
                      tabindex={$themeSelection === t.id ? 0 : -1}
                      onclick={() => setTheme(t.id)}
                    >
                      {t.name}
                    </button>
                  {/each}
                </div>
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "editor" && isSectionVisible("zoom")}
            <SettingsSection title="Zoom" expanded={isSectionExpanded("zoom")} onToggle={() => toggleSection("zoom")}>
              <div class="settings-row">
                <span class="settings-label">Zoom</span>
                <div class="settings-zoom">
                  <button
                    class="settings-zoom-btn"
                    onclick={zoomOut}
                    disabled={$zoom <= MIN_ZOOM}
                    aria-label="Zoom out"
                  >
                    −
                  </button>
                  <span class="settings-zoom-value">{Math.round($zoom * 100)}%</span>
                  <button class="settings-zoom-btn" onclick={zoomIn} disabled={$zoom >= MAX_ZOOM} aria-label="Zoom in">
                    +
                  </button>
                  <button class="settings-btn" onclick={resetZoom}>Reset</button>
                </div>
              </div>
            </SettingsSection>
          {/if}

          {#if selectedCategory === "terminal" && isSectionVisible("dock-position")}
            <SettingsSection
              title="Dock Position"
              expanded={isSectionExpanded("dock-position")}
              onToggle={() => toggleSection("dock-position")}
            >
              <div class="settings-row">
                <span class="settings-label">Terminal dock position</span>
                <!-- svelte-ignore a11y_interactive_supports_focus -->
                <div
                  class="settings-options"
                  role="radiogroup"
                  aria-label="Terminal dock position"
                  onkeydown={onRadioGroupKeydown}
                >
                  {#each DOCK_POSITIONS as dock (dock.id)}
                    <button
                      class="settings-option"
                      role="radio"
                      aria-checked={$terminalPosition === dock.id}
                      tabindex={$terminalPosition === dock.id ? 0 : -1}
                      onclick={() => setTerminalPosition(dock.id)}
                    >
                      {dock.label}
                    </button>
                  {/each}
                </div>
              </div>
            </SettingsSection>
          {/if}

          {#if searching && matchingSectionIds.size === 0}
            <p class="settings-empty">No settings match your search.</p>
          {/if}
        </div>
      </div>

      <div class="settings-actions">
        <button class="settings-btn primary" onclick={closeSettings}>Done</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .settings-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 4000;
  }
  .settings-panel {
    background: var(--atrium-bg-elevated);
    border: 1px solid var(--atrium-border);
    border-radius: 8px;
    width: 680px;
    max-width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    color: var(--atrium-text-primary);
  }
  .settings-header {
    flex-shrink: 0;
    padding: 20px 20px 12px;
  }
  .settings-title {
    margin: 0 0 12px;
    font-size: 1.1em;
  }
  .settings-search-input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    font: inherit;
    background: var(--atrium-bg-surface);
    color: inherit;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
  }
  .settings-search-input:focus {
    outline: none;
    border-color: var(--atrium-accent);
  }
  .settings-body {
    flex: 1;
    min-height: 0;
    display: flex;
    border-top: 1px solid var(--atrium-border);
  }
  .settings-content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 12px 20px;
  }
  .settings-empty {
    color: var(--atrium-text-muted);
    font-size: 0.9em;
    margin: 8px 4px;
  }
  .settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .settings-label {
    flex-shrink: 0;
  }
  .settings-options {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: flex-end;
  }
  .settings-option {
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    font-size: 0.9em;
    cursor: pointer;
    padding: 5px 10px;
  }
  .settings-option:hover {
    background: var(--atrium-bg-hover);
  }
  .settings-option[aria-checked="true"] {
    background: var(--atrium-bg-active);
    border-color: var(--atrium-accent);
    color: var(--atrium-accent);
  }
  .settings-zoom {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .settings-zoom-btn {
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    cursor: pointer;
    width: 28px;
    height: 28px;
    line-height: 1;
  }
  .settings-zoom-btn:hover {
    background: var(--atrium-bg-hover);
  }
  .settings-zoom-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .settings-zoom-value {
    min-width: 3.5em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .settings-clear-recents {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .settings-status {
    color: var(--atrium-text-muted);
    font-size: 0.85em;
  }
  .settings-error {
    margin: 8px 0 0;
    color: var(--atrium-danger);
    font-size: 0.9em;
  }
  .settings-actions {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    padding: 12px 20px 20px;
  }
  .settings-btn {
    background: none;
    border: 1px solid var(--atrium-border);
    border-radius: 6px;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 7px 14px;
  }
  .settings-btn:hover {
    background: var(--atrium-bg-hover);
  }
  .settings-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .settings-btn.primary {
    background: var(--atrium-accent);
    border-color: var(--atrium-accent);
    color: var(--atrium-text-inverse);
  }
</style>
